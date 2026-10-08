#!/usr/bin/env node
/* =============================================================================
   assemble.mjs — render every segment of a script and concatenate them.

   Each segment owns a contiguous WINDOW of the finished video (emitted by the
   audio stage). So assembly is:

     for each segment:
        render its window slice through its own host + config   -> SILENT part
     concatenate the parts                                       -> full video
     mux the single measured narration track                     -> final
     verify the mux tracks the narration                         -> guard

   Parts are rendered silent on purpose. Muxing narration onto each part would
   restart the whole track at every segment boundary — which is exactly the bug
   this file used to have.

   Usage:
     node tools/assemble.mjs --script out/<name>/scripts/NN-<slug>.json \
                             --work out/<name>/<NN> --name <output>
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireCmd } from './env.mjs';

requireCmd('ffmpeg');
requireCmd('ffprobe');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};

const SCRIPT = flag('script');
const WORK = String(flag('work', 'out/video'));
const NAME = String(flag('name', 'video'));
const FPS = String(flag('fps', '30'));
const ONLY = flag('only', null);
const KEEP = !!flag('keep-parts', false);
const TOLERANCE = parseFloat(flag('audio-tolerance', '1.5'));   // dB
const DEST = flag('dest', null);   // where to copy the finished mp4 (never committed)

if (!SCRIPT || !existsSync(SCRIPT)) {
  console.error('usage: node tools/assemble.mjs --script <script.json> --work <dir> --name <output>');
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const ffprobeDur = f =>
  parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

const script = JSON.parse(readFileSync(SCRIPT, 'utf8'));
/* Per-video manifest: <work>/manifest.json. Falls back to the legacy global path so
   a work dir that hasn't been migrated yet still assembles. */
const manifestPath = existsSync(join(WORK, 'manifest.json'))
  ? join(WORK, 'manifest.json')
  : join(ROOT, 'scenes', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const timelinePath = join(WORK, 'timeline.json');
if (!existsSync(timelinePath)) {
  console.error(`no timeline at ${timelinePath} — run tools/build-audio.mjs first`);
  process.exit(1);
}
const tl = JSON.parse(readFileSync(timelinePath, 'utf8'));
const windows = tl.windows || {};
const narration = join(WORK, 'narration.wav');

/* ---------------- pre-flight: nothing missing, windows must tile ---------------- */
const errors = [];
script.segments.forEach(sg => {
  if (!windows[sg.key]) errors.push(`segment "${sg.key}" has no window in the timeline`);
  if (!manifest.segments[sg.key]) errors.push(`segment "${sg.key}" has no entry in manifest.json`);
});
let cursor = 0;
for (const sg of script.segments) {
  const w = windows[sg.key];
  if (!w) continue;
  if (Math.abs(w.start - cursor) > 0.01) errors.push(`window gap/overlap at "${sg.key}": expected ${cursor.toFixed(2)}, got ${w.start}`);
  cursor = w.end;
}
if (Math.abs(cursor - tl.total) > 0.05) errors.push(`windows end at ${cursor.toFixed(2)} but the timeline is ${tl.total}s`);
if (errors.length) {
  console.error('\n[assemble] cannot proceed:');
  errors.forEach(e => console.error('  ✗ ' + e));
  process.exit(1);
}

const order = script.segments.map(s => s.key).filter(k => !ONLY || k === ONLY);
const partDir = resolve(WORK, 'parts');
mkdirSync(partDir, { recursive: true });

console.log(`[assemble] ${order.length} segment(s) · timeline ${tl.total}s · narration ${existsSync(narration) ? 'present' : 'MISSING'}\n`);

/* ---------------- render each window, SILENT ---------------- */
for (const key of order) {
  const w = windows[key];
  const m = manifest.segments[key];
  const host = manifest.hosts[m.host];
  if (!host) { console.error(`unknown host "${m.host}" for ${key}`); process.exit(1); }
  console.log(`▶ ${key.padEnd(7)} ${String(w.dur).padStart(6)}s  (t ${w.start} → ${w.end})  ${m.host}/${m.scene}`);
  run('node', [join(ROOT, 'tools', 'render.mjs'),
    '--scene', `${host}?scene=${m.scene}`,
    '--work', WORK,
    '--range', `${w.start},${w.end}`,
    '--name', `part-${key}`,
    '--outdir', join(WORK, 'parts'),
    '--fps', FPS,
  ]);
}

/* ---------------- concatenate (identical codec/size/fps -> stream copy) ---------------- */
const parts = order.map(k => join(partDir, `part-${k}.mp4`)).filter(existsSync);
if (parts.length !== order.length) {
  console.error(`\n[assemble] expected ${order.length} parts, found ${parts.length}`);
  process.exit(1);
}
const listFile = join(partDir, 'concat.txt');
writeFileSync(listFile, parts.map(p => `file '${resolve(p)}'`).join('\n') + '\n');

const outDir = resolve(WORK);
const silent = join(outDir, `${NAME}-silent.mp4`);
const final = join(outDir, `${NAME}.mp4`);

console.log('\n[assemble] concatenating…');
run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', silent]);

/* ---------------- mux the narration ONCE ---------------- */
if (existsSync(narration)) {
  console.log('[assemble] muxing narration (once)…');
  run('ffmpeg', ['-y', '-v', 'error', '-i', silent, '-i', narration,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-af', 'apad', '-shortest',
    '-movflags', '+faststart', final]);
  rmSync(silent, { force: true });
} else {
  console.log('[assemble] no narration.wav — leaving a silent cut');
  rmSync(final, { force: true });
  execFileSync('mv', [silent, final]);
}

/* ---------------- VERIFY: audio must match the narration sample-for-sample ----------------
   RMS was too weak a test: speech sits at a roughly constant level, so a part
   playing the WRONG slice can still look right. verify-audio.mjs compares the
   residual energy after subtraction, which separates "same audio" (near 0) from
   "different audio" (~1.4) unambiguously. */
let verdict = 'skipped (no narration)';
if (existsSync(narration)) {
  console.log('\n[verify] finished audio vs narration track…');
  try {
    const out = execFileSync('node', [join(ROOT, 'tools', 'verify-audio.mjs'),
      '--video', final, '--narration', narration], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    process.stdout.write(out);
    verdict = 'ok';
  } catch (e) {
    process.stdout.write(String(e.stdout || ''));
    process.stderr.write(String(e.stderr || ''));
    console.error('  ✗ a part is playing the wrong slice of narration (double mux?)');
    process.exit(2);
  }
}

/* ---------------- report ---------------- */
const dur = ffprobeDur(final);
console.log(`\n[done] ${final}`);
console.log(`       ${parts.length} segments · ${dur.toFixed(2)}s · ${(dur / 60).toFixed(2)} min · audio ${verdict}`);

/* ---------------- deliver: the mp4 is the only thing the user keeps ---------
   Copy it to a destination they own; the work dir stays scratch and disposable. */
if (DEST) {
  mkdirSync(DEST, { recursive: true });
  const destPath = join(DEST, NAME + '.mp4');
  copyFileSync(final, destPath);
  console.log(`[dest] ${destPath}`);
}

if (!KEEP) {
  for (const f of readdirSync(partDir)) rmSync(join(partDir, f), { force: true });
  console.log('[clean] parts removed (use --keep-parts to retain)');
}
