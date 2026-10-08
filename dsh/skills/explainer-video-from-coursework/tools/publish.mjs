#!/usr/bin/env node
/* =============================================================================
   publish.mjs — /publish stage (stage 6): chapters and captions.

   The agent writes out/<name>/<NN>/publish.json (chapters[] + blurb); this tool
   resolves each chapter's timecode from the measured windows, generates the SRT
   from narration/<key>.src, validates YouTube's chapter rules, and writes the two
   deliverables beside the MP4:

       description.md   — the blurb, then the chapter block, paste-ready plain text
       captions.srt     — one cue per segment, verbatim spoken text

   Usage:
     node tools/publish.mjs --work out/<name>/<NN> \
                            [--script out/<name>/scripts/<NN>-*.json] \
                            [--dest <destination>]
   ========================================================================== */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};

const WORK = flag('work');
const SCRIPT = flag('script', null);
const DEST = flag('dest', null);

if (!WORK) {
  console.error('usage: node tools/publish.mjs --work <work-dir> [--script <script.json>] [--dest <dir>]');
  process.exit(1);
}

const workDir = resolve(WORK);
const timelinePath = join(workDir, 'timeline.json');
const publishPath = join(workDir, 'publish.json');
if (!existsSync(timelinePath)) { console.error(`no timeline at ${timelinePath} — run build-audio first`); process.exit(1); }
if (!existsSync(publishPath)) { console.error(`no publish.json at ${publishPath} — write it first (chapters[] + blurb)`); process.exit(1); }

const tl = JSON.parse(readFileSync(timelinePath, 'utf8'));
const pub = JSON.parse(readFileSync(publishPath, 'utf8'));
const windows = tl.windows || {};
const segments = tl.segments || [];
const errors = [];
const warnings = [];

/* ---- formatting ---- */
const pad2 = n => String(n).padStart(2, '0');
const pad3 = n => String(n).padStart(3, '0');
const srtTs = sec => {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), milli = ms % 1000;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(milli)}`;
};
const chapterTs = sec => {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(ss)}` : `${m}:${pad2(ss)}`;
};
const normTitle = t => String(t).toLowerCase()
  .replace(/^(the|a|an)\s+/, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim().replace(/\s+/g, ' ');

/* ---- chapters: resolve + validate ---- */
const resolved = [];
const chapters = pub.chapters;
if (!Array.isArray(chapters) || chapters.length === 0) {
  errors.push('publish.json must contain a non-empty "chapters" array');
} else {
  if (chapters.length < 3) errors.push(`need at least 3 chapters (got ${chapters.length}) — YouTube ignores fewer`);

  chapters.forEach((ch, i) => {
    const at = `chapter ${i + 1}`;
    const keys = ch && ch.segments;
    const title = ch && ch.title;
    if (!Array.isArray(keys) || keys.length === 0) { errors.push(`${at}: "segments" must be a non-empty array of segment keys`); return; }
    keys.forEach(k => { if (!windows[k]) errors.push(`${at}: segment key "${k}" has no timeline window`); });
    const t = title == null ? '' : String(title).trim();
    if (!t) errors.push(`${at}: missing title`);
    else if (t.length > 40) errors.push(`${at}: title is ${t.length} chars (max 40)`);
    if (keys[0] && windows[keys[0]]) resolved.push({ i, title: t, start: windows[keys[0]].start });
  });

  if (resolved.length) {
    if (chapterTs(resolved[0].start) !== '0:00') {
      errors.push(`first chapter must start at 0:00 (got ${chapterTs(resolved[0].start)}) — anchor it to the first segment`);
    }
    for (let i = 1; i < resolved.length; i++) {
      if (resolved[i].start <= resolved[i - 1].start) errors.push(`chapter ${resolved[i].i + 1} starts at ${chapterTs(resolved[i].start)}, not after chapter ${resolved[i - 1].i + 1}`);
    }
    for (let i = 0; i < resolved.length; i++) {
      const end = i + 1 < resolved.length ? resolved[i + 1].start : tl.total;
      if (end - resolved[i].start < 10) errors.push(`chapter ${resolved[i].i + 1} ("${resolved[i].title}") is ${(end - resolved[i].start).toFixed(1)}s — each chapter must be ≥10s`);
    }
    const seen = new Map();
    resolved.forEach(r => {
      const n = normTitle(r.title);
      if (!n) return;
      if (seen.has(n)) errors.push(`chapters ${seen.get(n) + 1} and ${r.i + 1}: duplicate/near-duplicate title "${r.title}"`);
      else seen.set(n, r.i);
    });
  }
}

/* ---- captions: one cue per segment, verbatim from the audio ---- */
const cues = [];
segments.forEach(sg => {
  const srcPath = join(workDir, 'narration', `${sg.key}.src`);
  if (!existsSync(srcPath)) { errors.push(`segment "${sg.key}": missing narration/${sg.key}.src — cannot build its caption`); return; }
  const text = readFileSync(srcPath, 'utf8').replace(/\s+$/, '');
  cues.push({ key: sg.key, start: sg.start, end: sg.end, text });
});
for (let i = 1; i < cues.length; i++) {
  if (cues[i].start < cues[i - 1].end) errors.push(`captions overlap at "${cues[i].key}"`);
}

/* ---- optional cross-check against the script ---- */
if (SCRIPT) {
  const scriptPath = resolve(SCRIPT);
  if (!existsSync(scriptPath)) warnings.push(`--script not found: ${scriptPath}`);
  else {
    const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
    const scriptKeys = new Set((script.segments || []).map(s => s.key));
    segments.forEach(s => { if (!scriptKeys.has(s.key)) warnings.push(`timeline has segment "${s.key}" not present in the script`); });
    scriptKeys.forEach(k => { if (!windows[k]) warnings.push(`script has segment "${k}" with no timeline window`); });
  }
}

/* ---- report ---- */
const label = String(WORK).split('/').pop() || 'publish';
console.log(`\n${label}`);
console.log('─'.repeat(Math.min(60, label.length + 20)));
warnings.forEach(w => console.log(`  ⚠ ${w}`));
if (errors.length) {
  console.log(`\n  ✗ ${errors.length} error(s):`);
  errors.forEach(e => console.log(`     - ${e}`));
  process.exit(2);
}

/* ---- emit ---- */
const descLines = [];
if (pub.blurb && String(pub.blurb).trim()) descLines.push(String(pub.blurb).trim(), '');
resolved.forEach(r => descLines.push(`${chapterTs(r.start)} ${r.title}`));
const description = descLines.join('\n') + '\n';

const srt = cues.map((c, i) => `${i + 1}\n${srtTs(c.start)} --> ${srtTs(c.end)}\n${c.text}\n`).join('\n');

const descOut = join(workDir, 'description.md');
const srtOut = join(workDir, 'captions.srt');
writeFileSync(descOut, description);
writeFileSync(srtOut, srt);

console.log(`  chapters : ${resolved.length}  (${chapterTs(resolved[0].start)} → ${chapterTs(resolved[resolved.length - 1].start)})`);
console.log(`  captions : ${cues.length} cues  (${(tl.total).toFixed(1)}s of narration)`);
console.log(`\n[out] ${descOut}`);
console.log(`[out] ${srtOut}`);

if (DEST) {
  mkdirSync(DEST, { recursive: true });
  copyFileSync(descOut, join(DEST, 'description.md'));
  copyFileSync(srtOut, join(DEST, 'captions.srt'));
  console.log(`[dest] ${DEST}`);
}
