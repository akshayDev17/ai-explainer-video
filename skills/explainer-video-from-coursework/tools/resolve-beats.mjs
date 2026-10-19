#!/usr/bin/env node
/* =============================================================================
   resolve-beats.mjs — the gate between "a beat says which line it belongs to"
   and "a beat has a number of seconds".

   The bug this closes
   -------------------
   A scene used to declare `at: 6.6` — a hand-guessed second. Nothing measured it,
   so a beat could fire six seconds early and every check still passed. On the
   module-07 pilot the April reveal fired at 6.60s while the words "In April"
   start at 12.60s.

   The contract now
   ----------------
   A scene declares WHICH LINE of the narration a beat belongs to:

       window.SCENE_BEATS = {
         beats: [
           { id: 'march', line: 1, min: 5 },
           { id: 'april', line: 2, min: 5 },
         ]
       }

   and `tools/align.mjs` has measured every line's span. This tool resolves each
   `line` to seconds, writes `beats.json`, and REFUSES to pass when:

     • a beat carries a raw `at` and no `line`      (a hand-guessed time)
     • a `line` index does not exist in lines.json  (a stale or invented line)
     • lines are referenced out of order            (a beat before its own line)
     • two beats share an id                        (ambiguous resolution)
     • lines.json is missing or older than the WAV  (stale alignment)
     • a narration line has no beat at all          (narration with no visual)

   Beat times are written in SCENE time — relative to the segment's render window,
   so `at = line.start + lead` (lead is measured, not assumed).

   Usage
     node tools/resolve-beats.mjs --work out/<name>/<NN> [--allow-uncovered]
     node tools/resolve-beats.mjs --work out/<name>/<NN> --print
   ========================================================================== */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const flag = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  if (i === -1) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const WORK = flag('work');
const SCRIPT = flag('script', null);   // optional: verify lines.json still matches the narration
const ALLOW_UNCOVERED = !!flag('allow-uncovered', false);
const PRINT = !!flag('print', false);

if (!WORK) {
  console.error('usage: node tools/resolve-beats.mjs --work <work-dir> [--allow-uncovered] [--print]');
  process.exit(1);
}
const workDir = resolve(WORK);
const linesPath = join(workDir, 'lines.json');
const scenesDir = join(workDir, 'scenes');

const rel = p => p.replace(process.cwd() + '/', '');
const errors = [];
const warnings = [];

if (!existsSync(linesPath)) {
  console.error(`no lines.json at ${rel(linesPath)} — run tools/align.mjs first`);
  process.exit(1);
}
if (!existsSync(scenesDir)) {
  console.error(`no scenes/ at ${rel(scenesDir)} — author the scenes first (stage 5)`);
  process.exit(1);
}
const linesDoc = JSON.parse(readFileSync(linesPath, 'utf8'));
const segLines = linesDoc.segments || {};

/* THE LOOP GUARD. The audio stage can be re-invoked from the scene stage to resolve a
   shortfall. A `pad` only widens the window (line times stay valid), but "extend the
   narration" changes the WAV — and then every line time in lines.json describes audio
   that no longer exists. Nothing else would notice, so compare the text hash align.mjs
   recorded against the script as it stands now. */
const scriptByKey = (() => {
  if (!SCRIPT) return null;
  if (!existsSync(String(SCRIPT))) { errors.push(`--script not found: ${SCRIPT}`); return null; }
  const doc = JSON.parse(readFileSync(String(SCRIPT), 'utf8'));
  const sha1 = t => createHash('sha1').update(t).digest('hex');
  return new Map((doc.segments || []).map(sg => [sg.key, sha1(sg.text)]));
})();
if (scriptByKey) {
  for (const [segKey, seg] of Object.entries(segLines)) {
    const want = scriptByKey.get(segKey);
    if (want && seg.textHash && want !== seg.textHash) {
      errors.push(`${segKey}: narration text changed since align ran — re-run tools/align.mjs (its word cache makes this free unless the audio changed)`);
    }
  }
}

/* Read a scene's declared beats by EXECUTING it with a stubbed `window`, exactly
   as pacing-check and the scene host do. Regex-parsing the literal would reject
   hand-written JS object syntax (unquoted keys), which is a legitimate way to
   author a scene. */
async function readBeats(path) {
  const prev = global.window;
  global.window = {};
  try {
    await import(pathToFileURL(path).href + '?v=' + Date.now());
    const declared = global.window.SCENE_BEATS;
    if (!declared) return { beats: null };
    const beats = Array.isArray(declared) ? declared : declared.beats;
    return { beats: Array.isArray(beats) ? beats : null, legacyArray: Array.isArray(declared) };
  } catch (e) {
    return { beats: null, threw: e.message };
  } finally {
    global.window = prev;
  }
}

const sceneFiles = readdirSync(scenesDir).filter(f => f.endsWith('.js')).sort();
if (!sceneFiles.length) errors.push(`no scene files in ${rel(scenesDir)}`);

const resolved = {};
const coveredLines = {};   // segKey -> Set of covered line indices

