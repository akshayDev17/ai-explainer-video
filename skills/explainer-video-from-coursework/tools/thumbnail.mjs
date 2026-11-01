#!/usr/bin/env node
/* =============================================================================
   thumbnail.mjs — /thumbnail stage (stage 6b): the upload thumbnail.

   The agent writes out/<name>/<NN>/thumbnail.json (the hook, a still from its own
   stage-5 scenes, an optional crop, accent and badge); this tool adds the series label,
   photographs src/thumbnail.html at 1280x720 with the headless Chromium, checks the PNG,
   and copies it into the video's destination folder beside title.txt:

       --dest/<NN>-<slug>/thumbnail.png   — what upload_yt_video picks up

   The series label reads "<playlist>-Part <X>, <upload title>". The playlist name only
   ever comes from the user (--playlist); a plan of more than one video with neither
   --playlist nor --standalone is refused with exit 3, so the agent asks instead of
   inventing one. Part X is the video's 1-based position in plan.enriched.json's
   `videos` list (after curation's skips and merges), not its raw videoIndex.

   Usage:
     node tools/thumbnail.mjs --work out/<name>/<NN> --script out/<name>/scripts/<NN>-*.json \
                              --plan out/<name>/plan.enriched.json --dest <destination> \
                              [--playlist "<name>" | --standalone]
     node tools/thumbnail.mjs --check <file.png>

   Exit: 0 written (or the file passes) · 1 a missing input or prerequisite · 2 the config
   or the PNG fails a check · 3 a series with no playlist decision (ask the user).
   ========================================================================== */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromiumBinOrExit } from './chromium.mjs';
import { videoDir } from './naming.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const WIDTH = 1280;
export const HEIGHT = 720;
// upload_yt_video refuses a thumbnail over 2 MB; the decimal reading is the stricter one
export const MAX_BYTES = 2_000_000;

/* ---------------- the PNG ---------------- */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// width and height from the IHDR chunk, or null for anything that is not a PNG
export function pngInfo(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// every way the file fails what the upload tool and YouTube accept
export function checkThumbnail(buf) {
  const problems = [];
  const info = pngInfo(buf);
  if (!info) problems.push(/^\xff\xd8\xff/.test(buf.toString('latin1', 0, 3))
    ? 'it is a JPEG named as a PNG: write a real PNG'
    : 'not a PNG (no PNG signature and IHDR chunk)');
  else if (info.width !== WIDTH || info.height !== HEIGHT) problems.push(`it is ${info.width}x${info.height}; a thumbnail is ${WIDTH}x${HEIGHT}`);
  if (buf.length > MAX_BYTES) problems.push(`it is ${buf.length.toLocaleString('en-US')} bytes; the upload refuses more than ${MAX_BYTES.toLocaleString('en-US')}`);
  return problems;
}

/* ---------------- the series label ---------------- */
// the video's place in the series as produced: its 1-based position among the plan's surviving videos
export function partOf(plan, videoIndex) {
  const videos = (plan && plan.videos) || [];
  const at = videos.findIndex((v) => Number(v.index) === Number(videoIndex));
  return at === -1 ? null : { part: at + 1, of: videos.length };
}

export const seriesLabel = (playlist, part, title) => `${playlist}-Part ${part}, ${title}`;

/* ---------------- the config ---------------- */
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter(Boolean);
const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'and', 'or', 'is', 'it', 'for', 'how', 'why', 'what', 'your', 'you']);

