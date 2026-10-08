#!/usr/bin/env node
/* =============================================================================
   build-audio.mjs — the /audio stage: narration script -> measured audio.

   This is the ONLY stage that calls an API (Gemini TTS). Everything else in the
   pipeline runs offline.

   It does not estimate. It synthesizes, MEASURES the real duration of every
   segment with ffprobe, and emits a timeline of absolute start/end times. Scene
   timings are then bound to those measurements rather than to a wpm guess.

   Usage:
     node tools/build-audio.mjs --script out/<name>/scripts/NN-<slug>.json \
                                --out out/<name>/<NN> \
                                [--only <key>] [--voice Aoede] [--model gemini-3.8-flash-lite-tts]
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { synthesize } from './tts-gemini.mjs';
import { loadKey, describe, storeHint } from './key-source.mjs';
import { requireCmd } from './env.mjs';

requireCmd('ffmpeg');
requireCmd('ffprobe');

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};

const SCRIPT = flag('script');
const OUT_DIR = String(flag('out', 'out'));
const ONLY = flag('only', null);                  // synthesize just one segment key
const VOICE = String(flag('voice', 'Aoede'));
const MODEL = String(flag('model', 'gemini-3.8-flash-lite-tts'));
const LEAD = parseFloat(flag('lead', '0.6'));     // silence before the first word
const GAP = parseFloat(flag('gap', '0.75'));      // silence between segments
const TAIL = parseFloat(flag('tail', '1.6'));     // silence after the last word
const SR = 22050;

if (!SCRIPT || !existsSync(SCRIPT)) {
  console.error('usage: node tools/build-audio.mjs --script <script.json> --out <dir> [--only key]');
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
const durationOf = f => parseFloat(
  run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim()
);

const script = JSON.parse(readFileSync(SCRIPT, 'utf8'));
const narDir = join(OUT_DIR, 'narration');
mkdirSync(narDir, { recursive: true });

const { key, source: keySrc, store } = loadKey(flag('key'));
if (!key) { console.error('No API key found. Store it in your OS secret store.\n' + storeHint(store)); process.exit(1); }
console.log(`[auth]  ${describe(keySrc, key)}`);
console.log(`[model] ${MODEL}  voice=${VOICE}`);

const wanted = script.segments.filter(s => !ONLY || s.key === ONLY);
if (!wanted.length) { console.error(`no segment matched --only ${ONLY}`); process.exit(1); }

const segments = [];
let cursor = LEAD;
let calls = 0;

for (const seg of wanted) {
  const raw = join(narDir, `${seg.key}.raw.wav`);
  const wav = join(narDir, `${seg.key}.wav`);
  const srcFile = join(narDir, `${seg.key}.src`);
  // Cache keyed on the exact spoken text: re-running after a scene/timing tweak
  // must not re-spend TTS quota, but stale audio must never be reused.
  const cached = existsSync(wav) && existsSync(srcFile) && readFileSync(srcFile, 'utf8') === seg.text;
  process.stdout.write(`  [tts] ${seg.key.padEnd(7)} … `);
  if (cached && !flag('force')) {
    console.log('reused (text unchanged)');
  } else {
    try {
      const { wav: buf } = await synthesize({ text: seg.text, voice: VOICE, style: seg.style, model: MODEL, key });
      writeFileSync(raw, buf);
      calls++;
    } catch (e) {
      console.log('FAILED');
      console.error('\n[error] ' + e.message.split('\n')[0]);
      process.exit(1);
    }
    run('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-ar', String(SR), '-ac', '1', wav]);
    rmSync(raw, { force: true });
    writeFileSync(srcFile, seg.text);
    console.log(`${durationOf(wav).toFixed(2)}s  (${seg.text.split(/\s+/).filter(Boolean).length} words)`);
  }
  const dur = durationOf(wav);
  // A segment may declare a hold: extra silence after the spoken words, giving the
  // visuals room a beat needs beyond its narration. pacing-check reports the
  // shortfall; this pad resolves it (and re-running is free — the TTS is cached).
  const pad = Number(seg.pad) || 0;
  segments.push({ key: seg.key, start: +cursor.toFixed(3), end: +(cursor + dur).toFixed(3), duration: +dur.toFixed(3), pad: pad, words: seg.text.split(/\s+/).filter(Boolean).length, cached });
  cursor += dur + pad + GAP;
}

const total = +(cursor - GAP + TAIL).toFixed(3);

/* ---- build the full narration track (silence + segments + silence) ---- */
const sil = (name, secs) => {
  const p = join(narDir, `silence-${name}.wav`);
  run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `anullsrc=r=${SR}:cl=mono`, '-t', String(secs), p]);
  return p;
};

