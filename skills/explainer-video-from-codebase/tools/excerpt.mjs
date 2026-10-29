#!/usr/bin/env node
/* =============================================================================
   excerpt.mjs — one code panel for a scene, cut from the repo as it was mined.

   Usage:
     node tools/excerpt.mjs --codemap out/<name>/codemap.json --symbol <id> [--lines a-b,…]
     node tools/excerpt.mjs --codemap out/<name>/codemap.json --symbol <id> --test <test id> [--lines a-b,…]

   Prints a panel fragment for scene-code.js (design §4.6):
     { file, lang, lines[], numbers[], elided[], source }
   `lines` are the file's lines, byte for byte; `numbers` their real line numbers.
   Narration is the reading time, so only narrated lines are shown: `--lines`
   ("54-65,70", inside the symbol's span) picks them, and every unshown run inside
   the span collapses into one elision marker ("⋯ 4 lines"), whose number is null
   and whose index is in `elided` ({at, from, to}). A run of blank lines is shown,
   not elided. Without `--lines` the whole span is shown.

   With --test, the panel is the test's side of a "pinned by" pair: the test's
   def line (its name, which the narration says), the line where it calls the hop
   (its direct link) and its assertion lines, elided between. The test must link
   to --symbol directly and must not mock it.

   `source` {file, symbol | test, start, end, sha256, fileSha256, commit} is what
   excerpt-check.mjs verifies the panel against: `sha256` is the shown span's
   (for a symbol, the code map's own), `fileSha256` the file's when mined.

   Exit: 0 ok · 1 bad flags or unreadable code map · 2 symbol or test missing, a
         line outside the span, a test that does not pin the symbol, the file
         changed since it was mined, or more than 22 shown lines
   ========================================================================== */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const fail = (code, msg) => { console.error(`[excerpt] ${msg}`); process.exit(code); };

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
const VALUED = new Set(['--codemap', '--symbol', '--lines', '--test']);
const flags = new Map();
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) { if (argv[i + 1] == null) fail(1, `${argv[i]} needs a value`); flags.set(argv[i], argv[++i]); }
  else fail(1, `unknown argument ${argv[i]}`);
}
if (!flags.has('--codemap') || !flags.has('--symbol')) fail(1, 'usage: excerpt.mjs --codemap out/<name>/codemap.json --symbol <id> [--lines a-b,…] [--test <test id>]');
const MAX = 22;
let m;
try { m = JSON.parse(readFileSync(resolve(flags.get('--codemap')), 'utf8')); } catch (e) { fail(1, `cannot read the code map: ${e.message}`); }
if (m?.schema !== 1 || !Array.isArray(m.symbols)) fail(1, 'not a mine.mjs code map (schema 1)');

const sha = t => createHash('sha256').update(t).digest('hex');
const symId = flags.get('--symbol'), testId = flags.get('--test');
const sym = m.symbols.find(s => s.id === symId);
if (!sym) fail(2, `no symbol ${symId} in the code map`);

/* ---------------- what span, which file ---------------- */
let span, shown, test = null;
if (testId) {
  test = (m.tests || []).find(t => t.id === testId);
  if (!test) fail(2, `no test ${testId} in the code map`);
  if (test.mocked.includes(symId)) fail(2, `test ${testId} mocks ${symId}: a test that replaces a hop cannot pin it`);
  const link = test.direct.find(l => l.to === symId);
  if (!link) fail(2, `test ${testId} has no direct link to ${symId}: only a direct, unmocked link may be shown as pinning it`);
  span = { file: test.file, start: test.line, end: test.end };
  // its name, the call line when it is in the test's own body (a fixture or helper calls from elsewhere), the assertions
  const call = link.line >= test.line && link.line <= test.end ? [link.line] : [];
  if (!call.length && !test.assertLines.length) fail(2, `test ${testId} has neither a call line nor an assertion line inside its body to show`);
  shown = [...new Set([test.line, ...call, ...test.assertLines])].sort((a, b) => a - b);
} else span = { file: sym.file, start: sym.start, end: sym.end };

const file = (m.files || []).find(f => f.path === span.file);
const path = join(m.root, span.file);
if (!file || !existsSync(path)) fail(2, `${span.file} is not in the mined repo at ${m.root}`);
const text = readFileSync(path, 'utf8');
if (sha(text) !== file.sha256) fail(2, `${span.file} changed since it was mined: re-mine before excerpting, so the panel shows the code the flow was built from`);
const all = text.split('\n');
const spanSha = sha(all.slice(span.start - 1, span.end).join('\n'));
if (!test && spanSha !== sym.sha256) fail(2, `${symId}'s span no longer matches the code map: re-mine`);

if (flags.has('--lines')) {
  shown = [];
  for (const part of flags.get('--lines').split(',')) {
    const r = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (!r) fail(1, `--lines takes ranges like "54-65,70", not "${part}"`);
    const a = Number(r[1]), b = Number(r[2] ?? r[1]);
    if (b < a || a < span.start || b > span.end) fail(2, `lines ${a}-${b} are outside ${testId || symId} (lines ${span.start}-${span.end} of ${span.file})`);
    for (let n = a; n <= b; n++) shown.push(n);
  }
  shown = [...new Set(shown)].sort((a, b) => a - b);
} else if (!test) shown = Array.from({ length: span.end - span.start + 1 }, (_, i) => span.start + i);

/* ---------------- lines, numbers, elision markers ---------------- */
const blank = n => !all[n - 1].trim();
const lines = [], numbers = [], elided = [];
const gap = (from, to) => {
  if (from > to) return;
  const hidden = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  if (hidden.every(blank)) { for (const n of hidden) { lines.push(all[n - 1]); numbers.push(n); } return; }
  // the marker sits at the hidden block's outer indent: its least-indented non-blank line
  const indent = hidden.filter(n => !blank(n)).map(n => /^\s*/.exec(all[n - 1])[0]).reduce((a, b) => (b.length < a.length ? b : a));
  elided.push({ at: lines.length, from, to });
  lines.push(`${indent}⋯ ${to - from + 1} line${to === from ? '' : 's'}`);
  numbers.push(null);
};
let prev = span.start - 1;
for (const n of shown) { gap(prev + 1, n - 1); lines.push(all[n - 1]); numbers.push(n); prev = n; }
gap(prev + 1, span.end);
const visible = numbers.filter(n => n != null).length;
if (visible > MAX) fail(2, `${visible} lines shown, over the ${MAX}-line cap: narrow them with --lines (only narrated lines belong on screen), or split the hop`);

const panel = {
  file: span.file, lang: file.lang, lines, numbers, elided,
  source: { file: span.file, ...(test ? { test: test.id, pins: symId, via: test.direct.find(l => l.to === symId).via } : { symbol: symId }),
    start: span.start, end: span.end, sha256: spanSha, fileSha256: file.sha256, commit: m.commit },
};
console.log(JSON.stringify(panel, null, 2));
