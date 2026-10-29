// trace.mjs: the opt-in test-suite trace. Its refusals (exit 1 without the opt-in flag, 3 for anything but a test
// runner, 4 without a sandbox) are checked everywhere; the sandbox itself and the end-to-end run on fixtures/trace
// only where that platform's sandbox starts (sandbox-exec on macOS, bwrap on Linux) and python3 has pytest. Set
// FM_TRACE_REQUIRE_SANDBOX=1 to fail instead of skipping (the CI trace job does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, cpSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { FIXTURES, SKILL, scratch, cleanup, tool, assertGolden } from './helpers.mjs';
import { sandboxArgv, sandboxWorks } from '../skills/explainer-video-from-codebase/tools/lib/sandbox.mjs';
import { observe } from '../skills/explainer-video-from-codebase/tools/lib/observe.mjs';

const REPO = join(FIXTURES, 'trace');
const OPT_IN = '--i-ran-this-by-the-user';
const KIND = { darwin: 'macos', linux: 'bwrap' }[process.platform];
const works = KIND ? sandboxWorks(KIND) : { ok: false, why: `no sandbox on ${process.platform}` };
const hasPytest = spawnSync('python3', ['-c', 'import pytest'], { encoding: 'utf8' }).status === 0;
const unavailable = !works.ok ? `no OS sandbox here: ${works.why}` : !hasPytest ? 'python3 with pytest is not installed' : false;
const skip = process.env.FM_TRACE_REQUIRE_SANDBOX === '1' ? false : unavailable;
if (process.env.FM_TRACE_REQUIRE_SANDBOX === '1') test('the sandbox and pytest are available (FM_TRACE_REQUIRE_SANDBOX=1)', () => assert.equal(unavailable, false, unavailable));

const files = dir => readdirSync(dir, { recursive: true }).map(String).sort();

/* ---------------- refusals: every platform ---------------- */

test('exit 1: without --i-ran-this-by-the-user nothing runs and nothing is written', () => {
  const out = scratch();
  const r = tool('trace.mjs', '--codemap', join(out, 'codemap.json'), '--test-command', 'python3 -m pytest');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refused: .*--i-ran-this-by-the-user/);
  assert.equal(r.stdout, '');
  assert.deepEqual(readdirSync(out), []);
  cleanup(out);
});

test('exit 1: an unknown flag or a missing command is a usage error', () => {
  assert.equal(tool('trace.mjs', '--codemap', 'x.json', '--test-command', 'pytest', OPT_IN, '--sandbox-off').status, 1);
  assert.equal(tool('trace.mjs', '--codemap', 'x.json', OPT_IN).status, 1);
  assert.equal(tool('trace.mjs', '--codemap', 'x.json', '--test-command', 'pytest', OPT_IN, '--timeout', '0').status, 1);
});

test('exit 3: only a recognised test runner is traced, never a server, a wrapper or shell syntax', () => {
  for (const cmd of ['python3 server.py', 'python -m http.server', 'uv run pytest', 'poetry run pytest', 'env A=1 pytest',
    'pytest; curl example.com', 'pytest && rm -rf x', 'pytest | tee log', 'pytest > log', 'pytest $(id)', 'pytest "`id`"',
    'python -m pytest$IFS-x', 'node --test', 'npx jest', 'go test ./...', '']) {
    const r = tool('trace.mjs', '--codemap', 'x.json', '--test-command', cmd, OPT_IN);
    assert.equal(r.status, 3, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /not a recognised test command/);
  }
});

test('exit 4: --sandbox none and another platform\'s sandbox are refused, never run unsandboxed', () => {
  const none = tool('trace.mjs', '--codemap', 'x.json', '--test-command', 'python3 -m pytest', OPT_IN, '--sandbox', 'none');
  assert.equal(none.status, 4, none.stderr);
  assert.match(none.stderr, /never runs unsandboxed/);
  const other = process.platform === 'darwin' ? 'bwrap' : 'macos';
  const r = tool('trace.mjs', '--codemap', 'x.json', '--test-command', 'python3 -m pytest', OPT_IN, '--sandbox', other);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /exists only on/);
});

/* ---------------- the mapping onto static edges: every platform ---------------- */

