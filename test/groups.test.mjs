// Every file is put in exactly one group by ordered rules, first match wins; content signals only reclassify a
// file the path rules left in prod; a --group override wins over everything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { FIXTURES, mine, gitRepo, git, cleanup } from './helpers.mjs';
import { globToRegExp, classifyFile, parseOverrides } from '../skills/explainer-video-from-codebase/tools/lib/groups.mjs';

const POLYGLOT = join(FIXTURES, 'polyglot');
const EXPECTED = {
  prod: ['backend/app.py', 'backend/imports.py', 'backend/search.py', 'cmd/server/main.go', 'frontend/src/App.tsx', 'frontend/src/api/catalog.ts',
    'frontend/src/pages/ImportPage.tsx', 'frontend/src/pages/JobPage.tsx', 'frontend/src/pages/SearchPage.tsx', 'frontend/src/routes.tsx'],
  test: ['backend/conftest.py', 'backend/selfcheck.py', 'backend/test/legacy.py', 'backend/test_app.py', 'backend/test_utils.py', 'backend/tests/helpers.py',
    'backend/thing_test.py', 'backend/verification/test_connections.py', 'cmd/server/main_test.go', 'frontend/src/App.test.tsx', 'frontend/src/__tests__/util.ts',
    'frontend/src/api/catalog.test.ts', 'frontend/src/pages/ImportPage.test.tsx'],
  eval: ['backend/bench/quick.py', 'backend/benchmarks/bench_search.py', 'backend/evals/run_eval.py', 'backend/evals_data/load.py',
    'backend/evaluation/score.py', 'backend/finetune.py', 'backend/rag_quality.py', 'backend/search_evals/case.py'],
  dev: ['backend/alembic/env.py', 'backend/db/migration_controller.py', 'backend/debug/dump.py', 'backend/debug_cache.py', 'backend/dev/tool.py',
    'backend/dev_setup/boot.py', 'backend/diagnose_queue.py', 'backend/migrations/0001_init.py', 'backend/routers/dev.py', 'backend/scripts/seed.py',
    'backend/verification/check.py'],
};

const r = mine(POLYGLOT);
const groupOf = Object.fromEntries(r.codemap.files.map(f => [f.path, f.group]));
const ruleOf = Object.fromEntries(r.codemap.files.map(f => [f.path, f.rule]));

test('every file lands in its expected group', () => {
  assert.equal(r.status, 0, r.stderr);
  for (const [g, files] of Object.entries(EXPECTED)) for (const f of files) assert.equal(groupOf[f], g, f);
  assert.equal(r.codemap.files.length, Object.values(EXPECTED).flat().length, 'every file is listed, none twice');
});

test('first match wins: a test_*.py under verification/ is a test file, not dev', () => {
  assert.match(ruleOf['backend/verification/test_connections.py'], /^test:/);
});

test('content signals reclassify only files the path rules left in prod', () => {
  assert.match(ruleOf['backend/selfcheck.py'], /content: imports pytest/);
  assert.match(ruleOf['backend/rag_quality.py'], /content: imports an eval framework/);
  assert.match(ruleOf['backend/finetune.py'], /content: training-loop markers/);
  assert.equal(ruleOf['backend/app.py'], 'prod: everything else');
});

test('Go files are grouped and listed but not mined yet; TypeScript is mined', () => {
  assert.deepEqual(r.codemap.unsupported, { files: 2, byExt: { '.go': 2 } });
  assert.equal(r.codemap.symbols.filter(s => s.file.endsWith('.go')).length, 0);
  assert.deepEqual(r.codemap.languages.typescript, { files: 10, parseErrors: 0 });
});

test('an entry that lands in the test group is reported with the override that would move it', () => {
  assert.deepEqual(r.codemap.entries.filter(e => e.group === 'test').map(e => [e.id, e.group]), [['backend.verification.test_connections:<main>', 'test']]);
  assert.match(r.md, /Entries in the test group[\s\S]*--group 'backend\/verification\/test_connections.py=dev'/);
});

test('a --group override wins over every rule and is recorded', () => {
  const o = mine(POLYGLOT, '--group', 'backend/verification/**=dev');
  const f = o.codemap.files.find(x => x.path === 'backend/verification/test_connections.py');
  assert.deepEqual([f.group, f.rule], ['dev', 'override: backend/verification/**=dev']);
  assert.equal(o.codemap.entries.find(e => e.id === 'backend.verification.test_connections:<main>').group, 'dev');
  assert.deepEqual(o.codemap.groups.overrides, ['backend/verification/**=dev']);
});

test('a JS/TS file outside any eval dir that imports an eval framework is an eval file; one that imports none stays prod', () => {
  const repo = gitRepo();
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'quality.ts'), "import { evalite } from 'evalite';\nexport const run = () => evalite;\n");
  writeFileSync(join(repo, 'src', 'scorer.js'), "const { Factuality } = require('autoevals');\nmodule.exports = Factuality;\n");
  writeFileSync(join(repo, 'src', 'app.ts'), "import express from 'express';\nexport const app = express();\n");
  git(repo, 'add', '-A');
  const m = mine(repo);
  cleanup(dirname(repo));
  assert.equal(m.status, 0, m.stderr);
  const by = Object.fromEntries(m.codemap.files.map(f => [f.path, [f.group, f.rule]]));
  assert.deepEqual(by['src/quality.ts'], ['eval', 'content: imports an eval framework']);
  assert.deepEqual(by['src/scorer.js'], ['eval', 'content: imports an eval framework']);
  assert.deepEqual(by['src/app.ts'], ['prod', 'prod: everything else']);
});

test('globs: ** crosses directories, * does not, a slash-free pattern matches at any depth', () => {
  assert.ok(globToRegExp('a/**/x.py').test('a/b/c/x.py'));
  assert.ok(globToRegExp('a/**/x.py').test('a/x.py'));
  assert.ok(!globToRegExp('a/*.py').test('a/b/x.py'));
  assert.ok(globToRegExp('*.gen.py').test('deep/dir/m.gen.py'));
  assert.equal(classifyFile('tests/x.py', parseOverrides(['tests/**=prod']), null).group, 'prod');
  assert.throws(() => parseOverrides(['tests/**=staging']), /expected 'glob=prod\|test\|eval\|dev'/);
});
