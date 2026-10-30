// trace.mjs for JavaScript / TypeScript: which runner commands are recognised, how a run's TAP or jest/vitest JSON
// report and its V8 coverage map onto the code map (per test file, by position, source map or name), and, where this
// platform's sandbox starts, node --test on fixtures/trace-js end to end. Set FM_TRACE_REQUIRE_SANDBOX=1 to fail
// instead of skipping (the CI trace job does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { FIXTURES, scratch, cleanup, tool, git, gitRepo, assertGolden } from './helpers.mjs';
import { sandboxWorks } from '../skills/explainer-video-from-codebase/tools/lib/sandbox.mjs';
import { recogniseJs, jsTestFiles, fileArgv } from '../skills/explainer-video-from-codebase/tools/lib/trace-js.mjs';
import { parseTap, parseJestJson, functionsRan, observeV8, decodeMappings } from '../skills/explainer-video-from-codebase/tools/lib/observe-v8.mjs';

const REPO = join(FIXTURES, 'trace-js');
const OPT_IN = '--i-ran-this-by-the-user';
const KIND = { darwin: 'macos', linux: 'bwrap' }[process.platform];
const works = KIND ? sandboxWorks(KIND) : { ok: false, why: `no sandbox on ${process.platform}` };
const unavailable = !works.ok ? `no OS sandbox here: ${works.why}` : false;
const skip = process.env.FM_TRACE_REQUIRE_SANDBOX === '1' ? false : unavailable;
if (process.env.FM_TRACE_REQUIRE_SANDBOX === '1') test('the sandbox is available (FM_TRACE_REQUIRE_SANDBOX=1)', () => assert.equal(unavailable, false, unavailable));

const files = dir => readdirSync(dir, { recursive: true }).map(String).sort();

/* ---------------- recognition and refusals: every platform ---------------- */

test('recognised: node --test, npx jest, npx vitest and the repo\'s own bins, with their arguments', () => {
  const r = cmd => recogniseJs(cmd.split(' '));
  assert.deepEqual(r('node --test'), { runner: 'node-test', args: [] });
  assert.deepEqual(r('node --test --test-name-pattern=cart test/'), { runner: 'node-test', args: ['--test-name-pattern=cart', 'test/'] });
  assert.deepEqual(r('npx jest src/cart'), { runner: 'jest', args: ['src/cart'] });
  assert.deepEqual(r('npx vitest run --silent'), { runner: 'vitest', args: ['--silent'] });
  assert.deepEqual(r('node_modules/.bin/jest'), { runner: 'jest', args: [] });
  assert.deepEqual(r('vitest'), { runner: 'vitest', args: [] });
});

test('refused: npx flags (they can install), watch modes, the flags the trace sets itself, any other node program', () => {
  for (const cmd of ['npx -y jest', 'npx --yes vitest', 'npx jest --watch', 'npx jest --coverage', 'npx vitest watch', 'npx vitest --reporter=dot',
    'node --test --require ./x.cjs', 'node --test --import ./x.mjs', 'node server.js', 'node -e 1', 'npx mocha', 'npm test', 'yarn jest', 'tools/jest'])
    assert.equal(recogniseJs(cmd.split(' ')), null, cmd);
  for (const cmd of ['npx -y jest', 'node server.js', 'npm test', 'node --test; curl example.com', 'npx jest && rm -rf x']) {
    const r = tool('trace.mjs', '--codemap', 'x.json', '--test-command', cmd, OPT_IN);
    assert.equal(r.status, 3, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /not a recognised test command/);
  }
});

test('each runner runs the code map\'s test files that match its own pattern, under the paths given', () => {
  const m = { tests: ['test/a.test.mjs', 'src/__tests__/b.ts', 'src/c.spec.tsx', 'tests/d.py', 'test/helper.mjs'].map(file => ({ file })) };
  assert.deepEqual(jsTestFiles(m, 'node-test', []), ['test/a.test.mjs', 'test/helper.mjs']);
  assert.deepEqual(jsTestFiles(m, 'jest', []), ['src/__tests__/b.ts', 'src/c.spec.tsx']);
  assert.deepEqual(jsTestFiles(m, 'vitest', ['src']), ['src/c.spec.tsx']);
  assert.deepEqual(fileArgv({ runner: 'vitest', node: 'node', bin: { rel: 'node_modules/.bin/vitest', node: true }, flags: [], file: 'a.test.ts', report: 'r.json' }),
    ['node', 'node_modules/.bin/vitest', 'run', '--reporter=json', '--outputFile=r.json', '--pool=threads', 'a.test.ts']);
});

