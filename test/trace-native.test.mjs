// trace.mjs for Go (go test, one run per test under -coverprofile) and C / C++ (the make test target built with
// coverage, read by gcov): which commands are recognised and refused, how their reports and coverage map onto the code
// map, and, where this platform's sandbox starts and the toolchain is installed, fixtures/trace-go and fixtures/trace-c
// end to end. Set FM_TRACE_REQUIRE_SANDBOX=1 to fail instead of skipping for a missing sandbox, and
// FM_TRACE_REQUIRE_TOOLCHAINS=1 for a missing go / cc / make / gcov (the CI trace job sets both).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, cpSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { FIXTURES, SKILL, scratch, cleanup, tool, gitRepo, assertGolden } from './helpers.mjs';
import { sandboxWorks, readRunFile, readRunJson } from '../skills/explainer-video-from-codebase/tools/lib/sandbox.mjs';
import { recogniseGo, goModuleDir, goTestsToRun, goTestArgv, parseGoTestJson, parseCoverProfile } from '../skills/explainer-video-from-codebase/tools/lib/trace-go.mjs';
import { recogniseMake, makeArgv, makefileShell, lineShape, parseGcov, parseCTestOutput } from '../skills/explainer-video-from-codebase/tools/lib/trace-c.mjs';
import { symbolsRan, linesToBlocks, observeCoverage } from '../skills/explainer-video-from-codebase/tools/lib/observe-coverage.mjs';

const OPT_IN = '--i-ran-this-by-the-user';
const KIND = { darwin: 'macos', linux: 'bwrap' }[process.platform];
const works = KIND ? sandboxWorks(KIND) : { ok: false, why: `no sandbox on ${process.platform}` };
const noSandbox = !works.ok ? `no OS sandbox here: ${works.why}` : false;
const has = cmd => spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
const missing = cmds => { const gone = cmds.filter(c => !has(c)); return gone.length ? `not installed here: ${gone.join(', ')}` : false; };
const requireSandbox = process.env.FM_TRACE_REQUIRE_SANDBOX === '1', requireTools = process.env.FM_TRACE_REQUIRE_TOOLCHAINS === '1';
const skipFor = cmds => (!requireSandbox && noSandbox) || (!requireTools && missing(cmds));
if (requireSandbox) test('the sandbox is available (FM_TRACE_REQUIRE_SANDBOX=1)', () => assert.equal(noSandbox, false, noSandbox));
if (requireTools) test('go, cc, make and gcov are installed (FM_TRACE_REQUIRE_TOOLCHAINS=1)', () => assert.equal(missing(['go', 'cc', 'make', 'gcov']), false));

/* ---------------- recognition and refusals: every platform ---------------- */

test('recognised: go test with the flags that only choose and run tests, go -C <dir> test; make test / check, make -C <dir> test', () => {
  const g = cmd => recogniseGo(cmd.split(' '));
  assert.deepEqual(g('go test ./...'), { runner: 'go-test', dir: '', flags: [], packages: ['./...'], run: null });
  assert.deepEqual(g('go test -run TestTotal -v -count=1 ./shop'), { runner: 'go-test', dir: '', flags: ['-v', '-count=1'], packages: ['./shop'], run: 'TestTotal' });
  assert.deepEqual(g('go -C services/inventory test -short ./...'), { runner: 'go-test', dir: 'services/inventory', flags: ['-short'], packages: ['./...'], run: null });
  assert.deepEqual(g('go test'), { runner: 'go-test', dir: '', flags: [], packages: ['.'], run: null });
  const mk = cmd => recogniseMake(cmd.split(' '));
  assert.deepEqual(mk('make test'), { runner: 'make', dir: '', target: 'test' });
  assert.deepEqual(mk('make -C native/isbn check'), { runner: 'make', dir: 'native/isbn', target: 'check' });
  assert.deepEqual(makeArgv({ make: 'make', dir: 'x', target: 'test', shell: '/s/fmtrace-sh' }), ['make', '-C', 'x', 'test', 'CC=cc --coverage', 'CXX=c++ --coverage', 'SHELL=/s/fmtrace-sh']);
  assert.deepEqual(['SHELL := /bin/bash\n.SHELLFLAGS := -eu -o pipefail -c\n', 'export SHELL = /usr/bin/env bash # recipes use [[\n', 'SHELL = $(shell which bash)\n', 'test:\n\tSHELL=x ./t\n', 'SHELL ?= zsh\n']
    .map(makefileShell), ['/bin/bash', '/usr/bin/env bash', null, null, null], 'the Makefile\'s own top-level SHELL, when it names one without make expanding it');
  assert.deepEqual(goTestArgv({ go: 'go', flags: ['-short'], name: 'TestA', profile: 'p.out', pkgDir: 'shop' }),
    ['go', 'test', '-json', '-count=1', '-run=^TestA$', '-coverprofile=p.out', '-coverpkg=./...', '-short', './shop']);
});

