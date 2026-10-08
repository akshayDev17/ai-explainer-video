// Headless frame renderer + encoder. No npm dependencies.
//
//   node tools/render.mjs --shots 5,12,22,30,45,60,72,82,90   # quick visual QA
//   node tools/render.mjs                                     # full render + encode + mux
//   node tools/render.mjs --fps 24 --keep-frames             # options
//
// Pipeline: Chromium (CDP) -> PNG sequence -> ffmpeg H.264 -> mux narration.

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromiumBinOrExit } from './chromium.mjs';
import { requireNode, requireCmd } from './env.mjs';

requireNode();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- args ---------- */
const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? def : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};
const SHOTS = flag('shots');
const FPS = parseInt(flag('fps', '30'), 10);
const KEEP_FRAMES = !!flag('keep-frames', false);
const PORT = parseInt(flag('port', '9333'), 10);
const QUALITY = flag('crf', '18');
// Which scene file to render, and where stills go. Lets us render the hand-written
// scene and the DSL-driven scene through an identical pipeline for comparison.
const SCENE = String(flag("scene", "src/scene-diagram.html?scene=srp-split"));
const SHOT_DIR = String(flag('shot-dir', 'preview'));
const OUT_NAME = String(flag('name', 'video'));
const NARR = String(flag('narration', 'out/narration.wav'));
// "t0,t1" — render only this slice of the timeline, for per-segment assembly
const RANGE = flag('range');
const OUTDIR = String(flag('outdir', 'out'));
// the per-video work dir (timeline.js + scenes/ + manifest.json live here)
const WORK = String(flag('work', ''));

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- CDP client over Node's built-in WebSocket ---------- */
async function connect(port) {
  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {}
  }
  if (!target) throw new Error('Chromium did not expose a page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, m => m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result));
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  return { send, close: () => { try { ws.close(); } catch {} } };
}

/* ---------- main ---------- */
const BIN = chromiumBinOrExit('render');
const [sceneFile, sceneQuery] = SCENE.split('?');
let urlQuery = sceneQuery || '';
if (WORK) { const workUrl = pathToFileURL(resolve(WORK)).href; urlQuery = urlQuery ? urlQuery + '&work=' + encodeURIComponent(workUrl) : 'work=' + encodeURIComponent(workUrl); }
const sceneUrl = 'file://' + join(ROOT, sceneFile) + (urlQuery ? '?' + urlQuery : '');
console.log('[chromium]', BIN);

const proc = spawn(BIN, [
  '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--allow-file-access-from-files',
  '--disable-lcd-text', '--font-render-hinting=none',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1920,1080',
  sceneUrl,
], { stdio: 'ignore' });

let exitCode = 0;
try {
  const cdp = await connect(PORT);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

  // wait for the scene to finish building
  const meta = await (async () => {
    for (let i = 0; i < 80; i++) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.VIDEO_META || null)', returnByValue: true,
      });
      const v = r.result.value;
      if (v && v !== 'null') return JSON.parse(v);
      await sleep(150);
    }
    throw new Error('scene.html never exposed window.VIDEO_META');
  })();
  console.log(`[scene] ${meta.width}x${meta.height} @ ${meta.fps}fps, ${meta.total}s`);

  const shoot = async (t) => {
    await cdp.send('Runtime.evaluate', { expression: `window.renderAt(${t})`, returnByValue: true });
    const shot = await cdp.send('Page.captureScreenshot',
      { format: 'png', fromSurface: true, captureBeyondViewport: false });
    return Buffer.from(shot.data, 'base64');
  };

  /* ---- QA mode: a handful of stills ---- */
  if (SHOTS) {
    const dir = resolve(SHOT_DIR);
    mkdirSync(dir, { recursive: true });
    const times = String(SHOTS).split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
    for (const t of times) {
      const buf = await shoot(t);
      const p = join(dir, `t${String(t).padStart(6, '0')}.png`);
      writeFileSync(p, buf);
      console.log(`[shot] t=${t}s -> ${(buf.length/1024).toFixed(0)}KB`);
    }
    cdp.close();
  } else {
    /* ---- full render ---- */
    const dir = resolve('frames');
    mkdirSync(dir, { recursive: true });
    const slice = RANGE ? String(RANGE).split(',').map(Number) : [0, meta.total];
    const tStart = slice[0], tEnd = slice[1] == null ? meta.total : slice[1];
    const total = Math.max(1, Math.round((tEnd - tStart) * FPS));
    console.log(`[render] ${total} frames @ ${FPS}fps  (t ${tStart}s -> ${tEnd}s)`);
    const t0 = Date.now();
    for (let i = 0; i < total; i++) {
      const t = tStart + i / FPS;
      const buf = await shoot(t);
      writeFileSync(join(dir, `frame_${String(i).padStart(5, '0')}.png`), buf);
      if (i % 120 === 0 || i === total - 1) {
        const el = (Date.now() - t0) / 1000;
        const rate = (i + 1) / Math.max(el, 0.001);
        const eta = (total - i - 1) / Math.max(rate, 0.001);
        process.stdout.write(`\r[render] ${i+1}/${total}  ${rate.toFixed(1)} fps  eta ${eta.toFixed(0)}s   `);
      }
    }
    process.stdout.write('\n');
    cdp.close();

    /* ---- encode ---- */
    requireCmd('ffmpeg');
    const outDir = resolve(OUTDIR);   // cwd-relative, so an absolute --outdir is honoured
    mkdirSync(outDir, { recursive: true });
    const silent = join(outDir, 'video-silent.mp4');
    console.log('[ffmpeg] encoding H.264…');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', String(FPS),
      '-i', join(dir, 'frame_%05d.png'),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', String(QUALITY),
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', silent], { stdio: 'inherit' });

    /* ---- mux narration ---- */
    const narr = resolve(NARR);
    const final = join(outDir, OUT_NAME + '.mp4');
    if (existsSync(narr)) {
      console.log('[ffmpeg] muxing narration…');
      // apad + -shortest: silence extends the audio, then -shortest cuts at the
      // VIDEO. Plain -shortest would instead truncate a 52s scene to 45s of audio.
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', silent, '-i', narr,
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-af', 'apad', '-shortest',
        '-movflags', '+faststart', final], { stdio: 'inherit' });
      rmSync(silent, { force: true });
      console.log('[done]', final);
    } else {
      // silent cut (e.g. a review pass before audio exists) — still ship the named output
      rmSync(final, { force: true });
      renameSync(silent, final);
      console.log('[done]', final, '(silent — no narration.wav found)');
    }

    // Frames are worthless once the MP4 is muxed: fully deterministic, free to
    // regenerate (~6 min CPU, no API calls), and invalidated by any change to the
    // narration timing anyway. The scarce artefact is narration/, not frames.
    if (!KEEP_FRAMES) {
      rmSync(dir, { recursive: true, force: true });
      console.log('[clean] frames removed (use --keep-frames to retain)');
    }
  }
} catch (err) {
  console.error('\n[error]', err.message);
  exitCode = 1;
} finally {
  proc.kill();
}

process.exit(exitCode);