const S = (id, kind = 'function', group = 'prod') => ({ id, kind, group, decos: [] });
const MAP = {
  symbols: [S('app.a:f'), S('app.a:g'), S('app.a:h'), S('app.a:K', 'class'), S('app.a:K.__init__', 'method'),
    S('tests.test_a:test_f', 'function', 'test'), S('tests.test_a:test_g', 'function', 'test'), S('tests.conftest:fx', 'function', 'test')],
  edges: [{ from: 'app.a:f', to: 'app.a:g', kind: 'static' }, { from: 'app.a:f', to: 'app.a:h', kind: 'static' },
    { from: 'tests.test_a:test_f', to: 'app.a:f', kind: 'static' }, { from: 'tests.test_a:test_g', to: 'app.a:K.__init__', kind: 'ctor' },
    { from: 'tests.test_a:test_f', to: 'tests.conftest:fx', kind: 'framework', rule: 'pytest.fixture' }],
  tests: [{ id: 'tests.test_a:test_f', direct: [{ to: 'app.a:f' }] }, { id: 'tests.test_a:test_g', direct: [{ to: 'app.a:K.__init__' }, { to: 'app.a:h' }] },
    { id: 'tests.test_a:test_x', direct: [] }],
  fixtureBindings: [{ fn: 'tests.test_a:test_f', fixture: 'tests.conftest:fx' }],
};
const F = 'tests/test_a.py::test_f', G1 = 'tests/test_a.py::test_g[1]', G2 = 'tests/test_a.py::test_g[2]';
const P = (from, to, test, n = 1) => ({ from, to, test, n });
const DUMP = {
  python: '3.12.0', collected: 4,
  pairs: [P(null, ['tests/conftest.py', 'fx'], F), P(['tests/test_a.py', 'test_f'], ['app/a.py', 'f'], F),
    P(['app/a.py', 'f'], ['app/a.py', 'g'], F, 3), P(['tests/test_a.py', 'test_g'], ['app/a.py', 'K.__init__'], G1),
    P(['tests/test_a.py', 'test_g'], ['app/a.py', 'K'], G1), P(null, ['app/a.py', '<module>'], null),
    P(['app/a.py', 'g'], ['app/a.py', 'h'], G2), P(['app/a.py', 'f'], ['app/b.py', 'gone'], F)],
  network: { [G2]: ['connect (\'127.0.0.1\', 6379)'], [F]: ['getaddrinfo (\'localhost\', 80)'] },
  outcomes: { [F]: { nodeid: F, setup: 'passed', call: 'passed', teardown: 'failed', message: 'boom' },
    [G1]: { nodeid: G1, setup: 'failed', message: 'PermissionError: denied', permission: true },
    [G2]: { nodeid: G2, setup: 'passed', call: 'failed', teardown: 'passed', message: 'ConnectionRefusedError' },
    'unittest::tests.test_a.test_x': { call: 'xfailed' } },
  collectErrors: [{ nodeid: 'tests/test_b.py', message: 'ImportError' }],
};

test('observe: a fired static edge is observed, with the tests it fired under; the code map is never edited', () => {
  const m = structuredClone(MAP), before = JSON.stringify(m);
  const o = observe(m, [DUMP]);
  assert.equal(JSON.stringify(m), before);
  assert.deepEqual(o.edges.map(e => `${e.from} -> ${e.to} ${e.kind} n=${e.n} ${e.tests.join(',')}`), [
    'app.a:f -> app.a:g static n=3 tests.test_a:test_f',
    'tests.test_a:test_f -> app.a:f static n=1 tests.test_a:test_f',
    'tests.test_a:test_g -> app.a:K.__init__ ctor n=1 tests.test_a:test_g']);
  assert.deepEqual([o.summary.edges.all.observed, o.summary.edges.all.total], [3, 5], 'unfired edges stay in the totals');
  assert.deepEqual(o.summary.edges.all.byKind['framework/pytest.fixture'], [0, 1]);
  assert.deepEqual(o.noStaticEdge.map(x => `${x.from} -> ${x.to} ${x.category}`), ['app.a:g -> app.a:h other']);
  assert.deepEqual(o.summary.unmapped, { records: 1, sample: ['app.b:gone'] });
  assert.equal(o.summary.moduleAndClassBodies, 2, 'module and class bodies are not calls');
});

test('observe: per-test attribution merges parametrized ids and confirms direct and fixture links by what ran', () => {
  const o = observe(structuredClone(MAP), [DUMP]);
  assert.deepEqual(o.byTest['tests.test_a:test_g'].nodeids, [G1, G2]);
  assert.deepEqual(o.byTest['tests.test_a:test_g'].ran, ['app.a:K.__init__', 'app.a:h']);
  assert.deepEqual(o.byTest['tests.test_a:test_f'].direct, { total: 1, observed: 1, missing: [] });
  assert.deepEqual(o.summary.directLinksPerTest, { tests: 2, observed: 3, total: 3, prod: { observed: 3, total: 3 } });
  assert.deepEqual(o.summary.fixtureLinks, { observed: 1, total: 1 }, 'a fixture has no in-repo caller: attribution observes it');
  assert.equal(o.byTest['tests.test_a:test_x'].status, 'xfailed', 'a unittest id maps by its dotted name');
});