const parts = [];
if (LEAD > 0) parts.push(sil('lead', LEAD));
wanted.forEach((seg, i) => {
  parts.push(join(narDir, `${seg.key}.wav`));
  const pad = Number(seg.pad) || 0;
  if (pad > 0) parts.push(sil(`${seg.key}-hold`, pad));
  const isLast = i === wanted.length - 1;
  const gap = isLast ? TAIL : GAP;
  if (gap > 0) parts.push(sil(isLast ? 'tail' : 'gap', gap));
});
// ffmpeg resolves entries in a concat list RELATIVE TO THE LIST FILE, so every
// entry must be absolute or paths silently double up.
const listFile = join(narDir, 'concat.txt');
writeFileSync(listFile, parts.map(p => `file '${resolve(p)}'`).join('\n') + '\n');
run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-ar', String(SR), '-ac', '1', join(OUT_DIR, 'narration.wav')]);
const trackDur = durationOf(join(OUT_DIR, 'narration.wav'));

// Each segment OWNS a contiguous slice of the finished video: from its lead-in
// to the next segment's lead-in. These tile the whole timeline with no gaps, so
// per-segment renders can simply be concatenated.
const windows = {};
const grandTotal = Math.max(total, trackDur);
segments.forEach((sg, i) => {
  const wStart = i === 0 ? 0 : sg.start - LEAD;
  const wEnd = i === segments.length - 1 ? grandTotal : segments[i + 1].start - LEAD;
  windows[sg.key] = { start: +wStart.toFixed(3), end: +wEnd.toFixed(3), dur: +(wEnd - wStart).toFixed(3) };
});

const timeline = {
  script: SCRIPT,
  voice: VOICE,
  model: MODEL,
  measured: true,
  total: grandTotal,
  segments,
  windows,
  calls,
};
writeFileSync(join(OUT_DIR, 'timeline.json'), JSON.stringify(timeline, null, 2));

// scenes: a browser host loads this with <script> — file:// cannot fetch JSON
// Per-video: the browser-loadable timeline lives beside timeline.json, so a second
// video no longer overwrites a global src/timeline.js (ROADMAP §1, "Work-dir layout").
const scenes = {};
segments.forEach(sg => { scenes[sg.key] = { start: sg.start, end: sg.end, dur: sg.duration }; });
writeFileSync(join(OUT_DIR, 'timeline.js'),
  'window.TIMELINE = ' + JSON.stringify({
    fps: 30, width: 1920, height: 1080,
    total: grandTotal, scenes, windows, segments,
  }, null, 2) + ';\n');

console.log(`\n[audio] ${calls} TTS call(s) · narration track ${trackDur.toFixed(2)}s`);
console.log(`[windows] ${Object.entries(windows).map(([k, w]) => k + ' ' + w.dur + 's').join(' · ')}`);
segments.forEach(s => console.log(`   ${s.key.padEnd(7)} ${String(s.start).padStart(7)}s -> ${String(s.end).padStart(7)}s  (${s.duration}s)`));
console.log(`[out] ${join(OUT_DIR, 'narration.wav')}`);
console.log(`[out] ${join(OUT_DIR, 'timeline.json')}`);
console.log(`[out] ${join(OUT_DIR, 'timeline.js')}  (browser-loadable, ${segments.length} scene(s))`);
