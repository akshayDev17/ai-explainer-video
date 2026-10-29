#!/usr/bin/env node
/* =============================================================================
   excerpt-check.mjs — prove every code panel of a code video shows the repo as
   mined, and that the narration is the reading time (design §4.5 C6).

   Usage:
     node tools/excerpt-check.mjs --work out/<name>/<NN> --repo <root> --script out/<name>/scripts/NN-*.json

   Reads the video's code scenes (manifest.json's `code` segments), lines.json
   (stage 4b) and the video's script. Two checks:

   DRIFT (exit 2) — every panel carries the `source` excerpt.mjs wrote, and is
     byte-identical to the file as mined: the working tree's file when its sha256
     is the mined one, else the file at the mined commit (`git show`), else the
     file changed and the panel cannot be trusted. Every numbered line equals that
     line of the file, inside the span, in order; the span's sha256 still matches;
     every unnumbered line is an elision marker ("⋯ N lines") standing for exactly
     the gap it sits in, and no line of the span is hidden without one; at most 22
     lines are shown.

   FOCUS (exit 3) — every shown, non-blank line is inside a focus window that is
     synced to the narration: the focus act names `narration` (a line index of
     the segment in lines.json, or [from, to]) and starts at that line's onset
     and ends between its end and the next line's onset (scene time, ±0.06 s, as
     resolve-beats measures). Only a pause segment (one whose script segment
     carries `pause`) may show lines outside a focus window; there are at most 3,
     each with a badge.

   Exit: 0 ok · 1 bad flags, no manifest, no scenes, no lines.json or no script · 2 drift · 3 a shown line
         outside every narration-synced focus window, or a pause rule broken
   ========================================================================== */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { MAX_PAUSES } from '../../explainer-video-from-coursework/tools/model.mjs';

const fail = (code, msg) => { console.error(`[excerpt-check] ${msg}`); process.exit(code); };

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
const VALUED = new Set(['--work', '--repo', '--script']);
const flags = new Map();
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) { if (argv[i + 1] == null) fail(1, `${argv[i]} needs a value`); flags.set(argv[i], argv[++i]); }
  else fail(1, `unknown argument ${argv[i]}`);
}
if (!flags.has('--work') || !flags.has('--repo') || !flags.has('--script')) fail(1, 'usage: excerpt-check.mjs --work out/<name>/<NN> --repo <root> --script out/<name>/scripts/NN-*.json');
const WORK = resolve(flags.get('--work')), REPO = resolve(flags.get('--repo'));
const MAX_LINES = 22, TOL = 0.06;
const MARKER = /^\s*⋯ (\d+) lines?$/;
const sha = t => createHash('sha256').update(t).digest('hex');
const readJson = (f, what) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { fail(1, `cannot read ${what} ${f}: ${e.message}`); } };

/* ---------------- the code scenes ---------------- */
const scenesDir = join(WORK, 'scenes');
if (!existsSync(scenesDir)) fail(1, `no scenes/ in ${WORK}: author the scenes first (stage 5)`);
// a scene is read by executing it with a stubbed `window`, as resolve-beats and the scene host do
async function sceneConfig(file) {
  const prev = global.window;
  global.window = {};
  try { await import(pathToFileURL(file).href + '?v=' + Date.now()); return global.window.SCENE_CONFIG || null; }
  catch (e) { fail(1, `${basename(file)} threw: ${e.message}`); }
  finally { global.window = prev; }
}
const manifestPath = join(WORK, 'manifest.json');
if (!existsSync(manifestPath)) fail(1, `no manifest.json in ${WORK}: write it with the scenes (stage 5); its code segments are the panels checked`);
const man = readJson(manifestPath, 'the manifest');
const isCode = host => host === 'code' || /scene-code\.html$/.test((man.hosts || {})[host] || '');
const segs = Object.entries(man.segments || {}).filter(([, s]) => isCode(s.host)).map(([key, s]) => ({ key, file: join(scenesDir, `${s.scene}.js`) }));
const scenes = [];
for (const s of segs) {
  if (!existsSync(s.file)) fail(1, `segment ${s.key}: scene ${s.file} does not exist`);
  const cfg = await sceneConfig(s.file);
  if (cfg && Array.isArray(cfg.panels)) scenes.push({ ...s, cfg });
}
if (!scenes.length) fail(1, `no code scenes in ${WORK}`);
const linesPath = join(WORK, 'lines.json');
if (!existsSync(linesPath)) fail(1, `no lines.json in ${WORK}: run align.mjs first (stage 4b); focus windows are checked against the measured narration`);
const segLines = readJson(linesPath, 'lines.json').segments || {};
const script = readJson(resolve(flags.get('--script')), 'the script');

