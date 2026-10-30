#!/usr/bin/env node
/* =============================================================================
   trace.mjs — run the repo's own test suite once, in a sandboxed scratch copy,
   under a profiler; mark the static edges that fired as observed and attribute
   every call to the test it ran under (design §3.17, ADR-014). OPT-IN.

   Usage:
     node tools/trace.mjs --codemap out/<name>/codemap.json --test-command "<cmd>"
                          --i-ran-this-by-the-user [--timeout 900]

   Only the stage-1t prompt passes --i-ran-this-by-the-user, after the user said
   yes to this exact command. The boundary, all of it enforced here:
     - only a recognised test runner: pytest, py.test, python -m pytest,
       python -m unittest; node --test, npx jest, npx vitest (or jest / vitest
       from the repo's node_modules/.bin, never installed; run from the package
       that holds them, the repo root or one below it); go test [-C dir]
       (lib/trace-go.mjs); make test / make check [-C dir] (lib/trace-c.mjs)
       (no shell syntax, no wrapper such as `uv run`);
     - only in a scratch copy of the repo (its git-tracked and unignored files;
       a submodule or nested repo by its own git view, never whole),
       inside this platform's OS sandbox: no network of any kind (IP, localhost,
       unix-socket connects), no writes outside scratch, no program outside the
       sandbox acting for the run, no reads of the user's
       home folder or the original repo (only the copy, the interpreter and its
       virtualenv; for Go, exactly its GOROOT and GOMODCACHE), an empty environment (HOME and TMPDIR in scratch), no
       bytecode or cache writes, a time limit;
     - no sandbox, no run: a platform without one, or a sandbox that cannot
       start here, is a refusal, never a fallback.
   Writes trace.json beside the code map: an overlay (observed pairs, the static
   edges that fired, per-test attribution, outcome, the tests the sandbox
   denied), and trace.log (the run's output). A JavaScript / TypeScript runner is
   run once per test file under V8 precise coverage (NODE_V8_COVERAGE): what ran is
   attributed per test file, and no caller -> callee pair is recorded (lib/observe-v8.mjs). `go test` runs once per test
   under -coverprofile (what ran is attributed to that test); `make` builds and runs its target once with coverage, routed per
   recipe line, and gcov reads what ran (attributed to each test binary); neither records a caller -> callee pair (lib/observe-coverage.mjs).
   Credential-shaped strings are redacted from the log, its tail and the failure messages. The code map is
   never edited and no static edge is ever removed. Failing tests are data:
   never retried.

   Exit: 0 ok · 1 refused: no opt-in flag; or bad flags or inputs
         · 2 the run produced no trace records · 3 refused: not a recognised test
         command · 4 refused: no sandbox on this platform · 5 timed out (the
         partial trace is kept and marked)
   ========================================================================== */
import { readFileSync, writeFileSync, existsSync, realpathSync, mkdtempSync, mkdirSync, rmSync, readdirSync, lstatSync,
  copyFileSync, symlinkSync, readlinkSync, chmodSync } from 'node:fs';
import { join, resolve, dirname, sep, relative, basename, isAbsolute, posix } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pickSandbox, sandboxArgv, exposable, readRunFile, readRunJson, SANDBOX_LABEL } from './lib/sandbox.mjs';
import { redactSecrets } from './lib/redact.mjs';
import { observe } from './lib/observe.mjs';
import { observeV8, parseTap, parseJestJson } from './lib/observe-v8.mjs';
import { recogniseJs, jsTestFiles, passThrough, runnerPackage, nodeModulesDirs, nodeModulesLinks, fileArgv } from './lib/trace-js.mjs';
import { recogniseGo, goModuleDir, goTestsToRun, goTestArgv, parseGoTestJson, parseCoverProfile, GO_NETWORK } from './lib/trace-go.mjs';
import { recogniseMake, makeArgv, makefileShell, lineHeads, isNativeExecutable, parseGcov, parseCTestOutput, C_NETWORK } from './lib/trace-c.mjs';
import { observeCoverage, symbolsRan, linesToBlocks } from './lib/observe-coverage.mjs';

const fail = (code, msg) => { console.error(`[trace] ${msg}`); process.exit(code); };
const PAYLOAD = join(dirname(fileURLToPath(import.meta.url)), 'trace', 'python');
const JS_PAYLOAD = join(dirname(fileURLToPath(import.meta.url)), 'trace', 'js');
const C_SHELL = join(dirname(fileURLToPath(import.meta.url)), 'trace', 'c', 'fmtrace-sh');

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
const VALUED = new Set(['--codemap', '--test-command', '--timeout']);
const flags = new Map();
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) { if (argv[i + 1] == null) fail(1, `${argv[i]} needs a value`); flags.set(argv[i], argv[++i]); }
  else if (argv[i] === '--i-ran-this-by-the-user') flags.set(argv[i], true);
  else fail(1, `unknown argument ${argv[i]}`);
}
const USAGE = 'usage: trace.mjs --codemap out/<name>/codemap.json --test-command "<cmd>" --i-ran-this-by-the-user [--timeout 900]';
if (!flags.has('--codemap') || !flags.has('--test-command')) fail(1, USAGE);
if (!flags.has('--i-ran-this-by-the-user'))
  fail(1, 'refused: tracing runs the repo\'s test code on this machine, so it runs only after the user said yes to this exact command (--i-ran-this-by-the-user, set by the stage-1t prompt)');
const timeoutSec = flags.has('--timeout') ? Number(flags.get('--timeout')) : 900;
if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) fail(1, '--timeout must be a whole number of seconds');