test('observe: pytest\'s counting, and only failing tests with a network attempt or a permission error are denied', () => {
  const o = observe(structuredClone(MAP), [DUMP]);
  assert.deepEqual(o.outcome, { collected: 4, passed: 1, failed: 1, errors: 3, skipped: 0, xfailed: 1, xpassed: 0 });
  assert.deepEqual(o.failures.map(f => `${f.nodeid} ${f.status} ${f.phase}`), [
    `${F} passed teardown`, `${G1} error setup`, `${G2} failed call`, 'tests/test_b.py error collect']);
  assert.deepEqual(o.deniedBySandbox.map(d => [d.nodeid, d.network.length, d.permission]), [[F, 1, false], [G1, 0, true], [G2, 1, false]]);
});

/* ---------------- the sandboxes: their own platform only ---------------- */

// what the profile must deny and allow, probed from inside it (design Appendix A.6's nettest.py): a TCP listener on
// the host's localhost and a unix socket outside scratch, both reachable from outside the sandbox
function probeSandbox(kind) {
  const dir = realpathSync(scratch()), box = join(dir, 'box'), outside = join(dir, 'outside');
  mkdirSync(box); mkdirSync(outside);
  const sock = join(outside, 's.sock');
  const tcp = createServer(c => c.end()).listen(0, '127.0.0.1'), unix = createServer(c => c.end()).listen(sock);
  const listening = s => new Promise(ok => s.listening ? ok() : s.on('listening', ok));
  return Promise.all([listening(tcp), listening(unix)]).then(() => {
    const probe = `
import socket
def tcp(h, p):
    try: socket.create_connection((h, p), timeout=2).close(); return "connected"
    except OSError: return "denied"
def unix(p):
    try: s = socket.socket(socket.AF_UNIX); s.connect(p); return "connected"
    except OSError: return "denied"
def dns():
    try: socket.gethostbyname("example.com"); return "resolved"
    except OSError: return "denied"
def write(p):
    try: open(p, "w").write("x"); return "wrote"
    except OSError: return "denied"
a, b = socket.socketpair()
print(tcp("127.0.0.1", ${tcp.address().port}), tcp("1.1.1.1", 443), unix(${JSON.stringify(sock)}), dns(), write(${JSON.stringify(join(outside, 'w'))}), write(${JSON.stringify(join(box, 'w'))}), "socketpair")`;
    // `outside` is exposed read-only, as the repo is: a write there still fails, and so does a connect to its socket
    const [cmd, ...args] = sandboxArgv(kind, { scratch: box, readOnly: [outside], argv: ['/usr/bin/env', 'python3', '-c', probe] });
    return new Promise(done => {
      const child = spawn(cmd, args, { env: { PATH: process.env.PATH, HOME: box } });
      let stdout = '', stderr = '';
      child.stdout.on('data', b => { stdout += b; });
      child.stderr.on('data', b => { stderr += b; });
      child.on('close', status => { tcp.close(); unix.close(); cleanup(dir); done({ status, stdout, stderr }); });
    });
  });
}

for (const [kind, platform] of [['macos', 'darwin'], ['bwrap', 'linux']]) {
  const why = process.platform !== platform ? `${kind} runs on ${platform} only` : process.env.FM_TRACE_REQUIRE_SANDBOX === '1' ? false : !works.ok ? works.why : false;
  test(`the ${kind} sandbox denies IP (localhost too), unix-socket and DNS connects and writes outside scratch`, { skip: why }, async () => {
    const r = await probeSandbox(kind);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'denied denied denied denied denied wrote socketpair');
  });
}

/* ---------------- end to end on fixtures/trace ---------------- */

const mineFixture = repo => {
  const out = join(scratch(), 'out');
  const r = tool('mine.mjs', repo, '--out', out);
  assert.equal(r.status, 0, r.stderr);
  return out;
};
const read = (out, f) => JSON.parse(readFileSync(join(out, f), 'utf8'));
const trace = (out, cmd, ...flags) => tool('trace.mjs', '--codemap', join(out, 'codemap.json'), '--test-command', cmd, OPT_IN, ...flags);