test('refused: flags the trace sets itself or that run another program, packages outside the module, any other go or make command', () => {
  for (const cmd of ['go test -exec x ./...', 'go test -toolexec x ./...', 'go test -json ./...', 'go test -cover ./...', 'go test -coverprofile=c.out ./...', 'go test -o bin ./...',
    'go test -c ./...', 'go test -race ./...', 'go test ../other', 'go test /abs/pkg', 'go test github.com/x/y', 'go run .', 'go vet ./...', 'go -C /abs test', 'go -C ../x test'])
    assert.equal(recogniseGo(cmd.split(' ')), null, cmd);
  for (const cmd of ['make', 'make install', 'make test CC=gcc', 'make -k test', 'make -C /abs test', 'make -C ../x test', 'make test check', 'gmake test'])
    assert.equal(recogniseMake(cmd.split(' ')), null, cmd);
  for (const cmd of ['go run .', 'go test -exec sh ./...', 'make install', 'make test; curl example.com', 'ctest']) {
    const r = tool('trace.mjs', '--codemap', 'x.json', '--test-command', cmd, OPT_IN);
    assert.equal(r.status, 3, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /not a recognised test command/);
  }
  const noFlag = tool('trace.mjs', '--codemap', 'x.json', '--test-command', 'go test ./...');
  assert.equal(noFlag.status, 1);
  assert.match(noFlag.stderr, /refused: tracing runs the repo's test code/);
});

test('the Go module the run uses, and the tests it runs: one alone per run, in the packages and -run the command gave', () => {
  const m = { selfCheck: { go: { modules: [{ dir: 'services/inventory', module: 'example.com/inventory' }] } },
    tests: [{ id: 'services/inventory/api/server_test.go:TestGetStock', file: 'services/inventory/api/server_test.go' },
      { id: 'services/inventory/stock/store_test.go:TestMemStoreReserve', file: 'services/inventory/stock/store_test.go' }, { id: 'backend.test_app:test_x', file: 'backend/test_app.py' }] };
  assert.deepEqual(goModuleDir(m, recogniseGo(['go', 'test', './...']), false), { dir: 'services/inventory' }, 'the one module, when the root has no go.mod');
  assert.deepEqual(goModuleDir(m, recogniseGo('go -C elsewhere test'.split(' ')), false), { why: '-C elsewhere: no go.mod there in the code map' });
  const two = { selfCheck: { go: { modules: [{ dir: 'a', module: 'x/a' }, { dir: 'b', module: 'x/b' }] } } };
  assert.match(goModuleDir(two, recogniseGo(['go', 'test']), false).why, /2 Go modules .* go -C <dir> test/);
  const names = cmd => goTestsToRun(m, recogniseGo(cmd.split(' ')), 'services/inventory').map(t => `${t.pkgDir}:${t.name}`);
  assert.deepEqual(names('go test ./...'), ['api:TestGetStock', 'stock:TestMemStoreReserve']);
  assert.deepEqual(names('go test ./stock'), ['stock:TestMemStoreReserve']);
  assert.deepEqual(names('go test -run Stock$ ./...'), ['api:TestGetStock']);
  const nested = { selfCheck: { go: { modules: [{ dir: '.', module: 'example.com/app' }, { dir: 'tools', module: 'example.com/app/tools' }] } },
    tests: [{ id: 'app_test.go:TestApp', file: 'app_test.go' }, { id: 'tools/gen/gen_test.go:TestGen', file: 'tools/gen/gen_test.go' }] };
  assert.deepEqual(goTestsToRun(nested, recogniseGo(['go', 'test', './...']), '').map(t => t.name), ['TestApp'], 'a nested module\'s tests are its own: go test ./... skips them');
  assert.deepEqual(goTestsToRun(nested, recogniseGo('go -C tools test ./...'.split(' ')), 'tools').map(t => t.name), ['TestGen']);
});

test('a recipe line\'s shape: what its exit status can say about the programs it runs', () => {
  const shapes = { './tests/test_cart': 'single', './t > log 2>&1': 'single', 'VAR=1 ./t "a;b"': 'single', './a && ./b': 'and', 'cd t && ./t': 'and',
    './a; ./b': 'other', './a || true': 'other', './a | tee log': 'other', '(./a)': 'other', './t $(cat args)': 'other', 'for t in a b; do ./$t || exit 1; done': 'other', './a &': 'other' };
  assert.deepEqual(Object.fromEntries(Object.keys(shapes).map(c => [c, lineShape(c)])), shapes);
});

test('a file the run wrote is read from outside the sandbox only as a plain file, never through a symlink', () => {
  const d = scratch(), secret = join(d, 'secret.txt');
  writeFileSync(secret, 'not for the trace\n'); writeFileSync(join(d, 'report.json'), '{"ok":true}');
  symlinkSync(secret, join(d, 'output')); symlinkSync(join(d, 'report.json'), join(d, 'linked.json')); mkdirSync(join(d, 'adir'));
  assert.deepEqual([readRunFile(join(d, 'output')), readRunFile(join(d, 'adir')), readRunFile(join(d, 'missing')), readRunFile(join(d, 'report.json'))], [null, null, null, '{"ok":true}']);
  assert.deepEqual([readRunJson(join(d, 'report.json')), readRunJson(join(d, 'linked.json')), readRunJson(secret)], [[{ ok: true }], [], []]);
  cleanup(d);
});

/* ---------------- reports and coverage onto the code map ---------------- */

test('parseGoTestJson: top-level outcomes with their output; a package that failed to build is a build error', () => {
  const ev = (o) => JSON.stringify({ Package: 'p', ...o });
  const text = [ev({ Action: 'run', Test: 'TestA' }), ev({ Action: 'output', Test: 'TestA', Output: '--- FAIL: TestA\n' }), ev({ Action: 'output', Test: 'TestA/sub', Output: 'dial tcp 1.2.3.4:5: connect: operation not permitted\n' }),
    ev({ Action: 'fail', Test: 'TestA/sub' }), ev({ Action: 'fail', Test: 'TestA' }), ev({ Action: 'pass', Test: 'TestB' }), ev({ Action: 'skip', Test: 'TestC' }), ev({ Action: 'fail' })].join('\n');
  assert.deepEqual(parseGoTestJson(text).tests, [{ name: 'TestA', status: 'failed', message: '--- FAIL: TestA\ndial tcp 1.2.3.4:5: connect: operation not permitted' },
    { name: 'TestB', status: 'passed', message: '' }, { name: 'TestC', status: 'skipped', message: '' }]);
  assert.deepEqual(parseGoTestJson('# p\nx.go:1: syntax error\n' + ev({ Action: 'fail' })), { tests: [], buildErrors: ['# p\nx.go:1: syntax error'] });
});

test('coverage onto symbols: a counted block marks the innermost symbol holding it; gcov text is per source, per line', () => {
  const prof = 'mode: set\nexample.com/m/shop/cart.go:3.20,5.2 1 1\nexample.com/m/shop/cart.go:7.20,9.2 1 0\nexample.com/other/x.go:1.1,2.2 1 1\n';
  const blocks = parseCoverProfile(prof, p => p === 'example.com/m' ? '' : p.startsWith('example.com/m/') ? p.slice(14) : null);
  assert.deepEqual([...blocks], [['shop/cart.go', [{ start: 3, end: 5, count: 1 }, { start: 7, end: 9, count: 0 }]]]);
  const m = { symbols: [{ id: 'shop/cart.go:A', kind: 'function', file: 'shop/cart.go', start: 3, end: 5 }, { id: 'shop/cart.go:B', kind: 'function', file: 'shop/cart.go', start: 7, end: 9 },
    { id: 'shop/cart.go:K', kind: 'class', file: 'shop/cart.go', start: 1, end: 9 }] };
  assert.deepEqual([...symbolsRan(m, blocks)], ['shop/cart.go:A']);
  const gcov = parseGcov('        -:    0:Source:src/cart.c\n        -:    1:#include "cart.h"\n        2:    3:int f(void) {\n    #####:    4:  return g();\n        -:    0:Source:src/x.h\n       1*:    2:static int h(void) {\n');
  assert.deepEqual([...gcov].map(([f, l]) => [f, [...l]]), [['src/cart.c', [[3, 2], [4, 0]]], ['src/x.h', [[2, 1]]]]);
  assert.deepEqual(linesToBlocks(gcov.get('src/cart.c')), [{ start: 3, end: 3, count: 2 }, { start: 4, end: 4, count: 0 }]);
  assert.deepEqual([...parseCTestOutput('[ RUN      ] Cart.Adds\n[       OK ] Cart.Adds (0 ms)\n[  FAILED  ] Cart.Totals (1 ms)\ntests/t.c:7:test_low:PASS\ntests/t.c:9:test_high:FAIL: Expected 5\n')],
    [['Cart.Adds', 'passed'], ['Cart.Totals', 'failed'], ['test_low', 'passed'], ['test_high', 'failed']]);
});

test('observeCoverage: a direct link is observed when its target ran in its test\'s unit; a test that never ran is out of the share; no edge is marked', () => {
  const m = { symbols: [{ id: 'a.go:F', kind: 'function', file: 'a.go', group: 'prod' }, { id: 'a.go:G', kind: 'function', file: 'a.go', group: 'prod' }],
    tests: [{ id: 'a_test.go:TestF', file: 'a_test.go', direct: [{ to: 'a.go:F' }, { to: 'a.go:G' }] }, { id: 'a_test.go:TestG', file: 'a_test.go', direct: [{ to: 'a.go:G' }] }], fixtureBindings: [] };
  const results = new Map([['a_test.go:TestF', { status: 'passed', nodeid: '.::TestF' }], ['a_test.go:TestG', { status: 'not run', nodeid: '.::TestG' }]]);
  const o = observeCoverage(m, { units: [{ key: 'a_test.go:TestF', tests: ['a_test.go:TestF'], ran: new Set(['a.go:F']) }], results, failures: [], denied: [], granularity: 'test', ownFile: f => f.endsWith('.go') });
  assert.deepEqual(o.byTest['a_test.go:TestF'].direct, { total: 2, observed: 1, missing: ['a.go:G'] });
  assert.deepEqual(o.summary.directLinksPerTest, { tests: 1, observed: 1, total: 2, prod: { observed: 1, total: 2 }, granularity: 'test' });
  assert.deepEqual([o.outcome.passed, o.outcome.notRun], [1, 1]);
  assert.deepEqual([o.pairs, o.edges], [[], []]);
});

/* ---------------- end to end ---------------- */

const mineFixture = repo => {
  const out = join(scratch(), 'out');
  const r = tool('mine.mjs', repo, '--out', out);
  assert.equal(r.status, 0, r.stderr);
  return out;
};
const read = (out, f) => JSON.parse(readFileSync(join(out, f), 'utf8'));
const files = dir => readdirSync(dir, { recursive: true }).map(String).sort();
const trace = (out, cmd) => tool('trace.mjs', '--codemap', join(out, 'codemap.json'), '--test-command', cmd, OPT_IN, '--timeout', '600');

test('go test on fixtures/trace-go runs sandboxed, one run per test: what ran is attributed to each test; the socket test is denied', { skip: skipFor(['go']) }, () => {
  const repo = gitRepo(join(FIXTURES, 'trace-go')), out = mineFixture(repo), before = files(repo), codemap = readFileSync(join(out, 'codemap.json'), 'utf8');
  const r = trace(out, 'go test ./...');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const t = read(out, 'trace.json');
  assert.deepEqual(files(repo), before, 'nothing is written inside the repo');
  assert.equal(readFileSync(join(out, 'codemap.json'), 'utf8'), codemap, 'the code map is never edited');
  assert.deepEqual([t.optIn.command, t.runner, t.granularity], ['go test ./...', 'go-test', 'test']);
  assert.deepEqual(t.deniedBySandbox.map(d => [d.nodeid, d.network.some(x => /dial tcp 127\.0\.0\.1:9/.test(x))]), [['shop::TestPing', true]]);
  assert.equal(t.ran['shop/cart.go:Unused'], undefined, 'code no test runs is never marked');
  assertGolden('trace-go', { granularity: t.granularity, outcome: t.outcome, byUnit: Object.fromEntries(Object.entries(t.byUnit).map(([k, v]) => [k, v.ran.join(', ')])),
    byTest: Object.fromEntries(Object.entries(t.byTest).map(([k, v]) => [k, `${v.status}: ${v.direct.observed}/${v.direct.total}`])),
    directLinksPerTest: t.summary.directLinksPerTest, functionsRan: t.summary.functionsRan });
  cleanup(dirname(repo)); cleanup(join(out, '..'));
});

test('go test on fixtures/trace-go-dep builds its dependency from a module cache in the home folder, read-only; the rest of the home folder stays unreadable', { skip: skipFor(['go']) }, () => {
  const repo = gitRepo(join(FIXTURES, 'trace-go-dep')), home = join(scratch(), 'home'), secret = join(home, 'secret.txt');
  cpSync(join(FIXTURES, 'go-modcache'), join(home, 'go', 'pkg', 'mod'), { recursive: true });
  writeFileSync(secret, 'not for the trace\n');
  writeFileSync(join(repo, 'greet', 'home_test.go'), `package greet\n\nimport (\n\t"os"\n\t"testing"\n)\n\nfunc TestReadsHome(t *testing.T) {\n\tb, err := os.ReadFile(${JSON.stringify(secret)})\n\tif err != nil {\n\t\tt.Fatal(err)\n\t}\n\tt.Logf("read %s", b)\n}\n`);
  const out = mineFixture(repo);
  // the default module cache: $HOME/go/pkg/mod, as on a fresh install
  const env = { ...process.env, HOME: home };
  for (const k of ['GOPATH', 'GOMODCACHE', 'GOFLAGS', 'GOENV', 'GOPROXY', 'XDG_CONFIG_HOME']) delete env[k];
  const r = spawnSync(process.execPath, [join(SKILL, 'tools', 'trace.mjs'), '--codemap', join(out, 'codemap.json'), '--test-command', 'go test ./...', OPT_IN, '--timeout', '600'], { cwd: tmpdir(), env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const t = read(out, 'trace.json'), log = readFileSync(join(out, 'trace.log'), 'utf8');
  assert.equal(t.byTest['greet/greet_test.go:TestWelcome'].status, 'passed', log);
  assert.deepEqual(t.byUnit['greet/greet_test.go:TestWelcome'].ran, ['greet/greet.go:Welcome']);
  assert.equal(t.byTest['greet/home_test.go:TestReadsHome'].status, 'failed', 'a file elsewhere in the home folder is not readable');
  assert.match(t.failures.find(f => f.test === 'greet/home_test.go:TestReadsHome').message, /secret\.txt: (operation not permitted|no such file or directory)/);
  assert.equal(log.includes('not for the trace') || JSON.stringify(t).includes('not for the trace'), false);
  cleanup(dirname(repo)); cleanup(dirname(home)); cleanup(join(out, '..'));
});

test('go test refuses a GOMODCACHE that is the home folder or holds it', { skip: skipFor(['go']) }, () => {
  const repo = gitRepo(join(FIXTURES, 'trace-go-dep')), out = mineFixture(repo), home = join(scratch(), 'home');
  mkdirSync(home);
  for (const modcache of [home, dirname(home)]) {
    const env = { ...process.env, HOME: home, GOMODCACHE: modcache };
    const r = spawnSync(process.execPath, [join(SKILL, 'tools', 'trace.mjs'), '--codemap', join(out, 'codemap.json'), '--test-command', 'go test ./...', OPT_IN], { cwd: tmpdir(), env, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /refused: GOMODCACHE is .* which is or holds your home folder/);
  }
  cleanup(dirname(repo)); cleanup(dirname(home)); cleanup(join(out, '..'));
});

test('make test on fixtures/trace-c builds with coverage and runs sandboxed; gcov reads what ran; the socket test is denied', { skip: skipFor(['cc', 'make', 'gcov']) }, () => {
  const repo = gitRepo(join(FIXTURES, 'trace-c')), out = mineFixture(repo), before = files(repo);
  const r = trace(out, 'make test');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const t = read(out, 'trace.json');
  assert.deepEqual(files(repo), before, 'nothing is written inside the repo: the build and its counters stay in the copy');
  assert.deepEqual([t.runner, t.granularity, t.exitCode !== 0], ['make', 'binary', true]);
  assert.deepEqual(Object.keys(t.byUnit), ['./tests/test_cart', './tests/test_net'], 'one unit per test binary make ran');
  assert.deepEqual(t.deniedBySandbox.map(d => [d.nodeid, d.network.some(x => /connect: Operation not permitted/i.test(x))]), [['tests/test_net.c::test_ping', true]]);
  assert.equal(t.ran['src/cart.c:unused'], undefined);
  assertGolden('trace-c', { granularity: t.granularity, ran: Object.keys(t.ran), byUnit: Object.fromEntries(Object.entries(t.byUnit).map(([k, v]) => [k, v.ran.join(', ')])), byTest: Object.fromEntries(Object.entries(t.byTest).map(([k, v]) => [k, `${v.status}: ${v.direct.observed}/${v.direct.total}`])),
    directLinksPerTest: t.summary.directLinksPerTest, functionsRan: t.summary.functionsRan });
  cleanup(dirname(repo)); cleanup(join(out, '..'));
});

/* the trace-c fixture with a Makefile of the test's own: its sources, built as fixtures/trace-c's Makefile builds them */
const C_RULES = 'tests/test_cart: tests/test_cart.c src/cart.c src/cart.h\n\t$(CC) -O0 -g -o $@ tests/test_cart.c src/cart.c\n\n'
  + 'tests/test_net: tests/test_net.c src/net.c src/net.h\n\t$(CC) -O0 -g -o $@ tests/test_net.c src/net.c\n\n.PHONY: test\n';
const cRepo = (makefile, files = {}) => {
  const repo = gitRepo(join(FIXTURES, 'trace-c'));
  writeFileSync(join(repo, 'Makefile'), makefile);
  for (const [f, [text, mode]] of Object.entries(files)) writeFileSync(join(repo, f), text, { mode });
  return repo;
};

test('make test: a recipe line that runs two test binaries and fails gives their tests no status of their own (unknown)', { skip: skipFor(['cc', 'make', 'gcov']) }, () => {
  const repo = cRepo(`test: tests/test_cart tests/test_net\n\t./tests/test_cart && ./tests/test_net\n\n${C_RULES}`), out = mineFixture(repo);
  const r = trace(out, 'make test');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const t = read(out, 'trace.json');
  assert.deepEqual(Object.keys(t.byUnit), ['./tests/test_cart && ./tests/test_net']);
  assert.deepEqual(Object.fromEntries(Object.entries(t.byTest).map(([k, v]) => [k, v.status])),
    { 'tests/test_cart.c:test_total': 'unknown', 'tests/test_cart.c:test_discount': 'unknown', 'tests/test_net.c:test_ping': 'unknown' });
  cleanup(dirname(repo)); cleanup(join(out, '..'));
});

test('make test runs recipe lines under the shell the Makefile names', { skip: skipFor(['cc', 'make', 'gcov']) }, () => {
  const repo = cRepo(`SHELL := ./mysh\n\ntest: tests/test_cart\n\ttest "$$VIA_MYSH" = 1 && ./tests/test_cart\n\n${C_RULES}`,
    { mysh: ['#!/bin/sh\nVIA_MYSH=1 exec /bin/sh "$@"\n', 0o755] });
  const out = mineFixture(repo), r = trace(out, 'make test');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const t = read(out, 'trace.json');
  assert.equal(t.byTest['tests/test_cart.c:test_total'].status, 'passed');
  cleanup(dirname(repo)); cleanup(join(out, '..'));
});

test('make test: a symlink the run plants where the trace reads its counters is never written through', { skip: skipFor(['cc', 'make', 'gcov']) }, () => {
  const victim = join(scratch(), 'victim.txt');
  writeFileSync(victim, 'untouched\n');
  const plant = 'd="$$FM_TRACE_UNITS/line-planted/gcda$$(pwd -P)"; mkdir -p "$$d" && printf x > "$$d/a.gcda" && printf payload > a.gcno'
    + ` && ln -s ${JSON.stringify(victim)} "$$d/a.gcno" && echo "$$FM_TRACE_UNITS/line-planted" >> "$$FM_TRACE_UNITS/order"`;
  const repo = cRepo(`test: tests/test_cart\n\t./tests/test_cart\n\t${plant}\n\n${C_RULES}`), out = mineFixture(repo);
  const r = trace(out, 'make test');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(victim, 'utf8'), 'untouched\n');
  assert.equal(read(out, 'trace.json').byTest['tests/test_cart.c:test_total'].status, 'passed');
  cleanup(dirname(victim)); cleanup(dirname(repo)); cleanup(join(out, '..'));
});

test('make test: a recipe line gives its tests a status only when its shape lets the exit status speak for each binary', { skip: skipFor(['cc', 'make', 'gcov']) }, () => {
  const more = { 'tests/test_more.c': ['#include <assert.h>\n#include "../src/cart.h"\n\nstatic void test_more(void) { assert(discount(50) == 50); }\n\nint main(void) {\n  test_more();\n  return 0;\n}\n', 0o644],
    'tests/test_abort.c': ['#include <assert.h>\n#include "../src/cart.h"\n\nstatic void test_abort(void) { assert(discount(1) == 99); }\n\nint main(void) {\n  test_abort();\n  return 0;\n}\n', 0o644] };
  const rules = `${C_RULES}\ntests/test_more: tests/test_more.c src/cart.c src/cart.h\n\t$(CC) -O0 -g -o $@ tests/test_more.c src/cart.c\n\n`
    + 'tests/test_abort: tests/test_abort.c src/cart.c src/cart.h\n\t$(CC) -O0 -g -o $@ tests/test_abort.c src/cart.c\n';
  const statuses = line => {
    const repo = cRepo(`test: tests/test_cart tests/test_net tests/test_more tests/test_abort\n\t${line}\n\n${rules}`, more), out = mineFixture(repo);
    const r = trace(out, 'make test');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const t = read(out, 'trace.json');
    cleanup(dirname(repo)); cleanup(join(out, '..'));
    return Object.fromEntries(Object.entries(t.byTest).filter(([, v]) => v.status !== 'not run').map(([k, v]) => [k.split(':').pop(), v.status]));
  };
  assert.deepEqual(statuses('./tests/test_net; ./tests/test_cart'), { test_total: 'unknown', test_discount: 'unknown', test_ping: 'unknown' },
    'the line exits 0 because its last binary passed: the failing test_net is never passed');
  assert.deepEqual(statuses('./tests/test_cart && ./tests/test_abort'), { test_total: 'unknown', test_discount: 'unknown' },
    'the second binary aborted and wrote no counters: the first is not blamed');
  assert.deepEqual(statuses('./tests/test_cart && ./tests/test_more'), { test_total: 'passed', test_discount: 'passed', test_more: 'passed' });
});

test('a process a test leaves behind is killed when its run ends', { skip: skipFor(['go']) }, () => {
  const marker = `${17 + Math.floor(Math.random() * 1000) / 1000 + 0.0001}`, repo = gitRepo();
  writeFileSync(join(repo, 'go.mod'), 'module example.com/linger\n\ngo 1.22\n');
  writeFileSync(join(repo, 'linger_test.go'), `package linger\n\nimport (\n\t"os/exec"\n\t"testing"\n)\n\nfunc TestLeaves(t *testing.T) {\n\tif err := exec.Command("/bin/sleep", "${marker}").Start(); err != nil {\n\t\tt.Fatal(err)\n\t}\n}\n`);
  const out = mineFixture(repo), r = trace(out, 'go test ./...');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(read(out, 'trace.json').byTest['linger_test.go:TestLeaves'].status, 'passed');
  const alive = spawnSync('pgrep', ['-f', `sleep ${marker}`], { encoding: 'utf8' });
  spawnSync('pkill', ['-f', `sleep ${marker}`]);
  assert.equal(alive.stdout.trim(), '', 'nothing the run started outlives it');
  cleanup(dirname(repo)); cleanup(join(out, '..'));
});