/* ---------------- the file a panel was cut from, as mined ---------------- */
const fileCache = new Map();
function minedFile(src) {
  const key = `${src.file}\0${src.fileSha256}\0${src.commit}`;
  if (fileCache.has(key)) return fileCache.get(key);
  let got = null;
  const path = join(REPO, src.file);
  if (existsSync(path)) { const t = readFileSync(path, 'utf8'); if (sha(t) === src.fileSha256) got = { text: t, from: 'working tree' }; }
  if (!got && src.commit) {
    const r = spawnSync('git', ['-C', REPO, 'show', `${src.commit}:./${src.file}`], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status === 0 && sha(r.stdout) === src.fileSha256) got = { text: r.stdout, from: `commit ${src.commit.slice(0, 12)}` };
  }
  fileCache.set(key, got);
  return got;
}

/* ---------------- checks ---------------- */
const drift = [], focus = [], report = [];
const pauseSegs = new Set((script.segments || []).filter(s => s.pause != null).map(s => s.key));

for (const { key, cfg } of scenes) {
  const acts = cfg.acts || [];
  const L = segLines[key];
  const isPause = pauseSegs.has(key);
  const hasBadge = acts.some(a => a.op === 'pause');
  if (isPause && !hasBadge) focus.push(`${key}: a pause segment shows no pause badge (add a \`pause\` act over the spoken prompt)`);
  if (!isPause && hasBadge) focus.push(`${key}: a pause badge on a segment whose narration does not ask for a pause`);

  // the focus windows synced to this segment's narration; an unsynced one covers nothing
  const synced = new Map();   // panel id -> Set of 1-based panel lines
  for (const a of acts.filter(x => x.op === 'focus')) {
    const at = `${key}: focus on ${a.panel} at ${a.from}–${a.to}s`;
    const n = a.narration;
    const [f, t] = Array.isArray(n) ? n : [n, n];
    if (!Number.isInteger(f) || !Number.isInteger(t) || t < f) { focus.push(`${at} names no narration line (\`narration: <line>\` or \`[from, to]\` in lines.json)`); continue; }
    if (typeof a.from !== 'number' || typeof a.to !== 'number') { focus.push(`${at} needs numeric from and to (scene seconds)`); continue; }
    if (!L) { focus.push(`${at}: lines.json has no segment ${key} (re-run align.mjs)`); continue; }
    if (f < 0 || t >= L.lines.length) { focus.push(`${at}: narration lines ${f}…${t} do not exist (segment has ${L.lines.length})`); continue; }
    const lead = L.lead ?? 0, start = L.lines[f].start + lead, end = L.lines[t].end + lead;
    const next = t + 1 < L.lines.length ? L.lines[t + 1].start + lead : (cfg.total ?? end);
    if (Math.abs(a.from - start) > TOL) { focus.push(`${at} starts ${(a.from - start).toFixed(2)}s off narration line ${f}'s onset (${start.toFixed(3)}s)`); continue; }
    if (a.to < end - TOL || a.to > Math.max(end, next) + TOL) { focus.push(`${at} must end between narration line ${t}'s end (${end.toFixed(3)}s) and the next line's onset (${next.toFixed(3)}s)`); continue; }
    const set = synced.get(a.panel) || synced.set(a.panel, new Set()).get(a.panel);
    for (const i of a.lines || []) set.add(i);
  }

  for (const p of cfg.panels) {
    const at = `${key}/${p.id}`;
    const src = p.source;
    if (!src || !src.file || !src.fileSha256 || !src.sha256 || !Number.isInteger(src.start) || !Number.isInteger(src.end)) {
      drift.push(`${at}: no excerpt source — every code panel of a code video is generated by excerpt.mjs, never typed`); continue;
    }
    const lines = p.lines || [], nums = p.numbers || [];
    if (nums.length !== lines.length) { drift.push(`${at}: numbers[] has ${nums.length} entries for ${lines.length} lines`); continue; }
    const mined = minedFile(src);
    if (!mined) { drift.push(`${at}: ${src.file} is not the file excerpt.mjs read (sha256 ${src.fileSha256.slice(0, 12)}…) in the working tree${src.commit ? ` or at commit ${src.commit.slice(0, 12)}` : ''}: re-mine and re-excerpt`); continue; }
    const file = mined.text.split('\n');
    if (sha(file.slice(src.start - 1, src.end).join('\n')) !== src.sha256) { drift.push(`${at}: the span ${src.file}:${src.start}-${src.end} no longer matches its sha256`); continue; }
    const elided = new Map((p.elided || []).map(e => [e.at, e]));
    let prev = src.start - 1, bad = 0;
    const visible = nums.filter(n => n != null).length;
    if (visible > MAX_LINES) drift.push(`${at}: ${visible} lines shown, over the ${MAX_LINES}-line cap`);
    // the gap an elision marker stands for runs to the next numbered line, or the span's end
    const nextNum = i => { for (let j = i + 1; j < nums.length; j++) if (nums[j] != null) return nums[j]; return src.end + 1; };
    lines.forEach((ln, i) => {
      const n = nums[i];
      if (n == null) {
        const e = elided.get(i), mk = MARKER.exec(ln);
        const from = prev + 1, to = nextNum(i) - 1;
        if (!e || !mk || e.from !== from || e.to !== to || Number(mk[1]) !== to - from + 1) {
          drift.push(`${at} line ${i + 1}: "${ln}" is unnumbered but not the elision marker for lines ${from}-${to}`); bad++;
        }
        prev = to;
        return;
      }
      if (!Number.isInteger(n) || n <= prev || n < src.start || n > src.end) { drift.push(`${at} line ${i + 1}: number ${n} is out of order or outside ${src.file}:${src.start}-${src.end}`); bad++; prev = Math.max(prev, Number(n) || prev); return; }
      if (n !== prev + 1) { drift.push(`${at}: ${src.file}:${prev + 1}-${n - 1} hidden without an elision marker`); bad++; }
      if (ln !== file[n - 1]) { drift.push(`${at}: ${src.file}:${n} differs from the file (${JSON.stringify(ln)} vs ${JSON.stringify(file[n - 1])})`); bad++; }
      prev = n;
    });
    if (prev < src.end) { drift.push(`${at}: ${src.file}:${prev + 1}-${src.end} hidden without an elision marker`); bad++; }

    // narration is the reading time: every shown line in a narration-synced focus window, except in a pause segment
    const covered = synced.get(p.id) || new Set();
    const unread = lines.map((ln, i) => ({ ln, i, n: nums[i] })).filter(x => x.n != null && x.ln.trim() && !covered.has(x.i + 1));
    if (unread.length && !isPause) focus.push(`${at}: ${unread.length} shown line(s) outside every narration-synced focus window: ${src.file}:${unread.map(x => x.n).join(',')}`);
    report.push(`  ${bad ? '✗' : '✓'} ${at.padEnd(24)} ${src.test ? `test ${src.test.split(':').pop()}` : src.symbol || src.file} · ${visible} lines · ${mined.from}${isPause ? ' · pause segment' : ''}${unread.length ? ` · ${unread.length} unfocused` : ''}`);
  }
}
if (pauseSegs.size > MAX_PAUSES) focus.push(`${pauseSegs.size} pause segments (max ${MAX_PAUSES}): a video that asks for that much silent reading must be split`);

console.log(`\nexcerpt-check ${WORK}`);
console.log(`  ${scenes.length} code scene(s) · ${scenes.reduce((a, s) => a + s.cfg.panels.length, 0)} panel(s) · ${pauseSegs.size} pause segment(s)`);
report.forEach(r => console.log(r));
if (drift.length) { console.log(`\n  ✗ ${drift.length} drift problem(s):`); drift.forEach(d => console.log(`     - ${d}`)); }
if (focus.length) { console.log(`\n  ✗ ${focus.length} focus problem(s):`); focus.forEach(d => console.log(`     - ${d}`)); }
if (!drift.length && !focus.length) console.log('\n  ✓ every panel is the mined code, and every shown line is narrated');
process.exitCode = drift.length ? 2 : focus.length ? 3 : 0;
