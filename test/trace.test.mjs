// trace.mjs: the opt-in test-suite trace. Its refusals (exit 1 without the opt-in flag, 3 for anything but a test
// runner, 4 without a sandbox) and the redaction are checked everywhere; the sandbox itself and the end-to-end run on
// fixtures/trace only where that platform's sandbox starts (sandbox-exec on macOS, bwrap on Linux) and python3 has
// pytest. Set FM_TRACE_REQUIRE_SANDBOX=1 to fail instead of skipping (the CI trace job does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, cpSync, realpathSync, chmodSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES, SKILL, scratch, cleanup, tool, git, gitRepo, assertGolden } from './helpers.mjs';
import { sandboxArgv, sandboxWorks } from '../skills/explainer-video-from-codebase/tools/lib/sandbox.mjs';
import { observe } from '../skills/explainer-video-from-codebase/tools/lib/observe.mjs';
import { redactSecrets } from '../skills/explainer-video-from-codebase/tools/lib/redact.mjs';

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
  assert.equal(tool('trace.mjs', '--codemap', 'x.json', '--test-command', 'pytest', OPT_IN, '--sandbox', 'none').status, 1, 'the sandbox is not a choice');
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

// trace.mjs run with a module preloaded first (to stand in for another platform), or under a wrapper command
function traceWith({ preload, wrap = [] }, ...args) {
  const dir = scratch(), pre = preload && join(dir, 'preload.mjs');
  if (pre) writeFileSync(pre, preload);
  const node = [process.execPath, ...(pre ? ['--import', pathToFileURL(pre).href] : []), join(SKILL, 'tools', 'trace.mjs'), ...args];
  const [cmd, ...rest] = [...wrap, ...node];
  const r = spawnSync(cmd, rest, { cwd: dir, encoding: 'utf8' });
  cleanup(dir);
  return r;
}

test('exit 4: on a platform with no OS sandbox, tracing is refused, never run unsandboxed', () => {
  const r = traceWith({ preload: "Object.defineProperty(process, 'platform', { value: 'freebsd' });" },
    '--codemap', 'x.json', '--test-command', 'python3 -m pytest', OPT_IN);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /refused: no OS sandbox is supported on freebsd/);
  assert.equal(r.stdout, '');
});

// sandbox-exec cannot start inside another sandbox: the same refusal when this platform's sandbox does not start
test('exit 4: where the sandbox does not start, tracing is refused', { skip: process.platform !== 'darwin' ? 'needs macOS (a sandbox-exec inside another)' : !works.ok ? works.why : false }, () => {
  const r = traceWith({ wrap: ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)'] },
    '--codemap', 'x.json', '--test-command', 'python3 -m pytest', OPT_IN);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /refused: the macos sandbox does not start here/);
});

/* ---------------- redaction: every platform ---------------- */