/* ---------------- the test command ---------------- */
// split like a POSIX shell, but refuse anything a shell would expand, chain or redirect: the command runs without one
function splitCommand(s) {
  const out = []; let cur = null, i = 0;
  const push = c => { cur = (cur ?? '') + c; };
  while (i < s.length) {
    const c = s[i];
    if (c === "'") { const j = s.indexOf("'", i + 1); if (j < 0) return null; push(s.slice(i + 1, j)); i = j + 1; continue; }
    if (c === '"') { let j = i + 1, v = '';
      for (; j < s.length && s[j] !== '"'; j++) { if ('$`'.includes(s[j])) return null; if (s[j] === '\\' && '"\\'.includes(s[j + 1])) j++; v += s[j]; }
      if (j >= s.length) return null; push(v); i = j + 1; continue; }
    if (c === '\\') { if (i + 1 >= s.length) return null; push(s[i + 1]); i += 2; continue; }
    if (/\s/.test(c)) { if (cur !== null) out.push(cur); cur = null; i++; continue; }
    if ('|&;<>()$`{}\n'.includes(c)) return null;
    push(c); i++;
  }
  if (cur !== null) out.push(cur);
  return out;
}
const COMMAND = flags.get('--test-command');
const words = splitCommand(COMMAND);
const NOT_TEST = `refused: "${COMMAND}" is not a recognised test command. Accepted: pytest [args], py.test [args], python -m pytest [args], python -m unittest [args] (python, python3 or python3.N, by name or path); node --test [--test-* flags] [paths], npx jest [args], npx vitest [run] [args] (or jest / vitest from the repo's node_modules/.bin); go test [-C dir] [-run/-skip/-short/-v/-count/-tags/-timeout/-failfast/-p/-parallel/-cpu] [./pkg/...]; make test, make check, make -C <dir> test|check; with no shell syntax and no wrapper, a jest or vitest flag's value given as -t=name or -t name (only for the flags that take one; every other flag is boolean, so a word after it is a test path or filter), and none of the flags the trace sets itself (watch, reporter, coverage, pool); nothing but the repo's own test suite is ever traced`;
if (!words?.length) fail(3, NOT_TEST);
let runner, testArgs, lang = 'python';
const head = basename(words[0]);
const js = recogniseJs(words), goCmd = recogniseGo(words), makeCmd = recogniseMake(words);
if (/^(pytest|py\.test)$/.test(head)) { runner = 'pytest'; testArgs = words.slice(1); }
else if (/^python(\d+(\.\d+)?)?$/.test(head) && words[1] === '-m' && ['pytest', 'unittest'].includes(words[2])) { runner = words[2]; testArgs = words.slice(3); }
else if (js) { lang = 'js'; runner = js.runner; testArgs = js.args; }
else if (goCmd) { lang = 'go'; runner = goCmd.runner; testArgs = words.slice(1); }
else if (makeCmd) { lang = 'c'; runner = makeCmd.runner; testArgs = words.slice(1); }
else fail(3, NOT_TEST);

/* ---------------- the sandbox ---------------- */
const box = pickSandbox();
if (!box.kind) fail(4, `refused: ${box.why}. Tracing runs only inside an OS sandbox (sandbox-exec on macOS, bwrap on Linux); stage 1t is not offered without one`);

/* ---------------- the code map and the repo ---------------- */
const CODEMAP = resolve(flags.get('--codemap'));
let m;
try { m = JSON.parse(readFileSync(CODEMAP, 'utf8')); } catch (e) { fail(1, `cannot read the code map ${CODEMAP}: ${e.message}`); }
if (m.schema !== 1 || !Array.isArray(m.symbols) || !Array.isArray(m.edges) || !m.root) fail(1, `${CODEMAP} is not a mine.mjs code map (schema 1)`);
if (!existsSync(m.root)) fail(1, `the mined repo ${m.root} no longer exists`);
const ROOT = realpathSync(m.root), OUT = realpathSync(dirname(CODEMAP));
if (OUT === ROOT || OUT.startsWith(ROOT + sep)) fail(1, `refusing to write inside the repo: ${OUT}`);

// the repo's own interpreter: a path is taken relative to the repo; a bare name is looked up in the repo's
// virtualenv, then on PATH. Virtualenvs are not copied, so the interpreter runs from where it is, read-only, even when
// it lives in the repo (its .venv): the sandbox exposes that virtualenv and nothing else of the original repo
function findExecutable(word) {
  if (word.includes('/')) { const p = isAbsolute(word) ? word : join(ROOT, word); return existsSync(p) ? p : null; }
  for (const d of [join(ROOT, '.venv', 'bin'), join(ROOT, 'venv', 'bin'), ...(process.env.PATH || '').split(':').filter(Boolean)])
    if (existsSync(join(d, word))) return join(d, word);
  return null;
}
// a JavaScript runner runs on the node the command names (by path), else the node on PATH, from the repo's own
// node_modules (never installed, never npx's cache)
const onPath = word => (process.env.PATH || '').split(':').filter(Boolean).map(d => join(d, word)).find(p => existsSync(p)) || null;
const exe = lang === 'js' ? (runner === 'node-test' && words[0].includes('/') ? findExecutable(words[0]) : onPath('node'))
  : lang === 'go' || lang === 'c' ? (words[0].includes('/') ? findExecutable(words[0]) : onPath(words[0])) : findExecutable(words[0]);
if (!exe) fail(1, lang === 'js' ? 'cannot find node on PATH' : lang === 'go' || lang === 'c' ? `cannot find ${words[0]} on PATH` : `cannot find ${words[0]} (looked in the repo's .venv/bin and venv/bin, then on PATH)`);
// the Go toolchain's own root and module cache (the repo's dependencies), asked of the go named, outside the sandbox
const goBin = lang === 'go' ? realpathSync(exe) : null;
const goEnv = lang === 'go' ? (() => { const r = spawnSync(goBin, ['env', 'GOROOT', 'GOMODCACHE', 'GOVERSION'], { encoding: 'utf8', env: { ...process.env, GOTOOLCHAIN: 'local' } });
  const [root, modcache, version] = (r.stdout || '').split('\n'); return r.status === 0 ? { root, modcache, version } : null; })() : null;
