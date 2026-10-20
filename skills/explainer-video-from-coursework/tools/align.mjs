#!/usr/bin/env node
/* =============================================================================
   align.mjs — stage 4b: per-word timings, and the LINE spans a scene can bind to.

   Why this exists
   ---------------
   A scene's beats must fire when the narration says the thing the beat shows, and
   the only honest way to know that is to measure it. Measuring at segment
   granularity (build-audio) leaves everything inside a segment to guesswork, and a
   guessed beat can be seconds off while every existing check still passes.

   Request budget — why this transcribes the WHOLE TRACK by default
   ----------------------------------------------------------------
   gemini-3.5-transcribe is capped at 100 requests/day per project per model
   (GenerateRequestsPerDayPerProjectPerModel, per the API's own QuotaFailure
   payload), the Batch API is not supported for it, and the cap cannot be spread
   across keys on one project. Transcribing per segment spent ~30 requests on a
   13-minute video; one pass over narration.wav spends one.

   The model allows "up to 1 hour per request — up to 30 minutes when ... word-level
   timestamps are enabled", so this file:
     - <= MAX_PASS seconds -> one request over the whole track
     - longer              -> the track is cut at SEGMENT boundaries into <= MAX_PASS
                              pieces (never mid-sentence), one request each, offsets
                              re-based onto the track
     - --per-segment       -> the old path, kept as a fallback. Chosen automatically
                              when only a few segments are missing, where it is cheaper.

   Already-cached segments are never re-requested, and a whole-track pass fills only
   the segments that were missing — so a fallback cannot overwrite good measurements.

   Usage
     node tools/align.mjs --script out/<name>/scripts/NN-<slug>.json \
                          --work out/<name>/<NN> [--only <key>] [--force] \
                          [--whole-track | --per-segment] \
                          [--min-match 0.8] [--sleep 150]
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { transcribeWords, MODEL } from './transcribe-gemini.mjs';
import { loadKey, describe, storeHint } from './key-source.mjs';
import { claimWorkDir } from './workdir.mjs';
import { requireCmd } from './env.mjs';

requireCmd('ffmpeg');
requireCmd('ffprobe');

/* Model ceiling is 30 min with word timestamps; keep a margin for rounding. */
const MAX_PASS = 28 * 60;
/* Below this many missing segments, per-segment calls are cheaper than a whole pass. */
const AUTO_WHOLE_TRACK_ABOVE = 3;

const flag = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  if (i === -1) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const SCRIPT = flag('script');
const WORK = flag('work');
const ONLY = flag('only', null);
const FORCE = !!flag('force', false);
const FORCE_WHOLE = !!flag('whole-track', false);
const FORCE_PER_SEG = !!flag('per-segment', false);
const MIN_MATCH = parseFloat(flag('min-match', '0.8'));
const SLEEP = parseInt(flag('sleep', '150'), 10);

if (!SCRIPT || !WORK) {
  console.error('usage: node tools/align.mjs --script <script.json> --work <work-dir> [--only <key>] [--force] [--whole-track|--per-segment]');
  process.exit(1);
}
if (!existsSync(SCRIPT)) { console.error('not found: ' + SCRIPT); process.exit(1); }
if (FORCE_WHOLE && FORCE_PER_SEG) { console.error('--whole-track and --per-segment are mutually exclusive'); process.exit(1); }

const scriptPath = resolve(SCRIPT);
const workDir = resolve(WORK);
const script = JSON.parse(readFileSync(scriptPath, 'utf8'));

/* One work dir per video (see tools/workdir.mjs) — `lines.json` has the same
   fixed name for every video, so a shared dir would mix two videos' alignments. */
claimWorkDir(WORK, script, 'align');

const timelinePath = join(workDir, 'timeline.json');
const tl = existsSync(timelinePath) ? JSON.parse(readFileSync(timelinePath, 'utf8')) : null;
const windows = (tl && tl.windows) || {};
const segInfo = Object.fromEntries(((tl && tl.segments) || []).map(s => [s.key, s]));

const loaded = loadKey();
const apiKey = loaded.key;
if (!apiKey) {
  console.error('No API key found (' + describe(loaded.source, apiKey) + ').\n  ' + storeHint(loaded.source));
  process.exit(1);
}

/* ---------------- text handling ---------------- */
const NUM = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
  eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13',
  fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60',
  seventy: '70', eighty: '80', ninety: '90',
};
/* Compare on meaning, not spelling: the transcriber writes "40" where we wrote
   "forty", and attaches punctuation to tokens. */