/* ---------------- reports ---------------- */

test('parseTap: nested suites give a test its describe path; a suite is no test; a failure keeps its error', () => {
  const tap = ['TAP version 13', '# Subtest: Cart', '    # Subtest: adds', '    ok 1 - adds', '      ---', "      type: 'test'", '      ...',
    '    # Subtest: inner', '        # Subtest: fails\\: here', '        not ok 1 - fails\\: here', '          ---', "          type: 'test'",
    '          error: |-', '            Expected 1 to be 2', '          code: ERR', '          ...', '        # Subtest: later', '        ok 2 - later # SKIP',
    '        1..2', '    not ok 2 - inner', '      ---', "      type: 'suite'", "      failureType: 'subtestsFailed'", '      ...', '    1..2',
    'not ok 1 - Cart', '  ---', "  type: 'suite'", "  failureType: 'subtestsFailed'", '  ...', '# Subtest: top', 'ok 2 - top', '1..2'].join('\n');
  assert.deepEqual(parseTap(tap), { tests: [
    { titles: ['Cart', 'adds'], status: 'passed', message: '' },
    { titles: ['Cart', 'inner', 'fails: here'], status: 'failed', message: 'Expected 1 to be 2' },
    { titles: ['Cart', 'inner', 'later'], status: 'skipped', message: '' },
    { titles: ['top'], status: 'passed', message: '' }], suiteErrors: [] });
});

test('parseJestJson: jest and vitest JSON, per assertion; a suite that failed with no failing test is an error', () => {
  const json = { testResults: [
    { name: '/s/repo/test/a.test.js', status: 'failed', message: '● ping', assertionResults: [
      { ancestorTitles: ['Cart'], title: 'totals', status: 'passed', failureMessages: [] },
      { ancestorTitles: [], title: 'ping', status: 'failed', failureMessages: ['Error: connect ECONNREFUSED 127.0.0.1:6379'] },
      { ancestorTitles: [], title: 'later', status: 'pending', failureMessages: [] }] },
    { name: '/s/repo/test/b.test.js', status: 'failed', message: 'Cannot find module ./gone', assertionResults: [] }] };
  assert.deepEqual(parseJestJson(json, '/s/repo'), {
    tests: [{ file: 'test/a.test.js', titles: ['Cart', 'totals'], status: 'passed', message: '' },
      { file: 'test/a.test.js', titles: ['ping'], status: 'failed', message: 'Error: connect ECONNREFUSED 127.0.0.1:6379' },
      { file: 'test/a.test.js', titles: ['later'], status: 'skipped', message: '' }],
    suiteErrors: [{ file: 'test/b.test.js', message: 'Cannot find module ./gone' }] });
});

/* ---------------- coverage onto the code map ---------------- */

const TEXT = 'export function a() {\n  return 1;\n}\nexport const b = () => a();\nexport class K {\n  constructor() {}\n  m() { return b(); }\n}\n';
const SYMS = [{ id: 'f.mjs:a', name: 'a', kind: 'function', file: 'f.mjs', start: 1 }, { id: 'f.mjs:b', name: 'b', kind: 'function', file: 'f.mjs', start: 4 },
  { id: 'f.mjs:K', name: 'K', kind: 'class', file: 'f.mjs', start: 5 }, { id: 'f.mjs:K.constructor', name: 'constructor', kind: 'method', file: 'f.mjs', start: 6, cls: 'f.mjs:K' },
  { id: 'f.mjs:K.m', name: 'm', kind: 'method', file: 'f.mjs', start: 7, cls: 'f.mjs:K' }];
const fn = (functionName, startOffset, endOffset, count = 1) => ({ functionName, ranges: [{ startOffset, endOffset, count }] });
const dumpOf = (len, functions, extra = {}) => ({ result: [{ url: 'file:///r/f.mjs', functions: [fn('', 0, len), ...functions] }], ...extra });
const at = s => TEXT.indexOf(s);