// { errors, warnings } for thumbnail.json against the upload title; `codebase` adds the code-flow rule
export function checkConfig(cfg, { title = '', codebase = false } = {}) {
  const errors = [];
  const warnings = [];
  const hook = typeof cfg.hook === 'string' ? cfg.hook.replace(/\s+/g, ' ').trim() : '';
  if (!hook) errors.push('"hook" is missing: a few big words that make a viewer want the answer');
  else {
    const n = hook.split(' ').length;
    if (n > 5) errors.push(`"hook" is ${n} words; at most 5 read at phone size`);
    if (hook.length > 32) errors.push(`"hook" is ${hook.length} characters; at most 32 read at phone size`);
    const h = norm(hook), t = norm(title);
    if (t && (h === t || ` ${t} `.includes(` ${h} `))) errors.push(`"hook" repeats the upload title ("${title}"); it must add to it, not echo it`);
    else if (t) {
      const own = words(hook).filter((w) => !STOP.has(w));
      const shared = own.filter((w) => words(title).includes(w));
      if (own.length && shared.length / own.length > 0.5) warnings.push(`"hook" shares most of its words with the upload title (${shared.join(', ')}); a hook that complements the title earns the click`);
    }
    if (codebase) {
      const code = hook.split(' ').filter((w) => /[\\/]|::|\(\)|_|\.[a-z]{1,4}$|[a-z][A-Z]/.test(w));
      if (code.length) errors.push(`"hook" names code (${code.join(', ')}); a code-flow hook names the flow in the viewer's terms, never a module path or an identifier`);
    }
    for (const w of [].concat(cfg.highlight || [])) {
      if (!words(hook).includes(norm(w))) errors.push(`"highlight" word "${w}" is not in the hook`);
    }
  }
  if (cfg.highlight != null && !Array.isArray(cfg.highlight) && typeof cfg.highlight !== 'string') errors.push('"highlight" is a word of the hook or a list of them');
  if (typeof cfg.still !== 'string' || !cfg.still.trim()) errors.push('"still" is missing: a PNG rendered from one of this video\'s own stage-5 scenes');
  if (cfg.focus != null) {
    const { x = 0.5, y = 0.5, zoom = 1 } = cfg.focus;
    if (![x, y].every((v) => typeof v === 'number' && v >= 0 && v <= 1)) errors.push('"focus" x and y are fractions of the still, 0 to 1');
    if (typeof zoom !== 'number' || zoom < 1 || zoom > 4) errors.push('"focus" zoom is 1 to 4');
  }
  if (cfg.accent != null && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(cfg.accent))) errors.push('"accent" is a hex colour such as "#FFD400"');
  if (cfg.badge != null && (typeof cfg.badge !== 'string' || !cfg.badge.trim() || cfg.badge.length > 16)) errors.push('"badge" is a short sticker, 1 to 16 characters');
  return { errors, warnings };
}