if (lang === 'go' && !goEnv?.root) fail(1, `cannot ask ${exe} for its GOROOT`);
// the run may read exactly those two dirs of the home folder (the go it runs is the one inside GOROOT), never one that
// is the home folder or holds it
if (lang === 'go') {
  const home = realpathSync(homedir()), within = (p, d) => p === d || p.startsWith(d === '/' ? '/' : d + sep);
  for (const [k, p] of [['GOROOT', goEnv.root], ['GOMODCACHE', goEnv.modcache]]) if (p && existsSync(p) && within(home, realpathSync(p)))
    fail(1, `refused: ${k} is ${p}, which is or holds your home folder; the trace exposes only the Go toolchain and its module cache, read-only, never the rest of your home folder: set ${k} to a dir of its own`);
  if (within(goBin, home) && !within(goBin, realpathSync(goEnv.root)))
    fail(1, `refused: ${goBin} is in your home folder outside its GOROOT ${goEnv.root}; the trace exposes only the Go toolchain and its module cache: name the go inside GOROOT/bin`);
}
const gcov = lang === 'c' ? onPath('gcov') : null;
if (lang === 'c' && !gcov) fail(1, 'cannot find gcov on PATH: the C / C++ trace reads coverage with it');
// jest and vitest run from the package that holds them (the repo root, or one below it such as frontend/)
const pkg = lang === 'js' && runner !== 'node-test' ? runnerPackage(ROOT, m, runner) : { dir: '', bin: null };
if (pkg.why) fail(1, `refused: ${pkg.why}: tracing runs only the repo's own installed test runner and never installs packages`);
const bin = pkg.bin, PKG = pkg.dir;
const jsFiles = lang === 'js' ? jsTestFiles(m, runner, testArgs, PKG) : [];
if (lang === 'js' && !jsFiles.length) fail(2, `no test file in the code map matches ${runner}'s test-file pattern${passThrough(runner, testArgs).length < testArgs.length ? ' among the files the paths or filters given select' : ''}: nothing to trace`);
const runArgs = runner === 'pytest' && !testArgs.some((a, i) => a === 'no:cacheprovider' && testArgs[i - 1] === '-p') ? [...testArgs, '-p', 'no:cacheprovider'] : testArgs;
const testArgv = lang === 'js' ? fileArgv({ runner, node: exe, bin, flags: passThrough(runner, testArgs), file: '<test file>', report: '<report>' })
  : lang === 'go' ? goTestArgv({ go: goBin, flags: goCmd.flags, name: '<TestName>', profile: '<profile>', pkgDir: '<package>' })
  : lang === 'c' ? makeArgv({ make: exe, dir: makeCmd.dir, target: makeCmd.target, shell: '<fmtrace-sh>' })
  : /^(pytest|py\.test)$/.test(head) ? [exe, ...runArgs] : [exe, '-m', runner, ...runArgs];

// what the sandbox must still let the run read: the interpreter's prefix, its virtualenv and the prefix that
// virtualenv was made from; for Go, exactly its GOROOT and GOMODCACHE. Never the original repo: the run sees only the
// copy
function readOnlyPaths() {
  const paths = [];
  if (lang === 'go') return [...new Set([goEnv.root, goEnv.modcache].filter(p => p && existsSync(p)).map(p => realpathSync(p)))];
  if (lang === 'c') return [...new Set([dirname(exe), dirname(realpathSync(exe)), dirname(gcov), dirname(realpathSync(gcov))].map(p => realpathSync(p)))];
  if (lang === 'js') {   // node's prefix (as named and as installed) and the repo's node_modules, linked into the copy
    for (const prefix of new Set([dirname(dirname(exe)), dirname(dirname(realpathSync(exe)))])) paths.push(realpathSync(prefix));
    for (const d of nodeModulesDirs(ROOT)) paths.push(realpathSync(join(ROOT, d)));
    return [...new Set(paths)];
  }
  for (const prefix of new Set([dirname(dirname(exe)), dirname(dirname(realpathSync(exe)))])) {
    paths.push(realpathSync(prefix));
    const cfg = join(prefix, 'pyvenv.cfg');
    if (!existsSync(cfg)) continue;
    const text = readFileSync(cfg, 'utf8'), get = k => text.match(new RegExp(`^\\s*${k}\\s*=\\s*(.+?)\\s*$`, 'm'))?.[1];
    const home = get('home'), base = get('base-prefix');
    if (home && existsSync(home)) paths.push(dirname(realpathSync(home)));
    if (base && existsSync(base)) paths.push(realpathSync(base));
  }
  return [...new Set(paths)];
}
// what the run must not read: the user's home folder (keys, cloud and git credentials) and the original repo (an
// ignored .env, other untracked files)
const HIDDEN = [...new Set([homedir(), ROOT].filter(p => p && existsSync(p)).map(p => realpathSync(p)))];

// the files to copy under dir, relative to it: git's view when dir is in a work tree (tracked plus untracked-but-not-
// ignored files, so no .git, no ignored .env, no virtualenv), else every file but .git and virtualenvs. A submodule
// or a nested repo is listed by its own git view, never copied whole, so nothing its own .gitignore ignores is copied
function repoFiles(dir) {
  const files = [];
  const nested = rel => existsSync(join(dir, rel, '.git')) ? repoFiles(join(dir, rel)).map(f => `${rel}/${f}`) : [];
  const g = spawnSync('git', ['-C', dir, 'ls-files', '-z', '-co', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (g.status === 0) for (const f of g.stdout.split('\0').filter(Boolean)) {
    const rel = f.replace(/\/$/, '');
    let st; try { st = lstatSync(join(dir, rel)); } catch { continue; }
    files.push(...(st.isDirectory() ? nested(rel) : [rel]));
  }
  else (function walk(rel) {
    for (const name of readdirSync(join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name, st = lstatSync(join(dir, r));
      if (!st.isDirectory()) files.push(r);
      else if (existsSync(join(dir, r, '.git'))) files.push(...nested(r));
      else if (name !== '.git' && !existsSync(join(dir, r, 'pyvenv.cfg'))) walk(r);
    }
  })('');
  return files;
}

// copy the repo's files (repoFiles) into dest
function copyRepo(dest) {
  const files = repoFiles(ROOT);
  for (const f of files) {
    const src = join(ROOT, f), dst = join(dest, f);
    let st; try { st = lstatSync(src); } catch { continue; }
    mkdirSync(dirname(dst), { recursive: true });
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), dst);
    else if (st.isFile()) copyFileSync(src, dst);
  }
  return files;
}

/* ---------------- run ---------------- */
for (const f of ['trace.json', 'trace.log']) rmSync(join(OUT, f), { force: true });
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'fmtrace-')));
const COPY = join(SCRATCH, 'repo'), TRACE_OUT = join(SCRATCH, 'out');
for (const d of [COPY, TRACE_OUT, join(SCRATCH, 'trace'), join(SCRATCH, 'home'), join(SCRATCH, 'tmp')]) mkdirSync(d, { recursive: true });

// one sandboxed run, its process group killed at the time limit; resolves with its output
function runSandboxed(argv, env, { box: kind, readOnly, limitMs, cwd = COPY }) {
  const [cmd, ...args] = sandboxArgv(kind, { scratch: SCRATCH, hidden: HIDDEN, readOnly, argv });
  const out = [], all = [];
  return new Promise(done => {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false, killer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      killer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 10000);
    }, Math.max(1, limitMs));
    child.stdout.on('data', b => { out.push(b); all.push(b); });
    child.stderr.on('data', b => all.push(b));
    child.on('error', e => { clearTimeout(timer); done({ status: null, error: e.message, timedOut, stdout: Buffer.concat(out).toString('utf8'), log: Buffer.concat(all) }); });
    child.on('close', (status, signal) => { clearTimeout(timer); if (killer) clearTimeout(killer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      done({ status, signal, timedOut, stdout: Buffer.concat(out).toString('utf8'), log: Buffer.concat(all) }); });
  });
}