test('functionsRan: by position when the script is the file, or the file plus an appended comment; a constructor runs under its class name', () => {
  const m = { symbols: SYMS };
  const fns = [fn('a', at('function a'), at('}\nexport const')), fn('b', at('() => a()'), at(';\nexport class')), fn('K', at('constructor'), at('\n  m()')),
    fn('m', at('m()'), at('\n}\n') + 1, 0), fn('', at('() => a()'), at(';\nexport class'))];
  assert.deepEqual([...functionsRan(m, dumpOf(TEXT.length, fns), '/r', () => TEXT).ran].sort(), ['f.mjs:K.constructor', 'f.mjs:a', 'f.mjs:b'], 'm never ran (count 0)');
  assert.deepEqual([...functionsRan(m, dumpOf(TEXT.length + 90, fns), '/r', () => TEXT).ran].sort(), ['f.mjs:K.constructor', 'f.mjs:a', 'f.mjs:b'], 'types stripped in place, a sourceURL appended');
});

test('functionsRan: in transformed code, by a name only one symbol of the file has; through a source map when Node recorded one', () => {
  const m = { symbols: SYMS };
  const r = functionsRan(m, dumpOf(900, [fn('a', 400, 420), fn('m', 500, 520), fn('', 600, 620), fn('_helper', 700, 720)]), '/r', () => TEXT);
  assert.deepEqual([[...r.ran].sort(), r.unmapped, r.anonymous], [['f.mjs:K.m', 'f.mjs:a'], 1, 1]);
  // generated line 0 col 0 -> source line 4 (index 3); generated line 1 col 2 -> source line 7 (index 6)
  assert.deepEqual(decodeMappings('AAGA;EAGA'), [[[0, 0, 3, 0]], [[2, 0, 6, 0]]]);
  const smc = { 'file:///r/f.mjs': { lineLengths: [30, 30], data: { version: 3, sources: ['f.mjs'], mappings: 'AAGA;EAGA' } } };
  const s = functionsRan(m, dumpOf(61, [fn('', 1, 10), fn('', 33, 50)], { 'source-map-cache': smc }), '/r', () => TEXT);
  assert.deepEqual([...s.ran].sort(), ['f.mjs:K.m', 'f.mjs:b'], 'anonymous functions placed by their source lines');
});

test('observeV8: what ran is attributed to its test file; direct links count as observed when their target ran there; a network failure is denied', () => {
  const m = { symbols: [...SYMS, { id: 't.test.mjs:adds', name: 'adds', kind: 'function', file: 't.test.mjs', start: 1, group: 'test' }].map(s => ({ group: 'prod', ...s })),
    tests: [{ id: 't.test.mjs:adds', file: 't.test.mjs', direct: [{ to: 'f.mjs:a' }, { to: 'f.mjs:K.m' }] }, { id: 't.test.mjs:pings', file: 't.test.mjs', direct: [] }],
    fixtureBindings: [] };
  const runs = [{ file: 't.test.mjs', exitCode: 1, timedOut: false, network: ['connect 127.0.0.1:6379'],
    outcomes: { tests: [{ titles: ['adds'], status: 'passed', message: '' }, { titles: ['pings'], status: 'failed', message: 'Error: connect EPERM 127.0.0.1:6379' }], suiteErrors: [] },
    coverage: [dumpOf(TEXT.length, [fn('a', at('function a'), at('}\nexport const'))])] }];
  const o = observeV8(m, runs, { root: '/r', readFile: () => TEXT, node: 'v22' });
  assert.equal(o.granularity, 'test-file');
  assert.deepEqual(o.outcome, { collected: 2, passed: 1, failed: 1, errors: 0, skipped: 0, xfailed: 0, xpassed: 0 });
  assert.deepEqual(o.byTest['t.test.mjs:adds'].direct, { total: 2, observed: 1, missing: ['f.mjs:K.m'] });
  assert.deepEqual(o.ran, { 'f.mjs:a': ['t.test.mjs'] });
  assert.deepEqual(o.deniedBySandbox.map(d => [d.test, d.network, d.permission]), [['t.test.mjs:pings', ['connect 127.0.0.1:6379'], false]]);
  assert.deepEqual([o.pairs, o.edges], [[], []], 'coverage has no caller -> callee pairs: no edge is marked observed');
});

/* ---------------- end to end on fixtures/trace-js ---------------- */