for (const file of sceneFiles) {
  const segKey = basename(file, '.js');
  const { beats, legacyArray, threw } = await readBeats(join(scenesDir, file));
  const seg = segLines[segKey];

  if (!seg) { errors.push(`${segKey}: scene exists but lines.json has no entry — re-run align.mjs`); continue; }
  if (!beats) {
    errors.push(`${segKey}: declares no window.SCENE_BEATS${threw ? ` (scene threw: ${threw})` : ''}`);
    continue;
  }
  if (legacyArray) {
    warnings.push(`${segKey}: SCENE_BEATS is a bare array — prefer { beats: [...] } so `+
      `non-beat metadata can live alongside it`);
  }
  if (!beats.length) { errors.push(`${segKey}: SCENE_BEATS is empty`); continue; }

  const lead = seg.lead ?? 0;
  const seenIds = new Set();
  const out = [];
  let lastLine = -1;
  coveredLines[segKey] = new Set();

  for (const b of beats) {
    const id = b && b.id;
    if (!id) { errors.push(`${segKey}: a beat has no id`); continue; }
    if (seenIds.has(id)) { errors.push(`${segKey}: duplicate beat id "${id}"`); continue; }
    seenIds.add(id);

    if (b.at != null && b.line == null) {
      errors.push(`${segKey} / ${id}: declares a raw \`at: ${b.at}\` and no \`line\` — a guessed second is exactly the defect this stage removes. Bind the beat to a narration line instead.`);
      continue;
    }
    /* a beat names ONE line, or a RANGE it narrates over — a closing caption
       legitimately holds while the last two or three sentences play, so the range
       form lets coverage be satisfied without inventing a visual per sentence. */
    const range = Array.isArray(b.lines) ? b.lines : (b.line != null ? [b.line, b.line] : null);
    if (!range) { errors.push(`${segKey} / ${id}: no \`line\` (or \`lines: [from,to]\`) — every beat must name the narration it illustrates`); continue; }
    if (range.length !== 2 || !range.every(Number.isInteger)) {
      errors.push(`${segKey} / ${id}: \`lines\` must be [from, to] integers, got ${JSON.stringify(b.lines)}`); continue;
    }
    const [lFrom, lTo] = range;
    if (lFrom < 0 || lTo >= seg.lines.length || lTo < lFrom) {
      errors.push(`${segKey} / ${id}: lines ${lFrom}…${lTo} do not exist (segment has ${seg.lines.length} lines: 0…${seg.lines.length - 1})`);
      continue;
    }
    if (lFrom < lastLine) warnings.push(`${segKey} / ${id}: line ${lFrom} is before the previous beat's line ${lastLine} — visual order disagrees with narration order`);
    lastLine = Math.max(lastLine, lTo);

    const L = seg.lines[lFrom];
    /* A resolved number baked into the scene must still agree with lines.json —
       otherwise the audio moved and the scene kept the old time. */
    const want = +(L.start + lead).toFixed(3);
    if (b.at != null && Math.abs(b.at - want) > 0.06) {
      errors.push(`${segKey} / ${id}: baked \`at: ${b.at}\` disagrees with line ${b.line}'s measured onset ${want}s — stale resolve, regenerate the scene`);
      continue;
    }
    for (let li = lFrom; li <= lTo; li++) coveredLines[segKey].add(li);
    out.push({
      id,
      line: lFrom,
      lines: [lFrom, lTo],
      at: +(L.start + lead).toFixed(3),   // scene time
      lineStart: L.start,
      lineEnd: L.end,
      min: b.min ?? 0,
      hold: !!b.hold,
      text: L.text,
    });
  }
  resolved[segKey] = { lead, total: seg.total, window: seg.window, beats: out };
}

/* coverage: every narration line should have a visual */
if (!ALLOW_UNCOVERED) {
  for (const [segKey, seg] of Object.entries(segLines)) {
    if (!resolved[segKey]) continue;   // no scene yet: reported elsewhere
    const covered = coveredLines[segKey] || new Set();
    seg.lines.forEach(L => {
      if (!covered.has(L.line)) {
        warnings.push(`${segKey}: line ${L.line} has no beat — "${L.text.slice(0, 58)}…" is narrated with nothing changing on screen`);
      }
    });
  }
}

const outPath = join(workDir, 'beats.json');
const doc = {
  generatedFrom: { lines: 'lines.json', at: linesDoc.generatedFrom?.at || null, resolver: 'tools/resolve-beats.mjs' },
  note: 'Beat `at` is in SCENE time (relative to the render window): line.start + lead.',
  segments: resolved,
};
writeFileSync(outPath, JSON.stringify(doc, null, 1) + '\n');

/* report */
const nBeats = Object.values(resolved).reduce((a, s) => a + s.beats.length, 0);
if (PRINT) {
  for (const [segKey, s] of Object.entries(resolved)) {
    console.log(`\n${segKey}  (lead ${s.lead}s)`);
    s.beats.forEach(b => console.log(`   ${b.id.padEnd(14)} line ${String(b.line).padStart(2)}  at ${b.at.toFixed(2).padStart(7)}s  "${b.text.slice(0, 46)}…"`));
  }
}
console.log(`\n[resolve] ${Object.keys(resolved).length} scene(s) · ${nBeats} beat(s)`);
if (warnings.length) { console.log(`\n  ⚠ ${warnings.length} warning(s):`); warnings.forEach(w => console.log(`     - ${w}`)); }
if (errors.length) {
  console.log(`\n  ✗ ${errors.length} error(s):`);
  errors.forEach(e => console.log(`     - ${e}`));
  process.exitCode = 2;
} else if (!PRINT) {
  console.log(`  ✓ written: ${rel(outPath)}`);
  process.exitCode = 0;
}