let code = 0;
try {
  const copiedFiles = copyRepo(COPY), copied = copiedFiles.length;
  const sha = p => { try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return null; } };
  const changedFiles = (m.files || []).filter(f => f.sha256 && sha(join(COPY, f.path)) !== f.sha256).map(f => f.path);
  const readOnly = readOnlyPaths(), shown = readOnly.filter(p => exposable(p, { scratch: SCRATCH, hidden: HIDDEN }));
  for (const p of readOnly.filter(p => !shown.includes(p)))
    console.log(`[trace] not exposing ${p} to the run: it holds your home folder, the repo or scratch`);
  if (lang === 'js') code = await runJs({ copied, changedFiles, shown });
  else if (lang === 'go') code = await runGo({ copied, changedFiles, shown });
  else if (lang === 'c') code = await runC({ copied, copiedFiles, changedFiles, shown });
  else {
    for (const f of readdirSync(PAYLOAD).filter(f => f.endsWith('.py'))) copyFileSync(join(PAYLOAD, f), join(SCRATCH, 'trace', f));
    const env = {
      HOME: join(SCRATCH, 'home'), TMPDIR: join(SCRATCH, 'tmp'), PATH: `${dirname(exe)}:/usr/bin:/bin`,
      PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(SCRATCH, 'trace'),
      FM_TRACE_ROOT: COPY, FM_TRACE_OUT: TRACE_OUT, FM_TRACE_RUNNER: runner,
      // where the original repo was, which the sandbox hides: imports that point there (an editable install) are sent to
      // the copy, and a test that fails on reading a hidden path is listed as denied
      FM_TRACE_ORIGIN: [...new Set([ROOT, resolve(m.root)])].join(':'), FM_TRACE_HIDDEN: HIDDEN.join(':'),
      ...(runner === 'pytest' ? { PYTEST_PLUGINS: 'fmtrace_plugin' } : {}),
    };
    console.log(`[trace] ${SANDBOX_LABEL[box.kind]} · ${copied} files copied to scratch · running: ${testArgv.join(' ')} (limit ${timeoutSec}s)`);
    const t0 = Date.now();
    const run = await runSandboxed(testArgv, env, { box: box.kind, readOnly: shown, limitMs: timeoutSec * 1000 });
    const durationMs = Date.now() - t0;
    const logText = redactSecrets(run.log.toString('utf8'));
    writeFileSync(join(OUT, 'trace.log'), logText);
    const tail = logText.trimEnd().split('\n').slice(-12).join('\n');

    const dumps = readdirSync(TRACE_OUT).filter(f => /^trace-.*\.json$/.test(f)).sort().flatMap(f => {
      return readRunJson(join(TRACE_OUT, f)); });
    if (!dumps.length || !dumps.some(d => d.collected || Object.keys(d.outcomes || {}).length || d.fixtureErrors?.length)) {
      console.error(tail);
      console.error(`[trace] the run produced no trace records or ran no test (${run.error || (run.timedOut ? 'timed out' : `exit ${run.status ?? run.signal}`)}); its output is in ${join(OUT, 'trace.log')}`);
      code = 2;
    } else code = report(observe(m, dumps), { run, durationMs, tail, changedFiles });
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}
process.exit(code);

/* ---------------- JavaScript / TypeScript: one run per test file, under V8 coverage ---------------- */
async function runJs({ copied, changedFiles, shown }) {
  // the repo's node_modules are not copied (git ignores them): linked into the copy entry by entry, read-only through
  // the sandbox; a workspace package's link points at its copy
  const nm = nodeModulesDirs(ROOT);
  for (const d of nm) if (!existsSync(join(COPY, d))) {
    mkdirSync(join(COPY, d), { recursive: true });
    for (const l of nodeModulesLinks(ROOT, d, nm)) { mkdirSync(dirname(join(COPY, l.rel)), { recursive: true }); symlinkSync(l.copy != null ? join(COPY, l.copy) : join(ROOT, l.rel), join(COPY, l.rel)); }
  }
  for (const f of readdirSync(JS_PAYLOAD)) copyFileSync(join(JS_PAYLOAD, f), join(SCRATCH, 'trace', f));
  const nodeVersion = (spawnSync(exe, ['--version'], { encoding: 'utf8', env: {} }).stdout || '').trim() || null;
  console.log(`[trace] ${SANDBOX_LABEL[box.kind]} · ${copied} files copied to scratch · ${runner}${PKG ? ` from ${PKG}/` : ''}: ${jsFiles.length} test files, one run each under V8 coverage (limit ${timeoutSec}s in all)`);
  const deadline = Date.now() + timeoutSec * 1000, t0 = Date.now();
  const runs = [], logs = [];
  let timedOut = false, exitCode = 0;
  for (const [i, file] of jsFiles.entries()) {
    const left = deadline - Date.now();
    if (left <= 0) { timedOut = true; break; }
    const cov = join(TRACE_OUT, `v8-${i}`), rep = join(TRACE_OUT, `report-${i}.json`);
    mkdirSync(cov, { recursive: true });
    const env = {
      HOME: join(SCRATCH, 'home'), TMPDIR: join(SCRATCH, 'tmp'), PATH: `${dirname(exe)}:/usr/bin:/bin`,
      NODE_V8_COVERAGE: cov, NODE_OPTIONS: ['fmtrace-net.cjs', 'fmtrace-srcmap.cjs'].map(f => `--require ${JSON.stringify(join(SCRATCH, 'trace', f))}`).join(' '),
      FM_TRACE_OUT: TRACE_OUT, FM_TRACE_FILE: file, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0',
    };
    const argv = fileArgv({ runner, node: exe, bin, flags: passThrough(runner, testArgs), file: PKG ? relative(PKG, file) : file, report: rep });
    const run = await runSandboxed(argv, env, { box: box.kind, readOnly: shown, limitMs: left, cwd: join(COPY, PKG) });
    logs.push(`== ${file} (exit ${run.status ?? run.signal}${run.timedOut ? ', cut off by the time limit' : ''})\n${run.log.toString('utf8')}`);
    if (run.status && !exitCode) exitCode = run.status;
    let outcomes;
    if (runner === 'node-test') outcomes = parseTap(run.stdout);
    else outcomes = parseJestJson(readRunJson(rep)[0] ?? null, COPY);
    const coverage = readdirSync(cov).filter(f => f.endsWith('.json')).sort().flatMap(f => readRunJson(join(cov, f)));
    // the source maps of the scripts jest and vitest compiled through node:vm, which Node's dump does not record
    const maps = readdirSync(TRACE_OUT).filter(f => /^srcmap-.*\.json$/.test(f)).flatMap(f => { try { return readRunJson(join(TRACE_OUT, f)); } finally { rmSync(join(TRACE_OUT, f), { force: true }); } })
      .filter(s => s.file === file);
    for (const d of coverage) for (const s of maps) (d['source-map-cache'] ||= {})[s.url] ??= { lineLengths: s.lineLengths, data: s.data };
    const network = readdirSync(TRACE_OUT).filter(f => /^net-.*\.json$/.test(f)).sort().flatMap(f => readRunJson(join(TRACE_OUT, f)))
      .filter(n => n.file === file).flatMap(n => n.attempts);
    runs.push({ file, outcomes, coverage, network: [...new Set(network)], timedOut: run.timedOut, exitCode: run.status });
    if (run.timedOut) { timedOut = true; break; }
  }
  const durationMs = Date.now() - t0;
  const logText = redactSecrets(logs.join('\n'));
  writeFileSync(join(OUT, 'trace.log'), logText);
  const tail = logText.trimEnd().split('\n').slice(-12).join('\n');
  // V8 writes coverage for a runner that failed at startup too: no test reported in any file is no trace
  if (!runs.some(r => r.outcomes.tests.length)) {
    console.error(tail);
    console.error(`[trace] the run ran no test (${timedOut ? 'timed out' : `exit ${exitCode}`}); its output is in ${join(OUT, 'trace.log')}`);
    return 2;
  }
  const o = observeV8(m, runs, { root: COPY, readFile: rel => readRunFile(join(COPY, rel)), node: nodeVersion });
  return reportJs(o, { durationMs, tail, changedFiles, timedOut, exitCode, ranFiles: runs.map(r => r.file) });
}

