#!/usr/bin/env node
/* =============================================================================
   script-check.mjs — validate a narration script before it costs anything.

   The script writer is the AGENT (judgment). This tool is CODE (exactness), and
   it enforces the same discipline the planner does for coverage:

     1. STRUCTURE   unique scene keys, non-empty narration, a style per segment
     2. SPEAKABILITY no markdown, no URLs, no code syntax — this is read aloud
     3. BUDGET      estimated narration + video duration vs the plan's target
     4. COVERAGE    every source section the plan assigned must be narrated

   Duration is ESTIMATED here, never trusted: the real number comes from measuring
   the generated audio downstream.

   Usage:
     node tools/script-check.mjs --script out/<name>/scripts/NN-<slug>.json \
                                 [--plan out/<name>/plan.enriched.json] [--max-min 14]
   ========================================================================== */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { WPM as DEFAULT_WPM, EXPANSION as DEFAULT_EXPANSION } from './model.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};

/* same cost model as the planner, so the two are comparable */
const WPM = parseFloat(flag('wpm', DEFAULT_WPM));
const EXPANSION = parseFloat(flag('expansion', DEFAULT_EXPANSION));
const MAX_MIN = parseFloat(flag('max-min', '14'));
const MIN_FILL = parseFloat(flag('min-fill', '0.55'));   // script must reach 55% of target

const scriptPath = flag('script');
const planPath = flag('plan');
if (!scriptPath) {
  console.error('usage: node tools/script-check.mjs --script <script.json> [--plan plan.enriched.json]');
  process.exit(1);
}
if (!existsSync(scriptPath)) { console.error('not found: ' + scriptPath); process.exit(1); }

const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
const errors = [];
const warnings = [];

/* ---------------- helpers ---------------- */
const words = s => String(s || '').split(/\s+/).filter(Boolean).length;
const narrationMin = w => (w / WPM);
const videoMin = w => (w / WPM) * EXPANSION;

/* ---------------- 1. structure ---------------- */
if (!script.videoIndex && script.videoIndex !== 0) errors.push('missing videoIndex');
if (!script.title) errors.push('missing title');
if (!Array.isArray(script.segments) || !script.segments.length) errors.push('no segments');

const seen = new Set();
(script.segments || []).forEach((s, i) => {
  const at = `segment ${i + 1}${s.key ? ` (${s.key})` : ''}`;
  if (!s.key) errors.push(`${at}: missing key`);
  else if (seen.has(s.key)) errors.push(`${at}: duplicate key "${s.key}"`);
  else seen.add(s.key);

  if (!s.text || !String(s.text).trim()) errors.push(`${at}: empty narration`);
  if (!s.style) warnings.push(`${at}: no style — TTS will fall back to a generic delivery`);
  if (!s.visual) warnings.push(`${at}: no visual hint — the scene stage will have to guess`);
  if (!Array.isArray(s.covers) || !s.covers.length) warnings.push(`${at}: does not declare what it covers`);
});

/* ---------------- 2. speakability ---------------- */
(script.segments || []).forEach((s, i) => {
  const t = String(s.text || '');
  const at = `segment ${i + 1} (${s.key})`;
  if (/https?:\/\//.test(t)) errors.push(`${at}: contains a URL — not speakable`);
  if (/[*_`#>]|\|\s*-{2,}/.test(t)) errors.push(`${at}: contains markdown syntax`);
  if (/[{}();=]|=>|\bdef \b|\bclass \w+\(/.test(t)) warnings.push(`${at}: looks like code in the narration`);
  if (/\b[A-Z]{3,}\b/.test(t)) {
    const acronyms = t.match(/\b[A-Z]{3,}\b/g);
    if (acronyms) warnings.push(`${at}: acronym(s) ${[...new Set(acronyms)].join(', ')} — TTS may spell them out`);
  }
  if (words(t) > 130) warnings.push(`${at}: ${words(t)} words in one breath — consider splitting`);
});

/* ---------------- 3. budget ---------------- */
const totalWords = (script.segments || []).reduce((a, s) => a + words(s.text), 0);
const estNarr = narrationMin(totalWords);
const estVideo = videoMin(totalWords);
const target = script.planTargetMinutes;

if (estVideo > MAX_MIN) errors.push(`estimated ${estVideo.toFixed(1)} min exceeds the ${MAX_MIN} min cap`);
if (target && estVideo < target * MIN_FILL) {
  errors.push(`estimated ${estVideo.toFixed(1)} min is under ${(MIN_FILL * 100) | 0}% of the ${target} min target — content likely missing`);
}
if (target && estVideo > target * 1.25) {
  warnings.push(`estimated ${estVideo.toFixed(1)} min is over 125% of the ${target} min target`);
}

/* ---------------- 4. coverage vs the plan ---------------- */
let coverageLine = null;
if (planPath && existsSync(planPath)) {
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const video = plan.videos.find(v => v.index === script.videoIndex);
  if (!video) {
    warnings.push(`video ${script.videoIndex} not found in the plan — skipping coverage check`);
  } else {
    const assigned = new Set(video.sections);
    const covered = new Set((script.segments || []).flatMap(s => s.covers || []));
    const missing = [...assigned].filter(x => !covered.has(x));
    const extra = [...covered].filter(x => !assigned.has(x));
    missing.forEach(m => errors.push(`UNCOVERED source section: ${m}`));
    extra.forEach(x => warnings.push(`covers a section not assigned to this video: ${x}`));
    coverageLine = `${covered.size}/${assigned.size} assigned sections covered`;
  }
}

/* ---------------- report ---------------- */
const name = basename(scriptPath);
console.log(`\n${name}`);
console.log('─'.repeat(Math.min(72, name.length + 20)));
console.log(`  title        : ${script.title || '(none)'}`);
console.log(`  form         : ${script.form || '(unset)'}`);
console.log(`  segments     : ${(script.segments || []).length}`);
console.log(`  words        : ${totalWords}`);
console.log(`  narration    : ${estNarr.toFixed(1)} min  (at ${WPM} wpm)`);
console.log(`  est. video   : ${estVideo.toFixed(1)} min  (×${EXPANSION} visual overhead)`);
if (target) console.log(`  plan target  : ${target} min  →  ${((estVideo / target) * 100).toFixed(0)}% of target`);
if (coverageLine) console.log(`  coverage     : ${coverageLine}`);
if (warnings.length) {
  console.log(`\n  ⚠ ${warnings.length} warning(s):`);
  warnings.forEach(w => console.log(`     - ${w}`));
}
if (errors.length) {
  console.log(`\n  ✗ ${errors.length} error(s):`);
  errors.forEach(e => console.log(`     - ${e}`));
} else {
  console.log('\n  ✓ script is valid');
}
process.exitCode = errors.length ? 2 : 0;