const normWord = w => {
  const t = String(w).toLowerCase().replace(/[^a-z0-9]/g, '');
  return NUM[t] || t;
};
/* Our punctuation decides sentence boundaries — never the transcript's. */
function splitLines(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let from = 0;
  for (let i = 0; i < words.length; i++) {
    if (/[.!?]["')\]]?$/.test(words[i])) { lines.push({ from, to: i }); from = i + 1; }
  }
  if (from < words.length) lines.push({ from, to: words.length - 1 });
  return { words, lines };
}

/* align script tokens -> transcript indices (longest common subsequence) */
function alignLCS(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const map = new Int32Array(n).fill(-1);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { map[i] = j; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return map;
}

/* The transcriber occasionally emits an outlier offset: on the module-07 plan
   "A delta" came back at 3.7s in a sentence whose neighbours were at 12.4s and
   14.2s. Offsets are therefore forced monotonic and non-overlapping — a clamp, not
   a repair: an early outlier is pushed to the end of the word before it. */
function clampMonotonic(words) {
  let fixed = 0;
  let prevEnd = -Infinity;
  for (const w of words) {
    if (w.s < prevEnd) { w.s = prevEnd; fixed++; }
    if (w.e <= w.s) { w.e = +(w.s + 0.05).toFixed(3); fixed++; }
    prevEnd = w.e;
  }
  return fixed;
}

const sha1 = s => createHash('sha1').update(s).digest('hex');
const durOf = f => parseFloat(execFileSync('ffprobe',
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());

/* ---------------- which segments need measuring ---------------- */
const want = ONLY ? script.segments.filter(s => s.key === ONLY) : script.segments;
if (!want.length) { console.error('no segments matched' + (ONLY ? ' --only ' + ONLY : '')); process.exit(1); }

const errors = [];
const warnings = [];
const pending = [];
const cacheOf = new Map();

for (const seg of want) {
  const wavPath = join(workDir, 'narration', seg.key + '.wav');
  const cachePath = join(workDir, 'narration', seg.key + '.words.json');
  if (!existsSync(wavPath)) { errors.push(seg.key + ': no narration/' + seg.key + '.wav — run build-audio first'); continue; }
  const st = statSync(wavPath);
  const textHash = sha1(seg.text);
  if (!FORCE && existsSync(cachePath)) {
    try {
      const c = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (c.textHash === textHash && c.wav && c.wav.bytes === st.size && c.wav.mtimeMs === Math.round(st.mtimeMs)) {
        cacheOf.set(seg.key, c);
        continue;
      }
    } catch (e) { /* corrupt cache: re-transcribe */ }
  }
  pending.push({ seg: seg, wavPath: wavPath, cachePath: cachePath, bytes: st.size, mtimeMs: Math.round(st.mtimeMs), textHash: textHash });
}

console.log('\n[align] ' + want.length + ' segment(s) · model ' + MODEL + ' · ' + cacheOf.size + ' cached · ' + pending.length + ' to measure');

/* ---------------- choose the request shape ---------------- */
const trackPath = join(workDir, 'narration.wav');
const canWholeTrack = existsSync(trackPath) && pending.every(p => segInfo[p.seg.key]);
let mode = FORCE_PER_SEG ? 'per-segment'
  : FORCE_WHOLE ? 'whole-track'
  : (!pending.length) ? 'none'
  : (pending.length > AUTO_WHOLE_TRACK_ABOVE && canWholeTrack) ? 'whole-track'
  : 'per-segment';

if (mode === 'whole-track' && !canWholeTrack) {
  warnings.push('narration.wav or timeline segment offsets are missing — falling back to per-segment');
  mode = 'per-segment';
}

async function wordsFromFile(path) {
  const res = await transcribeWords({ wavPath: path, key: apiKey });
  return res.words;
}

/* Absolute-offset words across the whole narration track, chunked if needed. */
async function wholeTrackWords() {
  const total = durOf(trackPath);
  const chunks = [];
  if (total <= MAX_PASS) {
    chunks.push({ start: 0, len: total });
  } else {
    /* cut at SEGMENT boundaries so no sentence is split across two passes */
    const starts = Array.from(new Set(pending.map(p => segInfo[p.seg.key].start))).sort((a, b) => a - b);
    let from = 0;
    const marks = starts.concat([total]);
    for (const s of marks) {
      while (s - from > MAX_PASS) {
        chunks.push({ start: from, len: MAX_PASS });
        from += MAX_PASS;
      }
      if (s === total) {
        if (total - from > 0.5) chunks.push({ start: from, len: total - from });
        break;
      }
    }
    if (!chunks.length) chunks.push({ start: 0, len: total });
    warnings.push('track is ' + (total / 60).toFixed(1) + ' min — split into ' + chunks.length +
      ' pass(es) at segment boundaries (model cap is 30 min with word timestamps)');
  }

  const out = [];
  const tmp = chunks.length > 1 ? mkdtempSync(join(tmpdir(), 'align-')) : null;
  try {
    for (let ci = 0; ci < chunks.length; ci++) {
      const c = chunks[ci];
      let file = trackPath;
      if (tmp) {
        file = join(tmp, 'chunk-' + ci + '.wav');
        execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(c.start), '-t', String(c.len), '-i', trackPath, file]);
      }
      const ws = await wordsFromFile(file);
      for (const w of ws) out.push({ w: w.w, s: +(c.start + w.s).toFixed(3), e: +(c.start + w.e).toFixed(3) });
      if (SLEEP) await new Promise(r => setTimeout(r, SLEEP));
    }
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

/* ---------------- obtain words for the pending segments ---------------- */
const wordsFor = new Map();
if (mode === 'whole-track' && pending.length) {
  let trackWords = null;
  try {
    process.stdout.write('  whole track… ');
    trackWords = await wholeTrackWords();
    console.log(trackWords.length + ' words');
  } catch (e) {
    const msg = e.message.split('\n')[0];
    /* A daily-cap failure (429) will fail identically for every segment, so falling
       back would burn the whole run on doomed requests. Stop and report instead. */
    if (/429|quota/i.test(msg)) {
      console.error('\n  ✗ transcribe quota exhausted — ' + msg);
      console.error('     Whole-track mode needs ONE request; per-segment fallback would need ' +
        pending.length + '. Re-run after the daily reset.');
      process.exit(3);
    }
    warnings.push('whole-track pass failed (' + msg + ') — falling back to per-segment');
    mode = 'per-segment';
  }
  if (trackWords) {
    for (const p of pending) {
      const info = segInfo[p.seg.key];
      /* the track holds `start` seconds of lead-in before this segment's audio */
      const rel = trackWords
        .filter(w => w.s >= info.start - 0.05 && w.s < info.end + 0.05)
        .map(w => ({ w: w.w, s: +(w.s - info.start).toFixed(3), e: +(w.e - info.start).toFixed(3) }));
      if (!rel.length) errors.push(p.seg.key + ': whole-track pass produced no words inside ' + info.start + '–' + info.end + 's');
      else wordsFor.set(p.seg.key, rel);
    }
  }
}

if (mode === 'per-segment') {
  for (const p of pending) {
    process.stdout.write('  ' + p.seg.key.padEnd(24) + ' transcribing… ');
    try {
      wordsFor.set(p.seg.key, await wordsFromFile(p.wavPath));
      console.log('ok');
    } catch (e) {
      console.log('FAILED');
      errors.push(p.seg.key + ': ' + e.message.split('\n')[0]);
    }
    if (SLEEP) await new Promise(r => setTimeout(r, SLEEP));
  }
}

/* ---------------- align each segment, emit caches + line spans ---------------- */
const out = {};
for (const seg of want) {
  const wavPath = join(workDir, 'narration', seg.key + '.wav');
  if (!existsSync(wavPath)) continue;

  let words, matched, total;
  const cached = cacheOf.get(seg.key);
  const fresh = wordsFor.get(seg.key);

  if (cached && !fresh) {
    words = cached.words; matched = cached.matched; total = cached.total;
    const fixed = clampMonotonic(words);
    if (fixed) {
      warnings.push(seg.key + ': ' + fixed + ' word offset(s) in the cached transcript were out of order — clamped and re-saved');
      /* write the repair back, so the warning appears once rather than every run */
      try {
        const cp = join(workDir, 'narration', seg.key + '.words.json');
        writeFileSync(cp, JSON.stringify({ ...cached, words: words }, null, 1) + '\n');
      } catch (e) { /* cache is advisory; a failed rewrite is not fatal */ }
    }
  } else if (fresh) {
    const fixed = clampMonotonic(fresh);
    if (fixed) warnings.push(seg.key + ': ' + fixed + ' word offset(s) came back out of order and were clamped');
    const parts = splitLines(seg.text);
    const map = alignLCS(parts.words.map(normWord), fresh.map(w => normWord(w.w)));
    matched = Array.from(map).filter(x => x >= 0).length;
    total = parts.words.length;
    const inv = new Int32Array(fresh.length).fill(-1);
    for (let k = 0; k < map.length; k++) if (map[k] >= 0) inv[map[k]] = k;
    words = fresh.map((w, j) => ({ w: w.w, s: w.s, e: w.e, si: inv[j] }));
    const p = pending.find(x => x.seg.key === seg.key);
    writeFileSync(p.cachePath, JSON.stringify({
      key: seg.key, model: MODEL, text: null, textHash: p.textHash,
      wav: { bytes: p.bytes, mtimeMs: p.mtimeMs }, matched: matched, total: total, words: words,
    }, null, 1) + '\n');
  } else {
    continue;
  }

  /* forward map script-word -> transcript-word, from the stored `si` */
  const parts2 = splitLines(seg.text);
  const sw = parts2.words, sent = parts2.lines;
  const fwd = new Int32Array(sw.length).fill(-1);
  words.forEach((w, j) => { if (w.si >= 0 && w.si < sw.length) fwd[w.si] = j; });

  const ratio = matched / Math.max(1, total);
  if (ratio < MIN_MATCH) warnings.push(seg.key + ': only ' + (ratio * 100).toFixed(0) + '% of script words aligned (min ' + (MIN_MATCH * 100) + '%)');

  const lines = [];
  for (let li = 0; li < sent.length; li++) {
    const s = sent[li];
    let first = -1, last = -1;
    for (let k = s.from; k <= s.to; k++) if (fwd[k] >= 0) { first = fwd[k]; break; }
    for (let k = s.to; k >= s.from; k--) if (fwd[k] >= 0) { last = fwd[k]; break; }
    if (first < 0 || last < 0) {
      errors.push(seg.key + ': line ' + li + ' ("' + sw.slice(s.from, s.to + 1).join(' ').slice(0, 40) + '…") aligned to no words');
      continue;
    }
    lines.push({
      line: li,
      text: sw.slice(s.from, s.to + 1).join(' '),
      start: +words[first].s.toFixed(3),
      end: +words[last].e.toFixed(3),
      wordFrom: s.from, wordTo: s.to,
    });
  }

  const wavDur = durOf(wavPath);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].start < lines[i - 1].start) errors.push(seg.key + ': line ' + i + ' starts before line ' + (i - 1));
  }
  for (const L of lines) {
    if (L.start < -0.05 || L.end > wavDur + 0.5) {
      errors.push(seg.key + ': line ' + L.line + ' spans ' + L.start + '–' + L.end + 's, outside the ' + wavDur.toFixed(2) + 's audio');
    }
  }

  const win = windows[seg.key];
  const info = segInfo[seg.key];
  const lead = (win && info) ? +(info.start - win.start).toFixed(3) : null;
  out[seg.key] = {
    total: +wavDur.toFixed(3), lead: lead, textHash: sha1(seg.text),
    window: win ? { start: win.start, end: win.end } : null,
    words: total, matched: matched, lines: lines,
  };
}

/* ---------------- emit ---------------- */
const linesPath = join(workDir, 'lines.json');
writeFileSync(linesPath, JSON.stringify({
  generatedFrom: {
    script: scriptPath.replace(process.cwd() + '/', ''),
    aligner: 'tools/align.mjs',
    model: MODEL,
    mode: mode,
    at: new Date().toISOString(),
  },
  note: 'Line times are relative to the narration WAV start. Scene time = line.start + lead.',
  segments: out,
}, null, 1) + '\n');

console.log('  mode: ' + mode);
if (warnings.length) { console.log('\n  ⚠ ' + warnings.length + ' warning(s):'); warnings.forEach(w => console.log('     - ' + w)); }
if (errors.length) {
  console.log('\n  ✗ ' + errors.length + ' error(s):');
  errors.forEach(e => console.log('     - ' + e));
  process.exitCode = 2;
} else {
  const tot = Object.values(out).reduce((a, s) => a + s.lines.length, 0);
  console.log('\n  ✓ ' + Object.keys(out).length + ' segment(s) · ' + tot + ' lines · written:');
  console.log('     ' + linesPath.replace(process.cwd() + '/', ''));
  process.exitCode = 0;
}