const mineFixture = repo => {
  const out = join(scratch(), 'out');
  const r = tool('mine.mjs', repo, '--out', out);
  assert.equal(r.status, 0, r.stderr);
  return out;
};
const read = (out, f) => JSON.parse(readFileSync(join(out, f), 'utf8'));
const trace = (out, cmd, ...flags) => tool('trace.mjs', '--codemap', join(out, 'codemap.json'), '--test-command', cmd, OPT_IN, ...flags);

test('node --test on the fixture runs sandboxed, one run per test file: 4 pass, the socket test is denied', { skip }, () => {
  const repo = gitRepo(REPO), out = mineFixture(repo), before = files(repo), codemap = readFileSync(join(out, 'codemap.json'), 'utf8');
  const r = trace(out, 'node --test');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const t = read(out, 'trace.json');
  assert.deepEqual(files(repo), before, 'nothing is written inside the repo');
  assert.equal(readFileSync(join(out, 'codemap.json'), 'utf8'), codemap, 'the code map is never edited');
  assert.equal(t.optIn.command, 'node --test');
  assert.equal(t.runner, 'node-test');
  assert.deepEqual(t.ranFiles, t.files);
  assert.deepEqual(t.deniedBySandbox.map(d => [d.nodeid, d.network]), [['test/net.test.mjs::ping reaches the cache', ['connect 127.0.0.1:6379']]]);
  assert.equal(t.summary.unmappedFunctions, 0, 'every named function that ran is a code-map symbol');
  assertGolden('trace-js', { granularity: t.granularity, outcome: t.outcome, byFile: Object.fromEntries(Object.entries(t.byFile).map(([f, v]) => [f, v.ran.join(', ')])),
    byTest: Object.fromEntries(Object.entries(t.byTest).map(([k, v]) => [k, `${v.status}: ${v.direct.observed}/${v.direct.total}`])),
    directLinksPerTest: t.summary.directLinksPerTest, fixtureLinks: t.summary.fixtureLinks, functionsRan: t.summary.functionsRan });
  cleanup(dirname(repo)); cleanup(join(out, '..'));
});

test('the repo\'s node_modules is linked into the copy read-only: a test can import from it but not write to it', { skip }, () => {
  const repo = realpathSync(gitRepo(REPO));
  mkdirSync(join(repo, 'node_modules', 'pad'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'pad', 'package.json'), '{ "name": "pad", "main": "index.js" }');
  writeFileSync(join(repo, 'node_modules', 'pad', 'index.js'), "module.exports = s => '[' + s + ']';\n");
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  writeFileSync(join(repo, 'test', 'pad.test.mjs'), ["import { test } from 'node:test';", "import assert from 'node:assert/strict';", "import { writeFileSync } from 'node:fs';",
    "import pad from 'pad';", '', "test('pads from node_modules', () => { assert.equal(pad('x'), '[x]'); });", '',
    "test('cannot write into node_modules', () => { writeFileSync(new URL('../node_modules/pad/evil.js', import.meta.url), 'x'); });", ''].join('\n'));
  git(repo, 'add', '-A');
  const out = mineFixture(repo);
  const r = trace(out, 'node --test test/pad.test.mjs');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const t = read(out, 'trace.json');
  assert.deepEqual(Object.fromEntries(Object.entries(t.byTest).map(([k, v]) => [k.split(':').pop(), v.status])), { 'pads from node_modules': 'passed', 'cannot write into node_modules': 'failed' });
  assert.deepEqual(t.deniedBySandbox.map(d => [d.nodeid.split('::').pop(), d.permission]), [['cannot write into node_modules', true]]);
  assert.deepEqual(readdirSync(join(repo, 'node_modules', 'pad')).sort(), ['index.js', 'package.json']);
  cleanup(dirname(repo)); cleanup(join(out, '..'));
});

test('exit 1: npx jest is refused when the repo has no jest installed; tracing never installs one', { skip }, () => {
  const out = mineFixture(REPO);
  const r = trace(out, 'npx jest');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /jest is not installed in the repo .*never installs packages/);
  assert.deepEqual(readdirSync(out).sort(), ['codemap.json', 'codemap.md']);
  cleanup(join(out, '..'));
});

test('exit 2: no test file matches the runner\'s pattern under the paths given', { skip }, () => {
  const out = mineFixture(REPO);
  const r = trace(out, 'node --test nowhere/');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /no test file in the code map matches node-test/);
  cleanup(join(out, '..'));
});