/* ---------------- CLI ---------------- */
function main(argv) {
  const has = (n) => argv.includes('--' + n);
  const flag = (n) => { const i = argv.indexOf('--' + n); return i === -1 ? undefined : argv[i + 1]; };
  const die = (code, msg) => { console.error(`[thumbnail] ${msg}`); process.exit(code); };
  const readJson = (p, what) => {
    if (!existsSync(p)) die(1, `no ${what} at ${p}`);
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { die(1, `${what} at ${p} is not JSON: ${e.message}`); }
  };
  const report = (file, problems) => {
    if (problems.length) {
      console.error(`[thumbnail] ✗ ${file}`);
      for (const p of problems) console.error(`     - ${p}`);
      process.exit(2);
    }
  };

  if (has('check')) {
    const file = flag('check');
    if (!file || !existsSync(file)) die(1, `usage: thumbnail.mjs --check <file.png> (no file at ${file})`);
    const buf = readFileSync(file);
    const problems = checkThumbnail(buf);
    if (extname(file).toLowerCase() !== '.png') problems.push(`the file is named ${basename(file)}; the upload picks thumbnail.png`);
    report(file, problems);
    console.log(`[thumbnail] ✓ ${file} — PNG ${WIDTH}x${HEIGHT}, ${buf.length.toLocaleString('en-US')} bytes`);
    return;
  }

  const WORK = flag('work'), SCRIPT = flag('script'), PLAN = flag('plan'), DEST = flag('dest');
  if (!WORK || !SCRIPT || !PLAN || !DEST)
    die(1, 'usage: thumbnail.mjs --work <work-dir> --script <script.json> --plan <plan.enriched.json> --dest <dir> [--playlist "<name>" | --standalone]');
  const workDir = resolve(WORK);
  const script = readJson(resolve(SCRIPT), 'script');
  const plan = readJson(resolve(PLAN), 'enriched plan');
  const cfg = readJson(join(workDir, 'thumbnail.json'), 'thumbnail.json (write it first: hook + still)');

  const where = partOf(plan, script.videoIndex);
  if (!where) die(1, `video ${script.videoIndex} is not in ${PLAN}: pass the enriched plan, which lists the videos curation kept`);

  const destDir = join(resolve(DEST), videoDir(script, basename(workDir)));
  const titleFile = join(destDir, 'title.txt');
  if (!existsSync(titleFile)) die(1, `no title.txt at ${titleFile}: run /publish (stage 6) first, the thumbnail needs the final upload title`);
  const title = readFileSync(titleFile, 'utf8').trim();

  /* The playlist name is the user's, never ours: no default, no guess. */
  const playlist = flag('playlist');
  if (playlist !== undefined && has('standalone')) die(1, 'pass --playlist or --standalone, not both');
  if (playlist !== undefined && !String(playlist).trim()) die(1, '--playlist is empty: a blank Stage 0 answer means a standalone video, so pass --standalone');
  if (playlist === undefined && !has('standalone') && where.of > 1)
    die(3, `this plan has ${where.of} videos, so video ${script.videoIndex} looks like part of a series, and no playlist name was given. ` +
      'Ask the user for the playlist name (or whether it is standalone), then re-run with --playlist "<name>" or --standalone. Never invent one.');
  const label = playlist === undefined ? null : seriesLabel(String(playlist).trim(), where.part, title);

  const { errors, warnings } = checkConfig(cfg, { title, codebase: plan.kind === 'codebase' });
  const stillPath = typeof cfg.still === 'string' ? (isAbsolute(cfg.still) ? cfg.still : join(workDir, cfg.still)) : null;
  if (stillPath && !existsSync(stillPath)) errors.push(`"still" ${cfg.still} does not exist (paths are relative to ${workDir})`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  report(join(workDir, 'thumbnail.json'), errors);

  /* Photograph the host: everything is laid out before the load event, so --screenshot never races it. */
  const bin = chromiumBinOrExit('thumbnail');
  const config = {
    hook: cfg.hook.replace(/\s+/g, ' ').trim(),
    highlight: [].concat(cfg.highlight || []).map((w) => norm(w)),
    label,
    still: pathToFileURL(stillPath).href,
    focus: cfg.focus || null,
    accent: cfg.accent || null,
    badge: cfg.badge ? cfg.badge.trim() : null,
  };
  const url = pathToFileURL(join(ROOT, 'src', 'thumbnail.html')).href + '?c=' + encodeURIComponent(JSON.stringify(config));
  const out = join(workDir, 'thumbnail.png');
  rmSync(out, { force: true });
  const shot = spawnSync(bin, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--allow-file-access-from-files', '--disable-lcd-text', '--font-render-hinting=none',
    `--window-size=${WIDTH},${HEIGHT}`, `--screenshot=${out}`, url], { encoding: 'utf8', timeout: 60_000 });
  if (!existsSync(out)) die(1, `Chromium wrote no screenshot (exit ${shot.status}${shot.error ? `, ${shot.error.message}` : ''})\n${(shot.stderr || '').trim().split('\n').slice(-5).join('\n')}`);
  report(out, checkThumbnail(readFileSync(out)));

  /* The phone-size look: YouTube's mobile lists show a thumbnail a few hundred pixels wide. */
  const small = join(workDir, 'thumbnail.small.png');
  const scaled = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', out, '-vf', 'scale=320:180', small], { encoding: 'utf8' });
  if (scaled.error || scaled.status !== 0) console.log(`  ⚠ no phone-size preview (ffmpeg ${scaled.error ? 'not found' : 'failed'}); look at the full PNG at a small zoom instead`);

  mkdirSync(destDir, { recursive: true });
  copyFileSync(out, join(destDir, 'thumbnail.png'));
  for (const other of ['thumbnail.jpg', 'thumbnail.jpeg']) {
    if (existsSync(join(destDir, other))) console.log(`  ⚠ ${join(destDir, other)} is also there; the upload may pick it instead of thumbnail.png, so remove it`);
  }
  console.log(`  hook     : "${config.hook}"`);
  console.log(`  label    : ${label ? `"${label}"` : '— (standalone video)'}`);
  console.log(`  still    : ${stillPath}`);
  console.log(`\n[out] ${out}`);
  if (existsSync(small)) console.log(`[out] ${small}`);
  console.log(`[dest] ${join(destDir, 'thumbnail.png')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
