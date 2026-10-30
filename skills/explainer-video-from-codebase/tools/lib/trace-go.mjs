/* trace.mjs's Go runner (design §3.14 Go row, §3.17): `go test`, recognised with the flags that only choose and run
   tests, run once per test under `-coverprofile` so what ran is attributed to that test.
   - accepted: `go test [flags] [packages]` and `go -C <dir> test …` (the go on PATH, or a path to one); packages are
     `.`, `./dir` or `./dir/...` inside the module; flags: -run, -skip, -short, -v, -count, -tags, -timeout, -failfast,
     -p, -parallel, -cpu (a value given as -flag=v or -flag v);
   - refused: any flag the trace sets itself or that runs another program or writes elsewhere (-json, -cover*,
     -coverprofile, -exec, -toolexec, -o, -c, -cpuprofile, -memprofile, -trace, -fuzz, -race, -vet, -modfile, -overlay);
   - the module is the one `-C` names, else the repo root's go.mod, else the code map's one Go module;
   - each code-map TestXxx / FuzzXxx in a selected package runs alone (`-run ^TestXxx$`, intersected with a -run the
     command gave) with `-json -count=1 -coverprofile -coverpkg=./...`: the profile marks the module's non-test code
     that ran under that test. go test does not instrument _test.go files, so test-side code (helpers, fakes,
     TestMain) is never observed. */
import { posix } from 'node:path';

const VALUE = new Set(['-run', '-skip', '-count', '-tags', '-timeout', '-p', '-parallel', '-cpu']);
const BOOL = new Set(['-short', '-v', '-failfast']);

/* -> { runner: 'go-test', dir, flags, packages, run } or null */
export function recogniseGo(words) {
  if (!/^go$/.test(posix.basename(words[0]))) return null;
  let i = 1, dir = '';
  if (words[i] === '-C' && words[i + 1] != null) { dir = words[i + 1]; i += 2; }
  else if (/^-C=/.test(words[i] || '')) { dir = words[i].slice(3); i++; }
  if (words[i] !== 'test') return null;
  if (dir.startsWith('/') || dir.split('/').includes('..')) return null;
  const flags = [], packages = []; let run = null;
  for (let j = i + 1; j < words.length; j++) {
    const w = words[j];
    if (!w.startsWith('-')) { if (w.startsWith('/') || w.split('/').includes('..') || !/^\.(\/|$)/.test(w)) return null; packages.push(w); continue; }
    const [f, v] = w.includes('=') ? [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)] : [w, null];
    const flag = f.replace(/^--/, '-');
    if (BOOL.has(flag)) { if (v != null && !/^(true|false)$/.test(v)) return null; flags.push(w); continue; }
    if (!VALUE.has(flag)) return null;
    const val = v ?? words[++j];
    if (val == null) return null;
    if (flag === '-run') run = val; else flags.push(`${flag}=${val}`);
  }
  return { runner: 'go-test', dir: dir.replace(/^\.\/?/, '').replace(/\/$/, ''), flags, packages: packages.length ? packages : ['.'], run };
}

// does a package pattern (relative to the module dir) select a package dir (relative to the module dir, '' = root)?
const selects = (pat, dir) => { const p = pat.replace(/^\.\/?/, '').replace(/\/$/, '');
  if (p === '...') return true;
  if (p.endsWith('/...')) { const base = p.slice(0, -4); return dir === base || dir.startsWith(base + '/'); }
  return dir === p; };

/* the module dir the run uses (repo-relative, '' = root), or { why } */
export function goModuleDir(m, cmd, hasRootGoMod) {
  const mods = m.selfCheck?.go?.modules || [];
  if (cmd.dir) return mods.some(x => (x.dir === '.' ? '' : x.dir) === cmd.dir) ? { dir: cmd.dir } : { why: `-C ${cmd.dir}: no go.mod there in the code map` };
  if (hasRootGoMod) return { dir: '' };
  if (mods.length === 1) return { dir: mods[0].dir === '.' ? '' : mods[0].dir };
  return { why: mods.length ? `the repo holds ${mods.length} Go modules (${mods.map(x => x.dir).join(', ')}): name one with go -C <dir> test` : 'no go.mod in the code map' };
}

/* the code map's tests the command runs: [{ id, name, pkgDir (module-relative) }] */
export function goTestsToRun(m, cmd, modDir) {
  let re = null; if (cmd.run) { try { re = new RegExp(cmd.run); } catch { re = null; } }
  return (m.tests || []).filter(t => t.file.endsWith('_test.go')).map(t => {
    const rel = modDir ? (t.file.startsWith(modDir + '/') ? t.file.slice(modDir.length + 1) : null) : t.file;
    return rel == null ? null : { id: t.id, name: t.id.split(':').pop(), file: t.file, pkgDir: posix.dirname(rel) === '.' ? '' : posix.dirname(rel) };
  }).filter(t => t && cmd.packages.some(p => selects(p, t.pkgDir)) && (!re || re.test(t.name)));
}

export const goTestArgv = ({ go, flags, name, profile, pkgDir }) =>
  [go, 'test', '-json', '-count=1', `-run=^${name}$`, `-coverprofile=${profile}`, '-coverpkg=./...', ...flags, pkgDir ? `./${pkgDir}` : '.'];

/* `go test -json` events -> { tests: [{ name, status, message }], buildErrors: [text] } (top-level tests only; a
   subtest's failure fails its parent) */
export function parseGoTestJson(text) {
  const status = new Map(), out = new Map(), pkgOut = [];
  let pkgFailed = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) { if (line.trim()) pkgOut.push(line + '\n'); continue; }
    let e; try { e = JSON.parse(line); } catch { continue; }
    const top = e.Test ? e.Test.split('/')[0] : null;
    if (e.Action === 'output') { if (top) out.set(top, (out.get(top) || '') + e.Output); else pkgOut.push(e.Output); continue; }
    if (e.Test && !e.Test.includes('/') && /^(pass|fail|skip)$/.test(e.Action)) status.set(e.Test, e.Action === 'pass' ? 'passed' : e.Action === 'fail' ? 'failed' : 'skipped');
    if (!e.Test && e.Action === 'fail') pkgFailed = true;
  }
  const tests = [...status].map(([name, s]) => ({ name, status: s, message: (out.get(name) || '').trim() }));
  return { tests, buildErrors: pkgFailed && !tests.length ? [pkgOut.join('').trim()] : [] };
}

/* a coverprofile -> Map(repo-relative file -> [{ start, end, count }]); `importDir` maps an import path to a repo dir */
export function parseCoverProfile(text, importDir) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = /^(.+\.go):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/.exec(line.trim());
    if (!m) continue;
    const slash = m[1].lastIndexOf('/'), dir = importDir(m[1].slice(0, slash));
    if (dir == null) continue;
    const file = (dir ? `${dir}/` : '') + m[1].slice(slash + 1);
    (out.get(file) || out.set(file, []).get(file)).push({ start: +m[2], end: +m[3], count: +m[4] });
  }
  return out;
}

export const GO_NETWORK = /\bdial (tcp|udp|unix)\S*[^\n]*|\bsocket: operation not permitted|\blookup \S+[^\n]*(no such host|operation not permitted|server misbehaving)/g;