function reportJs(o, { durationMs, tail, changedFiles, timedOut, exitCode, ranFiles }) {
  const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
  const trace = {
    schema: 1, tool: { name: 'trace.mjs', node: o.runtime.node },
    optIn: { by: 'user', at: new Date().toISOString(), command: COMMAND },
    sandbox: SANDBOX_LABEL[box.kind], runner, cwd: PKG || '.', argv: testArgv, files: jsFiles, ranFiles, timeoutSec, timedOut, exitCode, durationMs,
    codemap: { file: relative(OUT, CODEMAP), sha256: sha(CODEMAP), commit: m.commit ?? null, treeHash: m.treeHash ?? null, changedFiles },
    granularity: o.granularity, outcome: o.outcome, notCollected: o.notCollected, failures: o.failures.map(redactMessage), deniedBySandbox: o.deniedBySandbox.map(redactMessage), summary: o.summary,
    pairs: o.pairs, edges: o.edges, noStaticEdge: o.noStaticEdge, callbacks: o.callbacks, ran: o.ran, byFile: o.byFile, byTest: o.byTest,
  };
  writeFileSync(join(OUT, 'trace.json'), JSON.stringify(trace, null, 1) + '\n');
  const s = o.summary, oc = o.outcome, pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '-';
  console.log(tail.split('\n').slice(-3).map(l => `  | ${l}`).join('\n'));
  console.log(`[trace] ${ranFiles.length}/${jsFiles.length} test files run · ${oc.collected} tests: ${oc.passed} passed, ${oc.failed} failed, ${oc.errors} errors, ${oc.skipped} skipped · ${(durationMs / 1000).toFixed(1)}s${timedOut ? ' · TIMED OUT, partial trace' : ''}`);
  if (o.notCollected.length) console.log(`[trace] ${o.notCollected.length} test files ran but reported no test (the runner's config does not collect them, or they define none), their ${o.notCollected.reduce((n, f) => n + f.tests, 0)} tests left out of the share below: ${o.notCollected.slice(0, 5).map(f => f.file).join(', ')}`);
  console.log(`[trace] functions that ran (V8 coverage, per test file): ${Object.entries(s.functionsRan).map(([g, v]) => `${g} ${v.ran}/${v.total}`).join(', ')} · ${s.unmappedFunctions} named functions matched no symbol (${s.anonymousCallbacks} anonymous callbacks ran inside the symbols above)`);
  console.log(`[trace] per test file: direct links whose target ran in their test's file ${s.directLinksPerTest.observed}/${s.directLinksPerTest.total} (${pct(s.directLinksPerTest.observed, s.directLinksPerTest.total)}, ${s.directLinksPerTest.tests} tests) · hooks that ran ${s.fixtureLinks.observed}/${s.fixtureLinks.total}`);
  console.log(`[trace] caller -> callee pairs: ${s.pairs}`);
  console.log(`[trace] denied by the sandbox: ${o.deniedBySandbox.length ? o.deniedBySandbox.map(d => `${d.nodeid}${d.network.length ? ` [${d.network.join('; ')}]` : ''}${d.permission ? ' [permission]' : ''}`).join(' · ') : 'none'}`);
  if (changedFiles.length) console.log(`[trace] warning: ${changedFiles.length} mined files changed since the code map was written (${changedFiles.slice(0, 5).join(', ')}): mine again, then trace`);
  console.log(`[trace] wrote ${relative(process.cwd(), join(OUT, 'trace.json'))} and trace.log`);
  return timedOut ? 5 : 0;
}

