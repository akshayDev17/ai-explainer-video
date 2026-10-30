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
       python -m unittest (no shell syntax, no wrapper such as `uv run`);
     - only in a scratch copy of the repo (its git-tracked and unignored files;
       a submodule or nested repo by its own git view, never whole),
       inside this platform's OS sandbox: no network of any kind (IP, localhost,
       unix-socket connects), no writes outside scratch, no program outside the
       sandbox acting for the run, no reads of the user's
       home folder or the original repo (only the copy, the interpreter and its
       virtualenv), an empty environment (HOME and TMPDIR in scratch), no
       bytecode or cache writes, a time limit;
     - no sandbox, no run: a platform without one, or a sandbox that cannot
       start here, is a refusal, never a fallback.
   Writes trace.json beside the code map: an overlay (observed pairs, the static
   edges that fired, per-test attribution, outcome, the tests the sandbox
   denied), and trace.log (the run's output); credential-shaped strings are
   redacted from the log, its tail and the failure messages. The code map is
   never edited and no static edge is ever removed. Failing tests are data:
   never retried.

   Exit: 0 ok · 1 refused: no opt-in flag; or bad flags or inputs
         · 2 the run produced no trace records · 3 refused: not a recognised test
         command · 4 refused: no sandbox on this platform · 5 timed out (the
         partial trace is kept and marked)
   ========================================================================== */
import { readFileSync, writeFileSync, existsSync, realpathSync, mkdtempSync, mkdirSync, rmSync, readdirSync, lstatSync,
  copyFileSync, symlinkSync, readlinkSync } from 'node:fs';
import { join, resolve, dirname, sep, relative, basename, isAbsolute } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pickSandbox, sandboxArgv, exposable, SANDBOX_LABEL } from './lib/sandbox.mjs';
import { redactSecrets } from './lib/redact.mjs';
import { observe } from './lib/observe.mjs';

const fail = (code, msg) => { console.error(`[trace] ${msg}`); process.exit(code); };
const PAYLOAD = join(dirname(fileURLToPath(import.meta.url)), 'trace', 'python');

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
const NOT_TEST = `refused: "${COMMAND}" is not a recognised test command. Accepted: pytest [args], py.test [args], python -m pytest [args], python -m unittest [args] (python, python3 or python3.N, by name or path), with no shell syntax and no wrapper; nothing but the repo's own test suite is ever traced`;
if (!words?.length) fail(3, NOT_TEST);
let runner, testArgs;
const head = basename(words[0]);
if (/^(pytest|py\.test)$/.test(head)) { runner = 'pytest'; testArgs = words.slice(1); }
else if (/^python(\d+(\.\d+)?)?$/.test(head) && words[1] === '-m' && ['pytest', 'unittest'].includes(words[2])) { runner = words[2]; testArgs = words.slice(3); }
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
const exe = findExecutable(words[0]);
if (!exe) fail(1, `cannot find ${words[0]} (looked in the repo's .venv/bin and venv/bin, then on PATH)`);
const runArgs = runner === 'pytest' && !testArgs.some((a, i) => a === 'no:cacheprovider' && testArgs[i - 1] === '-p') ? [...testArgs, '-p', 'no:cacheprovider'] : testArgs;
const testArgv = /^(pytest|py\.test)$/.test(head) ? [exe, ...runArgs] : [exe, '-m', runner, ...runArgs];

// what the sandbox must still let the run read: the interpreter's prefix, its virtualenv and the prefix that
// virtualenv was made from. Never the original repo: the run sees only the copy
function readOnlyPaths() {
  const paths = [];
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
  return files.length;
}

/* ---------------- run ---------------- */
for (const f of ['trace.json', 'trace.log']) rmSync(join(OUT, f), { force: true });
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'fmtrace-')));
const COPY = join(SCRATCH, 'repo'), TRACE_OUT = join(SCRATCH, 'out');
for (const d of [COPY, TRACE_OUT, join(SCRATCH, 'trace'), join(SCRATCH, 'home'), join(SCRATCH, 'tmp')]) mkdirSync(d, { recursive: true });
let code = 0;
try {
  const copied = copyRepo(COPY);
  for (const f of readdirSync(PAYLOAD).filter(f => f.endsWith('.py'))) copyFileSync(join(PAYLOAD, f), join(SCRATCH, 'trace', f));
  const sha = p => { try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return null; } };
  const changedFiles = (m.files || []).filter(f => f.sha256 && sha(join(COPY, f.path)) !== f.sha256).map(f => f.path);

  const env = {
    HOME: join(SCRATCH, 'home'), TMPDIR: join(SCRATCH, 'tmp'), PATH: `${dirname(exe)}:/usr/bin:/bin`,
    PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(SCRATCH, 'trace'),
    FM_TRACE_ROOT: COPY, FM_TRACE_OUT: TRACE_OUT, FM_TRACE_RUNNER: runner,
    // where the original repo was, which the sandbox hides: imports that point there (an editable install) are sent to
    // the copy, and a test that fails on reading a hidden path is listed as denied
    FM_TRACE_ORIGIN: [...new Set([ROOT, resolve(m.root)])].join(':'), FM_TRACE_HIDDEN: HIDDEN.join(':'),
    ...(runner === 'pytest' ? { PYTEST_PLUGINS: 'fmtrace_plugin' } : {}),
  };
  const readOnly = readOnlyPaths(), shown = readOnly.filter(p => exposable(p, { scratch: SCRATCH, hidden: HIDDEN }));
  for (const p of readOnly.filter(p => !shown.includes(p)))
    console.log(`[trace] not exposing ${p} to the run: it holds your home folder, the repo or scratch`);
  const [cmd, ...args] = sandboxArgv(box.kind, { scratch: SCRATCH, hidden: HIDDEN, readOnly: shown, argv: testArgv });
  console.log(`[trace] ${SANDBOX_LABEL[box.kind]} · ${copied} files copied to scratch · running: ${testArgv.join(' ')} (limit ${timeoutSec}s)`);
  const t0 = Date.now();
  const log = [];
  const run = await new Promise(done => {
    const child = spawn(cmd, args, { cwd: COPY, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false, killer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      killer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 10000);
    }, timeoutSec * 1000);
    child.stdout.on('data', b => log.push(b));
    child.stderr.on('data', b => log.push(b));
    child.on('error', e => { clearTimeout(timer); done({ status: null, error: e.message, timedOut }); });
    child.on('close', (status, signal) => { clearTimeout(timer); if (killer) clearTimeout(killer); done({ status, signal, timedOut }); });
  });
  const durationMs = Date.now() - t0;
  const logText = redactSecrets(Buffer.concat(log).toString('utf8'));
  writeFileSync(join(OUT, 'trace.log'), logText);
  const tail = logText.trimEnd().split('\n').slice(-12).join('\n');

  const dumps = readdirSync(TRACE_OUT).filter(f => /^trace-.*\.json$/.test(f)).sort().flatMap(f => {
    try { return [JSON.parse(readFileSync(join(TRACE_OUT, f), 'utf8'))]; } catch { return []; } });
  if (!dumps.length || !dumps.some(d => d.collected || Object.keys(d.outcomes || {}).length)) {
    console.error(tail);
    console.error(`[trace] the run produced no trace records or ran no test (${run.error || (run.timedOut ? 'timed out' : `exit ${run.status ?? run.signal}`)}); its output is in ${join(OUT, 'trace.log')}`);
    code = 2;
  } else code = report(observe(m, dumps), { run, durationMs, tail, changedFiles });
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}
process.exit(code);

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