test('redaction: credential-shaped strings are replaced, their labels and ordinary output kept', () => {
  const cases = [
    ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'aws_secret_access_key = [REDACTED]'],
    ['key AKIAIOSFODNN7EXAMPLE here', 'key [REDACTED] here'],
    ['Authorization: Bearer abcdef123456.xyz', 'Authorization: Bearer [REDACTED]'],
    ["assert {'password': 'hunter2', 'user': 'bob'} == {}", "assert {'password': '[REDACTED]', 'user': 'bob'} == {}"],
    ['DATABASE_URL=postgres://bob:s3cret@db:5432/x', 'DATABASE_URL=postgres://bob:[REDACTED]@db:5432/x'],
    [`printed ghp_${'a'.repeat(36)}`, 'printed [REDACTED]'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----\nafter', '-----BEGIN RSA PRIVATE KEY----- [REDACTED]\nafter'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn', '-----BEGIN OPENSSH PRIVATE KEY----- [REDACTED]'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM', '[REDACTED]'],
    ['api_key: "sk-ant-abcdefghijklmnopqrstuvwxyz"', 'api_key: "[REDACTED]"'],
  ];
  for (const [text, want] of cases) assert.equal(redactSecrets(text), want, text);
  for (const kept of ['FAILED tests/test_auth.py::test_login - AssertionError: assert 1 == 2', 'tests/test_tokenizer.py::test_x PASSED',
    'author: Jane', '5 passed, 1 failed in 0.12s'])
    assert.equal(redactSecrets(kept), kept);
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
// the host's localhost and a unix socket outside scratch, both reachable from outside the sandbox; a file in a hidden
// home folder and in a hidden repo; a read-only path inside the hidden repo (its virtualenv) and outside it
function probeSandbox(kind) {
  const dir = realpathSync(scratch()), box = join(dir, 'box'), outside = join(dir, 'outside'), home = join(dir, 'home'), origin = join(dir, 'origin');
  for (const d of [box, outside, join(home, '.ssh'), join(origin, '.venv')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'secret'); writeFileSync(join(origin, '.env'), 'secret');
  writeFileSync(join(origin, '.venv', 'pyvenv.cfg'), 'ok'); writeFileSync(join(outside, 'r'), 'ok');
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
def read(p):
    try: open(p).read(); return "read"
    except OSError: return "denied"
a, b = socket.socketpair()
print(tcp("127.0.0.1", ${tcp.address().port}), tcp("1.1.1.1", 443), unix(${JSON.stringify(sock)}), dns(), write(${JSON.stringify(join(outside, 'w'))}), write(${JSON.stringify(join(box, 'w'))}), "socketpair")
print(read(${JSON.stringify(join(home, '.ssh', 'id_ed25519'))}), read(${JSON.stringify(join(origin, '.env'))}), read(${JSON.stringify(join(origin, '.venv', 'pyvenv.cfg'))}), read(${JSON.stringify(join(outside, 'r'))}))`;
    // `outside` and the hidden repo's .venv are exposed read-only, as the interpreter is: a write there still fails,
    // and so does a connect to a socket in it
    const [cmd, ...args] = sandboxArgv(kind, { scratch: box, hidden: [home, origin], readOnly: [outside, join(origin, '.venv')], argv: ['/usr/bin/env', 'python3', '-c', probe] });
    return new Promise(done => {
      const child = spawn(cmd, args, { cwd: box, env: { PATH: process.env.PATH, HOME: box } });
      let stdout = '', stderr = '';
      child.stdout.on('data', b => { stdout += b; });
      child.stderr.on('data', b => { stderr += b; });
      child.on('close', status => { tcp.close(); unix.close(); cleanup(dir); done({ status, stdout, stderr }); });
    });
  });
}

for (const [kind, platform] of [['macos', 'darwin'], ['bwrap', 'linux']]) {
  const why = process.platform !== platform ? `${kind} runs on ${platform} only` : process.env.FM_TRACE_REQUIRE_SANDBOX === '1' ? false : !works.ok ? works.why : false;
  test(`the ${kind} sandbox denies IP (localhost too), unix-socket and DNS connects, writes outside scratch and reads of the hidden paths`, { skip: why }, async () => {
    const r = await probeSandbox(kind);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'denied denied denied denied denied wrote socketpair\ndenied denied read read');
  });
}

// the macOS profile starts from (allow default), so a program outside the sandbox must not be made to act for the run:
// each escape below, had it got through, leaves a marker outside scratch (a file it touches, or a request to a
// localhost server this test runs outside the sandbox). Each is tried with the tool (open, osascript, launchctl) and,
// for LaunchServices and Apple Events, with the library call the run could make itself (ctypes), so the tools' exec
// denial is not the only wall
function probeEscapes() {
  const dir = realpathSync(scratch()), box = join(dir, 'box'), marks = join(dir, 'marks'), home = join(dir, 'home');
  for (const d of [box, marks, home]) mkdirSync(d, { recursive: true });
  const command = name => { const f = join(box, `${name}.command`); writeFileSync(f, `#!/bin/sh\ntouch ${JSON.stringify(join(marks, name))}\n`); chmodSync(f, 0o755); return f; };
  const label = `fmtrace.escape.${process.pid}`, hits = [];
  const http = createHttpServer((req, res) => { hits.push(req.url); res.end(); }).listen(0, '127.0.0.1');
  return new Promise(ok => http.on('listening', ok)).then(() => {
    const url = path => `http://127.0.0.1:${http.address().port}/${path}`, mark = name => JSON.stringify(join(marks, name));
    const probe = `
import ctypes, subprocess
from ctypes import c_void_p, c_char_p, c_long, c_uint32, c_int, byref
def tool(*argv):
    try: return "ran" if subprocess.run(argv, capture_output=True, timeout=20).returncode == 0 else "denied"
    except (OSError, subprocess.TimeoutExpired): return "denied"
CF = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
CS = ctypes.CDLL("/System/Library/Frameworks/CoreServices.framework/CoreServices")
CF.CFURLCreateWithBytes.restype = c_void_p
CF.CFURLCreateWithBytes.argtypes = [c_void_p, c_char_p, c_long, c_uint32, c_void_p]
CS.LSOpenCFURLRef.restype = c_int
CS.LSOpenCFURLRef.argtypes = [c_void_p, c_void_p]
def lsopen(u):
    b = u.encode()
    return "ran" if CS.LSOpenCFURLRef(CF.CFURLCreateWithBytes(None, b, len(b), 0x08000100, None), None) == 0 else "denied"
objc = ctypes.CDLL("/usr/lib/libobjc.A.dylib")
ctypes.CDLL("/System/Library/Frameworks/Foundation.framework/Foundation")
objc.objc_getClass.restype = objc.sel_registerName.restype = c_void_p
def msg(o, sel, *args):
    f = ctypes.cast(objc.objc_msgSend, ctypes.CFUNCTYPE(c_void_p, c_void_p, c_void_p, *[c_void_p] * len(args)))
    return f(o, objc.sel_registerName(sel.encode()), *args)
def applescript(src):
    s = msg(objc.objc_getClass(b"NSString"), "stringWithUTF8String:", c_char_p(src.encode()))
    err = c_void_p()
    return "ran" if msg(msg(msg(objc.objc_getClass(b"NSAppleScript"), "alloc"), "initWithSource:", s), "executeAndReturnError:", ctypes.addressof(err)) else "denied"
for name, result in [
    ("open-url", tool("/usr/bin/open", ${JSON.stringify(url('open'))})),
    ("open-terminal", tool("/usr/bin/open", "-a", "Terminal", ${JSON.stringify(command('open-terminal'))})),
    ("launchctl-submit", tool("/bin/launchctl", "submit", "-l", ${JSON.stringify(label)}, "--", "/usr/bin/touch", ${JSON.stringify(join(marks, 'launchctl-submit'))})),
    ("osascript-do-shell-script", tool("/usr/bin/osascript", "-e", 'do shell script "touch " & quoted form of ' + ${JSON.stringify(mark('osascript-do-shell-script'))})),
    ("osascript-terminal", tool("/usr/bin/osascript", "-e", 'tell application "Terminal" to do script "touch " & quoted form of ' + ${JSON.stringify(mark('osascript-terminal'))})),
    ("lsopen-url", lsopen(${JSON.stringify(url('lsopen'))})),
    ("lsopen-command", lsopen("file://" + ${JSON.stringify(command('lsopen-command'))})),
    ("appleevent-terminal", applescript('tell application "Terminal" to do script "touch " & quoted form of ' + ${JSON.stringify(mark('appleevent-terminal'))})),
]:
    print(name, result)`;
    const [cmd, ...args] = sandboxArgv('macos', { scratch: box, hidden: [home], argv: ['/usr/bin/env', 'python3', '-c', probe] });
    return new Promise(done => {
      const child = spawn(cmd, args, { cwd: box, env: { PATH: process.env.PATH, HOME: box } });
      let stdout = '', stderr = '';
      child.stdout.on('data', b => { stdout += b; });
      child.stderr.on('data', b => { stderr += b; });
      // an app or a job launched by an escape runs after the call returns: give it time to leave its marker
      child.on('close', status => setTimeout(() => {
        const left = readdirSync(marks);
        spawnSync('/bin/launchctl', ['remove', label]);
        http.close(); cleanup(dir);
        done({ status, stdout, stderr, marks: left, hits: [...hits] });
      }, 3000));
    });
  });
}

test('the macos sandbox lets no program outside it act for the run: no open, no Apple Events, no launchd job', {
  skip: process.platform !== 'darwin' ? 'macos runs on darwin only' : process.env.FM_TRACE_REQUIRE_SANDBOX === '1' ? false : !works.ok ? works.why : false,
}, async () => {
  const r = await probeEscapes();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['open-url', 'open-terminal', 'launchctl-submit', 'osascript-do-shell-script', 'osascript-terminal',
    'lsopen-url', 'lsopen-command', 'appleevent-terminal'].map(n => `${n} denied`));
  assert.deepEqual(r.marks, [], 'no escape left a marker outside scratch');
  assert.deepEqual(r.hits, [], 'no URL was fetched from outside the sandbox');
});

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

// a test that reads a credential file in the user's home folder (a fake one: HOME points at it), one that reads the
// original repo's ignored .env, and one that prints a token: the first two are denied and listed, the token redacted
test('the run cannot read the home folder or the original repo, and a printed token is redacted', { skip }, () => {
  const repo = realpathSync(gitRepo(REPO)), home = join(dirname(repo), 'home'), creds = join(home, '.aws', 'credentials');
  mkdirSync(join(home, '.aws'), { recursive: true });
  writeFileSync(creds, '[default]\naws_secret_access_key = FAKE-home-secret\n');
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  writeFileSync(join(repo, '.env'), 'API_TOKEN=FAKE-env-secret\n');
  writeFileSync(join(repo, 'tests', 'secret_paths.json'), JSON.stringify({ home: creds, env: join(repo, '.env') }));
  writeFileSync(join(repo, 'tests', 'test_secrets.py'), [
    'import json', 'import pathlib', '', 'PATHS = json.loads((pathlib.Path(__file__).parent / "secret_paths.json").read_text())', '', '',
    'def test_reads_a_home_secret():', '    print(open(PATHS["home"]).read())', '', '',
    'def test_reads_the_original_repo_env():', '    print(open(PATHS["env"]).read())', '', '',
    'def test_prints_a_token():', '    print("token=ghp_" + "a" * 36)', '    raise RuntimeError("API_KEY=sk-" + "b" * 24)', ''].join('\n'));
  const out = mineFixture(repo);
  const r = spawnSync(process.execPath, [join(SKILL, 'tools', 'trace.mjs'), '--codemap', join(out, 'codemap.json'),
    '--test-command', 'python3 -m pytest -q tests/test_secrets.py', OPT_IN], { cwd: dirname(out), encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const t = read(out, 'trace.json'), log = readFileSync(join(out, 'trace.log'), 'utf8');
  assert.equal(t.outcome.failed, 3);
  assert.deepEqual(t.deniedBySandbox.map(d => [d.nodeid, d.permission]),
    [['tests/test_secrets.py::test_reads_a_home_secret', true], ['tests/test_secrets.py::test_reads_the_original_repo_env', true]]);
  for (const text of [log, r.stdout, JSON.stringify(t)]) {
    assert.doesNotMatch(text, /FAKE-(home|env)-secret/, 'no secret was read');
    assert.doesNotMatch(text, /ghp_a{36}|sk-b{24}/, 'the printed token is redacted');
  }
  assert.match(log, /token=\[REDACTED\]/);
  assert.match(t.failures.find(f => f.nodeid.endsWith('test_prints_a_token')).message, /API_KEY=\[REDACTED\]/);
  cleanup(dirname(repo)); cleanup(dirname(out));
});

// the repo's own virtualenv lives in the repo: the sandbox exposes it and nothing else of the original repo, and an
// editable install in it (a .pth line pointing into the original repo) imports from the copy
test('a virtualenv inside the repo runs, and an editable install in it imports from the copy', { skip }, () => {
  const repo = realpathSync(gitRepo(REPO)), venv = join(repo, '.venv');
  writeFileSync(join(repo, '.gitignore'), '.venv/\n');
  const made = spawnSync('python3', ['-m', 'venv', '--system-site-packages', '--without-pip', venv], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const lib = join(venv, 'lib', readdirSync(join(venv, 'lib'))[0], 'site-packages');
  writeFileSync(join(lib, 'fm_editable.pth'), join(repo, 'libsrc') + '\n');
  mkdirSync(join(repo, 'libsrc'));
  writeFileSync(join(repo, 'libsrc', 'extra.py'), 'def shout(s):\n    return s.upper()\n');
  writeFileSync(join(repo, 'tests', 'test_extra.py'), 'from extra import shout\n\n\ndef test_shout():\n    assert shout("a") == "A"\n');
  const out = mineFixture(repo);
  const r = trace(out, '.venv/bin/python -m pytest -q tests/test_extra.py');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const t = read(out, 'trace.json');
  assert.equal(t.argv[0], join(venv, 'bin', 'python'));
  assert.deepEqual([t.outcome.passed, t.outcome.failed, t.outcome.errors], [1, 0, 0], readFileSync(join(out, 'trace.log'), 'utf8'));
  assert.deepEqual(t.byTest['tests.test_extra:test_shout'].ran, ['libsrc.extra:shout', 'tests.test_extra:test_shout']);
  cleanup(dirname(repo)); cleanup(dirname(out));
});

// a submodule and an untracked nested repo are copied by their own git view: what their .gitignore ignores (and their
// .git) never reaches scratch, their other files do
test('a submodule or a nested repo is copied without the files its own .gitignore ignores', { skip }, () => {
  const repo = realpathSync(gitRepo(REPO)), sub = join(repo, 'vendor', 'sub'), nested = join(repo, 'nested');
  for (const [d, ignored] of [[sub, '.env'], [nested, 'secret.txt']]) {
    mkdirSync(d, { recursive: true });
    git(d, 'init', '-q');
    writeFileSync(join(d, '.gitignore'), `${ignored}\n`);
    writeFileSync(join(d, ignored), 'FAKE-nested-secret\n');
    writeFileSync(join(d, 'kept.txt'), 'kept\n');
  }
  git(sub, 'add', '-A');
  git(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'sub');
  const head = spawnSync('git', ['-C', sub, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${head},vendor/sub`);
  writeFileSync(join(sub, 'untracked.txt'), 'untracked\n');
  writeFileSync(join(repo, 'tests', 'test_copy.py'), [
    'import os', '', '',
    'def test_copied():', '    assert [os.path.exists(p) for p in ["vendor/sub/kept.txt", "vendor/sub/untracked.txt", "nested/kept.txt"]] == [True] * 3', '', '',
    'def test_not_copied():', '    assert [p for p in ["vendor/sub/.env", "nested/secret.txt", "vendor/sub/.git", "nested/.git"] if os.path.lexists(p)] == []', ''].join('\n'));
  const out = mineFixture(repo);
  const r = trace(out, 'python3 -m pytest -q tests/test_copy.py');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const t = read(out, 'trace.json');
  assert.deepEqual(t.failures, []);
  assert.deepEqual([t.outcome.passed, t.outcome.failed], [2, 0]);
  cleanup(dirname(repo)); cleanup(dirname(out));
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
  assert.equal(t.byTest['tests.test_slow:test_slow'].status, 'error', 'a test the limit cut off did not pass');
  assert.deepEqual([t.outcome.passed, t.outcome.errors], [0, 1]);
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