/* ---------------- Go: one run per test, under -coverprofile ---------------- */
async function runGo({ copied, changedFiles, shown }) {
  const mod = goModuleDir(m, goCmd, existsSync(join(ROOT, 'go.mod')));
  if (mod.why) { console.error(`[trace] refused: ${mod.why}`); return 1; }
  const tests = goTestsToRun(m, goCmd, mod.dir);
  if (!tests.length) { console.error(`[trace] no TestXxx in the code map is in the packages ${goCmd.packages.join(' ')}${goCmd.run ? ` matching -run ${goCmd.run}` : ''} of ${mod.dir || 'the root'} module: nothing to trace`); return 2; }
  const modPath = /^\s*module\s+(\S+)/m.exec(readFileSync(join(COPY, mod.dir, 'go.mod'), 'utf8'))?.[1];
  const importDir = p => p === modPath ? mod.dir : p.startsWith(modPath + '/') ? [mod.dir, p.slice(modPath.length + 1)].filter(Boolean).join('/') : null;
  const env = {
    HOME: join(SCRATCH, 'home'), TMPDIR: join(SCRATCH, 'tmp'), PATH: `${dirname(goBin)}:/usr/bin:/bin`,
    GOCACHE: join(SCRATCH, 'gocache'), GOPATH: join(SCRATCH, 'gopath'), ...(goEnv.modcache && existsSync(goEnv.modcache) ? { GOMODCACHE: goEnv.modcache } : {}),
    GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local', GOTELEMETRY: 'off', GOENV: 'off', GOFLAGS: '', CGO_ENABLED: '0',
  };
  console.log(`[trace] ${SANDBOX_LABEL[box.kind]} · ${copied} files copied to scratch · go test in ${mod.dir || 'the root'} module: ${tests.length} tests, one run each under -coverprofile (limit ${timeoutSec}s in all)`);
  const deadline = Date.now() + timeoutSec * 1000, t0 = Date.now();
  const results = new Map(), units = [], failures = [], denied = [], logs = [];
  let timedOut = false;
  for (const [i, t] of tests.entries()) {
    const left = deadline - Date.now();
    if (left <= 0) { timedOut = true; break; }
    const profile = join(TRACE_OUT, `cover-${i}.out`);
    const argv = goTestArgv({ go: goBin, flags: goCmd.flags, name: t.name, profile, pkgDir: t.pkgDir });
    const run = await runSandboxed(argv, env, { box: box.kind, readOnly: shown, limitMs: left, cwd: join(COPY, mod.dir) });
    // the log keeps what go test printed, not its -json envelopes
    const printed = run.log.toString('utf8').split('\n').map(l => { if (!l.startsWith('{')) return l + '\n'; try { return JSON.parse(l).Output ?? ''; } catch { return l + '\n'; } }).join('');
    logs.push(`== ${t.id} (exit ${run.status ?? run.signal}${run.timedOut ? ', cut off by the time limit' : ''})\n${printed}`);
    const ev = parseGoTestJson(run.stdout);
    const r = ev.tests.find(x => x.name === t.name);
    const nodeid = `${t.pkgDir || '.'}::${t.name}`;
    const status = r?.status || (run.timedOut ? 'error' : ev.buildErrors.length || run.status ? 'error' : 'not run');
    const message = r?.message || ev.buildErrors.join('\n') || (run.timedOut ? 'cut off by the time limit' : '');
    results.set(t.id, { status, message, nodeid });
    const prof = readRunFile(profile), ran = prof == null ? new Set() : symbolsRan(m, parseCoverProfile(prof, importDir));
    units.push({ key: t.id, tests: [t.id], ran });
    if (status === 'failed' || status === 'error') {
      failures.push({ test: t.id, nodeid, status, phase: status === 'error' ? 'collect' : 'call', message });
      const network = [...new Set([...message.matchAll(GO_NETWORK)].map(x => x[0].trim()))];
      const permission = !network.length && /operation not permitted|permission denied|read-only file system/i.test(message);
      if (network.length || permission) denied.push({ test: t.id, nodeid, status, network, permission, message });
    }
    if (run.timedOut) { timedOut = true; break; }
  }
  for (const t of tests) if (!results.has(t.id)) results.set(t.id, { status: 'not run', message: 'the time limit was reached first', nodeid: `${t.pkgDir || '.'}::${t.name}` });
  const durationMs = Date.now() - t0;
  const logText = redactSecrets(logs.join('\n'));
  writeFileSync(join(OUT, 'trace.log'), logText);
  const tail = logText.trimEnd().split('\n').slice(-12).join('\n');
  if (![...results.values()].some(r => r.status === 'passed' || r.status === 'failed' || r.status === 'skipped')) {
    console.error(tail);
    console.error(`[trace] the run ran no test (${timedOut ? 'timed out' : 'every run failed to build or start'}); its output is in ${join(OUT, 'trace.log')}`);
    return 2;
  }
  const o = observeCoverage(m, { units, results, failures, denied, granularity: 'test', ownFile: f => f.endsWith('.go'), runtime: { go: goEnv.version || null } });
  return reportCoverage(o, { durationMs, tail, changedFiles, timedOut, exitCode: failures.length ? 1 : 0, cwd: mod.dir || '.', ran: tests.length });
}

