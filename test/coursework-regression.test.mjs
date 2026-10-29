// The shared coursework tools take two one-line generalizations for code plans (design §5.5): apply-enrichment reads
// `plan.forms` and timing-report groups by `video.group`. A coursework plan sets neither, so its outputs must stay
// byte-identical. The goldens were recorded with the tools as they were before the change (UPDATE_GOLDENS=1).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, scratch, cleanup } from './helpers.mjs';

const TOOLS = join(ROOT, 'skills', 'explainer-video-from-coursework', 'tools');
const FX = join(ROOT, 'skills', 'explainer-video-from-coursework', 'fixtures', 'regression');
const GOLDEN = join(FX, 'expected.json');
const TMP = scratch();
after(() => cleanup(TMP));
const sha = f => createHash('sha256').update(readFileSync(f)).digest('hex');
let n = 0;
// run a tool from a fresh copy of the fixture, cwd inside it, so every path it records is relative and stable
const runIn = (files, tool, args) => {
  const dir = join(TMP, `run${n++}`);
  for (const [to, from] of Object.entries(files)) cpSync(from, join(dir, to));
  const r = spawnSync(process.execPath, [join(TOOLS, tool), ...args], { cwd: dir, encoding: 'utf8' });
  return { dir, status: r.status, stdout: r.stdout };
};
const hashes = (dir, names) => Object.fromEntries(names.map(f => [f, existsSync(join(dir, f)) ? sha(join(dir, f)) : null]));

const enrich = (enrichment) => runIn({ 'plan.json': join(FX, 'plan.json'), 'enrichment.json': join(FX, enrichment) }, 'apply-enrichment.mjs', ['--plan', 'plan.json', '--enrichment', 'enrichment.json']);
const ok = enrich('enrichment.json');
const codeForm = enrich('enrichment-code-form.json');
const timing = runIn({ 'plan.enriched.json': join(ok.dir, 'plan.enriched.json'), 'timing.jsonl': join(FX, 'timing.jsonl') }, 'timing-report.mjs', ['--out', '.']);
const observed = {
  'apply-enrichment': { status: ok.status, ...hashes(ok.dir, ['plan.enriched.json', 'plan.enriched.md']) },
  'apply-enrichment, a code-flow form on a coursework plan': { status: codeForm.status, ...hashes(codeForm.dir, ['plan.enriched.json', 'plan.enriched.md']) },
  'timing-report': { status: timing.status, ...hashes(timing.dir, ['timing.csv', 'timing.md', 'timing.svg', 'timing.html']) },
};
if (process.env.UPDATE_GOLDENS) writeFileSync(GOLDEN, JSON.stringify(observed, null, 2) + '\n');

test('coursework apply-enrichment output is byte-identical', () => {
  assert.deepEqual(observed['apply-enrichment'], JSON.parse(readFileSync(GOLDEN, 'utf8'))['apply-enrichment']);
});

test('a coursework plan still rejects the code-flow forms, with byte-identical output', () => {
  assert.equal(codeForm.status, 2);
  assert.match(codeForm.stdout, /form "flow" not in \[concept, diagram, code, refactor, catalogue\]/);
  assert.deepEqual(observed['apply-enrichment, a code-flow form on a coursework plan'], JSON.parse(readFileSync(GOLDEN, 'utf8'))['apply-enrichment, a code-flow form on a coursework plan']);
});

test('coursework timing-report outputs are byte-identical, grouped by module', () => {
  assert.equal(timing.status, 0);
  assert.match(readFileSync(join(timing.dir, 'timing.html'), 'utf8'), /Queues/);
  assert.deepEqual(observed['timing-report'], JSON.parse(readFileSync(GOLDEN, 'utf8'))['timing-report']);
});