test('the fixture suite runs sandboxed: 4 pass, the socket test fails and is listed as denied', { skip }, () => {
  const out = mineFixture(REPO), before = files(REPO), codemap = readFileSync(join(out, 'codemap.json'), 'utf8');
  const r = trace(out, 'python3 -m pytest -q');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const t = read(out, 'trace.json');
  assert.deepEqual(files(REPO), before, 'nothing is written inside the repo');
  assert.equal(readFileSync(join(out, 'codemap.json'), 'utf8'), codemap, 'the code map is never edited');
  assert.equal(t.optIn.by, 'user');
  assert.equal(t.optIn.command, 'python3 -m pytest -q');
  assert.equal(t.sandbox, { macos: 'macos-sandbox-exec:macos-nonet.sb', bwrap: 'linux-bwrap:linux-bwrap.sh' }[KIND]);
  assert.ok(t.argv.includes('no:cacheprovider'));
  assert.deepEqual(t.deniedBySandbox.map(d => d.nodeid), ['tests/test_net.py::test_ping_reaches_the_cache']);
  assert.ok(t.deniedBySandbox[0].network.some(n => n.includes('6379')));
  const m = JSON.parse(codemap), edgeKeys = new Set(m.edges.map(e => `${e.from}|${e.to}|${e.kind}`));
  assert.ok(t.edges.every(e => edgeKeys.has(`${e.from}|${e.to}|${e.kind}`)), 'an observed edge is a code-map edge');
  assert.deepEqual(t.callbacks.map(c => `${c.from} -> ${c.to}`), ['shop.jobs:run_with_retry -> shop.jobs:nightly_total.<locals>._body']);
  assert.ok(!t.byTest['tests.test_cart:test_discount_can_be_mocked'].ran.includes('shop.cart:discount_for'), 'a mocked function does not run');
  assertGolden('trace', {
    outcome: t.outcome,
    observed: t.edges.map(e => `${e.from} -> ${e.to} ${e.kind}${e.rule ? ` ${e.rule}` : ''} [${e.tests.join(', ')}]`),
    noStaticEdge: t.noStaticEdge.map(x => `${x.from} -> ${x.to} ${x.category}`),
    ran: Object.fromEntries(Object.entries(t.byTest).map(([k, v]) => [k, `${v.status}: ${v.ran.join(', ')}`])),
    directLinksPerTest: t.summary.directLinksPerTest, fixtureLinks: t.summary.fixtureLinks,
  });
  cleanup(join(out, '..'));
});

test('python -m unittest is traced too, attributed by test id', { skip }, () => {
  const out = mineFixture(REPO);
  const r = trace(out, 'python3 -m unittest');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const t = read(out, 'trace.json');
  assert.equal(t.runner, 'unittest');
  assert.deepEqual(Object.keys(t.byTest), ['tests.test_discount:DiscountTest.test_threshold']);
  assert.deepEqual(t.byTest['tests.test_discount:DiscountTest.test_threshold'].ran, ['shop.cart:discount_for', 'tests.test_discount:DiscountTest.test_threshold']);
  cleanup(join(out, '..'));
});

test('exit 5: the time limit stops the run and keeps the partial trace, marked', { skip }, () => {
  const repo = join(scratch(), 'repo');
  cpSync(REPO, repo, { recursive: true });
  writeFileSync(join(repo, 'tests', 'test_slow.py'), 'import time\n\nfrom shop.cart import discount_for\n\n\ndef test_slow():\n    discount_for(1)\n    time.sleep(60)\n');
  const out = mineFixture(repo);
  const r = trace(out, 'python3 -m pytest -q tests/test_slow.py', '--timeout', '3');
  assert.equal(r.status, 5, r.stderr + r.stdout);
  const t = read(out, 'trace.json');
  assert.equal(t.timedOut, true);
  assert.ok(t.byTest['tests.test_slow:test_slow'].ran.includes('shop.cart:discount_for'), 'what ran before the limit is kept');
  cleanup(join(repo, '..')); cleanup(join(out, '..'));
});

test('exit 2: a run that starts no test writes no trace.json', { skip }, () => {
  const out = mineFixture(REPO);
  const r = trace(out, 'python3 -m pytest -q --co -p no:fmtrace_plugin tests/test_missing.py');
  assert.equal(r.status, 2, r.stderr + r.stdout);
  assert.ok(!existsSync(join(out, 'trace.json')));
  assert.ok(existsSync(join(out, 'trace.log')));
  cleanup(join(out, '..'));
});