/* ---------------- C / C++: the make target once, with coverage per test binary, read by gcov ---------------- */
async function runC({ copied, copiedFiles, changedFiles, shown }) {
  const dir = makeCmd.dir;
  const makefile = ['GNUmakefile', 'makefile', 'Makefile'].find(f => existsSync(join(COPY, dir, f)));
  if (!makefile) { console.error(`[trace] refused: no Makefile in ${dir || 'the repo root'}`); return 1; }
  const shell = join(SCRATCH, 'trace', 'fmtrace-sh'), UNITS = join(TRACE_OUT, 'units'), recipeShell = makefileShell(readRunFile(join(COPY, dir, makefile)) || '');
  copyFileSync(C_SHELL, shell); chmodSync(shell, 0o755); mkdirSync(UNITS);
  const env = { HOME: join(SCRATCH, 'home'), TMPDIR: join(SCRATCH, 'tmp'), PATH: [...new Set([dirname(exe), '/usr/local/bin', '/usr/bin', '/bin'])].join(':'), FM_TRACE_UNITS: UNITS,
    ...(recipeShell ? { FM_TRACE_SHELL: recipeShell } : {}) };
  const argv = makeArgv({ make: exe, dir, target: makeCmd.target, shell });
  console.log(`[trace] ${SANDBOX_LABEL[box.kind]} · ${copied} files copied to scratch · running: ${argv.join(' ')}, coverage per test binary (limit ${timeoutSec}s)`);
  const t0 = Date.now();
  const run = await runSandboxed(argv, env, { box: box.kind, readOnly: shown, limitMs: timeoutSec * 1000 });
  // each recipe line fmtrace-sh ran, in order: its command, the commands it runs, exit status, output and the counters
  // it wrote.
  // The run wrote these files, so only plain files inside its own line dirs are read, never through a symlink
  const gcdasIn = d => { const out = []; (function walk(p) { let st; try { st = lstatSync(p); } catch { return; }
    if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n)); else if (st.isFile() && p.endsWith('.gcda')) out.push(p); })(d); return out; };
  const lines = [...new Set((readRunFile(join(UNITS, 'order')) || '').split('\n').map(l => basename(l.trim())).filter(n => /^line-\w+$/.test(n)))]
    .filter(n => lstatSync(join(UNITS, n), { throwIfNoEntry: false })?.isDirectory())
    .map(n => { const d = join(UNITS, n), st = readRunFile(join(d, 'status')), command = readRunFile(join(d, 'command')) ?? '';
      return { dir: d, command, heads: lineHeads(command), status: st == null ? null : Number(st.trim()), output: readRunFile(join(d, 'output')) || '', gcdas: gcdasIn(join(d, 'gcda')) }; });
  // inside the same sandbox, each counter file and the notes file the compiler wrote beside its object are copied into
  // a fresh dir and read there by gcov: nothing outside the sandbox opens what the run wrote; a source is named as the
  // compiler saw it, from the make dir
  const cFiles = new Set((m.files || []).filter(f => f.lang === 'c' || f.lang === 'cpp').map(f => f.path));
  const toRepo = src => { const a = src.startsWith('/') ? (src.startsWith(COPY + '/') ? src.slice(COPY.length + 1) : null) : posix.normalize(posix.join(dir, src));
    if (a && cFiles.has(a)) return a; const hits = [...cFiles].filter(f => f.endsWith('/' + src.replace(/^(\.\.?\/)+/, ''))); return hits.length === 1 ? hits[0] : null; };
  // a head word that names a native executable in the copy which the repo did not hold: a binary the build produced
  const repoHeld = new Set(copiedFiles);
  const built = h => { const p = posix.normalize(h.startsWith('/') ? h : posix.join(COPY, dir, h));
    return h.includes('/') && p.startsWith(COPY + '/') && !repoHeld.has(p.slice(COPY.length + 1)) && isNativeExecutable(readRunFile(p, null)); };
  const GCOV_COPY = 'd=$(mktemp -d "$TMPDIR/gcov-XXXXXX") && cp -- "$1" "$d/x.gcda" && cp -- "$2" "$d/x.gcno" && exec "$3" -t -o "$d" "$d/x.gcda"';
  const units = [], seen = new Map();
  for (const l of lines.filter(x => x.gcdas.length)) {
    const counts = new Map();
    for (const g of l.gcdas) {
      const gcno = g.slice(join(l.dir, 'gcda').length).replace(/\.gcda$/, '.gcno');
      const r = await runSandboxed(['/bin/sh', '-c', GCOV_COPY, 'fmtrace-gcov', g, gcno, gcov], env, { box: box.kind, readOnly: shown, limitMs: 60000, cwd: join(COPY, dir) });
      for (const [src, ls] of parseGcov(r.stdout)) { const f = toRepo(src); if (f) (counts.get(f) || counts.set(f, []).get(f)).push(...linesToBlocks(ls)); }
    }
    const n = (seen.get(l.command) || 0) + 1; seen.set(l.command, n);
    const binaries = !!l.heads && l.heads.every(built);
    units.push({ key: n > 1 ? `${l.command} #${n}` : l.command, line: l, tests: [], ran: symbolsRan(m, counts), provesPass: binaries, provesFail: binaries && l.heads.length === 1 });
  }
  const durationMs = Date.now() - t0;
  const logText = redactSecrets(run.log.toString('utf8'));
  writeFileSync(join(OUT, 'trace.log'), logText);
  const tail = logText.trimEnd().split('\n').slice(-12).join('\n');
  if (!units.length) {
    console.error(tail);
    console.error(`[trace] the run wrote no coverage counters (${run.timedOut ? 'timed out' : `exit ${run.status ?? run.signal}`}): the target built nothing with $(CC) / $(CXX), or ran no test; its output is in ${join(OUT, 'trace.log')}`);
    return 2;
  }
  // a test belongs to the first binary its own lines ran in; it passed or failed as that binary's recipe line did, when
  // every command the line runs is a binary the build produced (one: either way; an && chain of them: 0 only), else
  // unknown, unless it printed a status of its own
  const printed = parseCTestOutput(logText);
  const tests = (m.tests || []).filter(t => cFiles.has(t.file) && (!dir || t.file.startsWith(dir + '/')));
  const results = new Map();
  for (const t of tests) {
    const s = m.symbols.find(x => x.id === t.id), name = s?.name || t.id.split(':').pop(), u = units.find(x => x.ran.has(t.id));
    if (u) u.tests.push(t.id);
    const status = printed.get(name) || (!u ? 'not run' : u.line.status === 0 ? (u.provesPass ? 'passed' : 'unknown') : u.provesFail ? 'failed' : 'unknown');
    results.set(t.id, { status, message: status === 'failed' || status === 'unknown' ? (u?.line.output.trim() || tail) : '', nodeid: `${t.file}::${name}` });
  }
  const failures = [...results].filter(([, r]) => r.status === 'failed').map(([id, r]) => ({ test: id, nodeid: r.nodeid, status: 'failed', phase: 'call', message: r.message }));
  const failedLine = lines.find(l => l.status);
  if ((run.status || run.timedOut) && !failures.length)
    failures.push({ test: null, nodeid: failedLine?.command || `make ${makeCmd.target}`, status: 'error', phase: 'run', message: run.timedOut ? 'cut off by the time limit' : failedLine?.output.trim() || tail });
  // a binary whose output shows a refused connect or a permission error was denied by the sandbox
  const denied = lines.flatMap(l => {
    const network = [...new Set([...l.output.matchAll(C_NETWORK)].map(x => x[0].trim()))];
    const permission = !network.length && !!l.status && /Operation not permitted|Permission denied|Read-only file system/.test(l.output);
    if (!network.length && !permission) return [];
    const f = failures.find(x => units.find(u => u.line === l)?.tests.includes(x.test)) || failures.find(x => !x.test && x.nodeid === l.command);
    return [{ test: f?.test || null, nodeid: f?.nodeid || l.command, status: f?.status || (l.status ? 'failed' : 'passed'), network, permission, message: l.output.trim() }];
  });
  const o = observeCoverage(m, { units: units.map(u => ({ key: u.key, tests: u.tests, ran: u.ran })), results, failures, denied, granularity: 'binary', ownFile: f => cFiles.has(f), runtime: {} });
  return reportCoverage(o, { durationMs, tail, changedFiles, timedOut: run.timedOut, exitCode: run.status, cwd: dir || '.', ran: tests.length });
}

function reportCoverage(o, { durationMs, tail, changedFiles, timedOut, exitCode, cwd, ran }) {
  const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
  const trace = {
    schema: 1, tool: { name: 'trace.mjs', ...o.runtime },
    optIn: { by: 'user', at: new Date().toISOString(), command: COMMAND },
    sandbox: SANDBOX_LABEL[box.kind], runner, cwd, argv: testArgv, timeoutSec, timedOut, exitCode, durationMs,
    codemap: { file: relative(OUT, CODEMAP), sha256: sha(CODEMAP), commit: m.commit ?? null, treeHash: m.treeHash ?? null, changedFiles },
    granularity: o.granularity, outcome: o.outcome, failures: o.failures.map(redactMessage), deniedBySandbox: o.deniedBySandbox.map(redactMessage), summary: o.summary,
    pairs: o.pairs, edges: o.edges, noStaticEdge: o.noStaticEdge, callbacks: o.callbacks, ran: o.ran, byUnit: o.byUnit, byTest: o.byTest,
  };
  writeFileSync(join(OUT, 'trace.json'), JSON.stringify(trace, null, 1) + '\n');
  const s = o.summary, oc = o.outcome, pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '-';
  console.log(tail.split('\n').slice(-3).map(l => `  | ${l}`).join('\n'));
  console.log(`[trace] ${oc.collected} tests (${ran} in scope): ${oc.passed} passed, ${oc.failed} failed, ${oc.errors} errors, ${oc.skipped} skipped${oc.unknown ? `, ${oc.unknown} ran with no status of their own` : ''}${oc.notRun ? `, ${oc.notRun} not run` : ''} · ${(durationMs / 1000).toFixed(1)}s${timedOut ? ' · TIMED OUT, partial trace' : ''}`);
  console.log(`[trace] functions that ran (coverage, per ${o.granularity}): ${Object.entries(s.functionsRan).map(([g, v]) => `${g} ${v.ran}/${v.total}`).join(', ')}`);
  console.log(`[trace] per ${o.granularity}: direct links whose target ran ${s.directLinksPerTest.observed}/${s.directLinksPerTest.total} (${pct(s.directLinksPerTest.observed, s.directLinksPerTest.total)}, ${s.directLinksPerTest.tests} tests) · hooks that ran ${s.fixtureLinks.observed}/${s.fixtureLinks.total}`);
  console.log(`[trace] caller -> callee pairs: ${s.pairs}`);
  console.log(`[trace] denied by the sandbox: ${o.deniedBySandbox.length ? o.deniedBySandbox.map(d => `${d.nodeid}${d.network.length ? ` [${d.network.join('; ')}]` : ''}${d.permission ? ' [permission]' : ''}`).join(' · ') : 'none'}`);
  if (changedFiles.length) console.log(`[trace] warning: ${changedFiles.length} mined files changed since the code map was written (${changedFiles.slice(0, 5).join(', ')}): mine again, then trace`);
  console.log(`[trace] wrote ${relative(process.cwd(), join(OUT, 'trace.json'))} and trace.log`);
  return timedOut ? 5 : 0;
}

/* ---------------- trace.json and the summary ---------------- */
function redactMessage(f) { return { ...f, message: redactSecrets(f.message) }; }
function report(o, { run, durationMs, tail, changedFiles }) {
  const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
  const trace = {
    schema: 1, tool: { name: 'trace.mjs', python: o.python },
    optIn: { by: 'user', at: new Date().toISOString(), command: COMMAND },
    sandbox: SANDBOX_LABEL[box.kind], runner, argv: testArgv, timeoutSec, timedOut: run.timedOut, exitCode: run.status, durationMs,
    codemap: { file: relative(OUT, CODEMAP), sha256: sha(CODEMAP), commit: m.commit ?? null, treeHash: m.treeHash ?? null, changedFiles },
    outcome: o.outcome, failures: o.failures.map(redactMessage), deniedBySandbox: o.deniedBySandbox.map(redactMessage), summary: o.summary,
    pairs: o.pairs, edges: o.edges, noStaticEdge: o.noStaticEdge, callbacks: o.callbacks, byTest: o.byTest,
  };
  writeFileSync(join(OUT, 'trace.json'), JSON.stringify(trace, null, 1) + '\n');

  const s = o.summary, pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '-';
  const oc = o.outcome;
  console.log(tail.split('\n').slice(-3).map(l => `  | ${l}`).join('\n'));
  console.log(`[trace] ${oc.collected} collected: ${oc.passed} passed, ${oc.failed} failed, ${oc.errors} errors, ${oc.skipped} skipped${oc.xfailed || oc.xpassed ? `, ${oc.xfailed} xfailed, ${oc.xpassed} xpassed` : ''} · ${(durationMs / 1000).toFixed(1)}s${run.timedOut ? ' · TIMED OUT, partial trace' : ''}`);
  console.log(`[trace] ${s.distinctPairs} distinct caller -> callee pairs · functions that ran: ${Object.entries(s.functionsRan).map(([g, v]) => `${g} ${v.ran}/${v.total}`).join(', ')}`);
  console.log(`[trace] static edges observed ${s.edges.all.observed}/${s.edges.all.total} (${pct(s.edges.all.observed, s.edges.all.total)}) · production -> production ${s.edges.prodToProd.observed}/${s.edges.prodToProd.total} · test -> non-test ${s.edges.testToNonTest.observed}/${s.edges.testToNonTest.total}`);
  console.log(`[trace] per test: direct links that ran under their own test ${s.directLinksPerTest.observed}/${s.directLinksPerTest.total} (${pct(s.directLinksPerTest.observed, s.directLinksPerTest.total)}, ${s.directLinksPerTest.tests} tests) · fixture links ${s.fixtureLinks.observed}/${s.fixtureLinks.total}`);
  console.log(`[trace] callback links observed: ${o.callbacks.length}${o.callbacks.map(c => `\n  ${c.from} -> ${c.to} (handed over by ${c.passedBy}, ${c.tests} tests)`).join('')}`);
  console.log(`[trace] observed calls with no static edge: ${s.noStaticEdge.pairs} (${Object.entries(s.noStaticEdge.byCategory).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})${o.noStaticEdge.filter(x => x.category === 'other').map(x => `\n  ${x.from} -> ${x.to}`).join('')}`);
  console.log(`[trace] denied by the sandbox: ${o.deniedBySandbox.length ? o.deniedBySandbox.map(d => `${d.nodeid}${d.network.length ? ` [${d.network.join('; ')}]` : ''}${d.permission ? ' [permission]' : ''}`).join(' · ') : 'none'}`);
  if (changedFiles.length) console.log(`[trace] warning: ${changedFiles.length} mined files changed since the code map was written (${changedFiles.slice(0, 5).join(', ')}): mine again, then trace`);
  console.log(`[trace] wrote ${relative(process.cwd(), join(OUT, 'trace.json'))} and trace.log`);
  return run.timedOut ? 5 : 0;
}
