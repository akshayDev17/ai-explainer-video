/* trace.mjs's C / C++ runner (design §3.14 C and C++ rows, §3.17): the repo's own `make` test target, built with
   coverage and read with gcov, per test binary.
   - accepted: `make test`, `make check` and `make -C <dir> test|check` (the make on PATH); no variables, no other
     target, no other flag: the trace sets CC, CXX and SHELL itself;
   - the run builds and runs the target once with `CC="cc --coverage"`, `CXX="c++ --coverage"` (a command-line
     variable wins over the Makefile's own, and the flag reaches both compiling and linking) and SHELL set to
     trace/c/fmtrace-sh, which runs each recipe line under the shell the Makefile's own top-level `SHELL =` names
     (else /bin/sh), with the line's .SHELLFLAGS, and GCOV_PREFIX pointing at a dir of its own: the counters each
     line's test binary writes land apart, and its exit status and output are kept beside them;
   - each recipe line that wrote counters is one unit (`granularity: binary`); after the run, inside the same sandbox,
     each counter file and the notes file the compiler wrote beside its object are copied into a fresh dir and read
     there with `gcov -t` for the line counts of each source it covers. A test whose own lines ran in a unit belongs to
     that unit (the first, if several), and its direct links are judged against that unit's coverage; its status
     comes from GoogleTest's `[ RUN ]` / `[ OK ]` / `[ FAILED ]` lines or Unity's `file:line:test:PASS` lines, else from
     its recipe line's exit status, as far as the line's shape (lineShape) lets that status speak for one binary: one
     simple command running one program's `main` is passed on 0 and failed otherwise; an `&&` chain is passed on 0
     and `unknown` otherwise; any other line (`./a; ./b`, `||`, a pipe, a loop, a subshell) is `unknown` either way. */
import { posix } from 'node:path';

/* -> { runner: 'make', dir, target } or null */
export function recogniseMake(words) {
  if (posix.basename(words[0]) !== 'make') return null;
  let i = 1, dir = '';
  if (words[i] === '-C' && words[i + 1] != null) { dir = words[i + 1]; i += 2; }
  if (dir.startsWith('/') || dir.split('/').includes('..')) return null;
  if (words.length !== i + 1 || !/^(test|check)$/.test(words[i])) return null;
  return { runner: 'make', dir: dir.replace(/^\.\/?/, '').replace(/\/$/, ''), target: words[i] };
}

/* the shell a Makefile's own top-level `SHELL = …` names (its last such assignment), or null: one that needs make to
   expand it (`$(shell which bash)`) is left to the default */
export function makefileShell(text) {
  let sh = null;
  for (const m of text.matchAll(/^(?:(?:export|override)\s+)*SHELL\s*:{0,3}=[ \t]*(.*?)\s*(?:#.*)?$/gm)) sh = m[1];
  return sh && !sh.includes('$') ? sh : null;
}

const KEYWORDS = new Set(['!', 'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function', 'time']);
/* what a recipe line's exit status can say about the programs it runs: 'single' (one simple command), 'and' (simple
   commands joined by `&&`, so 0 means each one passed) or 'other' (`;`, `||`, `|`, `&`, a newline, a subshell or group,
   a command substitution, a compound command); quotes and redirections are read as a shell would */
export function lineShape(cmd) {
  const segs = ['']; let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") { if (c === "'") q = null; segs[segs.length - 1] += 'x'; continue; }
    if (c === '`' || (c === '$' && cmd[i + 1] === '(')) return 'other';
    if (c === '\\') { i++; segs[segs.length - 1] += 'x'; continue; }
    if (q === '"') { if (c === '"') q = null; segs[segs.length - 1] += 'x'; continue; }
    if (c === "'" || c === '"') { q = c; segs[segs.length - 1] += 'x'; continue; }
    if (c === '&' && cmd[i + 1] === '&') { segs.push(''); i++; continue; }
    if (c === '>' || c === '<') { if (cmd[i + 1] === '&' || cmd[i + 1] === c) i++; segs[segs.length - 1] += ' '; continue; }
    if (';|&(){}\n'.includes(c)) return 'other';
    segs[segs.length - 1] += c;
  }
  if (q) return 'other';
  const heads = segs.map(x => x.trim().split(/\s+/).find(w => !/^\w+=/.test(w)));
  if (heads.some(h => !h || KEYWORDS.has(h))) return 'other';
  return segs.length > 1 ? 'and' : 'single';
}

export const makeArgv = ({ make, dir, target, shell }) => [make, ...(dir ? ['-C', dir] : []), target, 'CC=cc --coverage', 'CXX=c++ --coverage', `SHELL=${shell}`];

/* gcov -t text (one or more files) -> Map(source as compiled -> Map(line -> count)) */
export function parseGcov(text) {
  const out = new Map(); let cur = null;
  for (const line of text.split('\n')) {
    const m = /^\s*([^:]+):\s*(\d+):(.*)$/.exec(line);
    if (!m) continue;
    if (m[2] === '0') { const src = /^Source:(.*)$/.exec(m[3]); if (src) { cur = out.get(src[1]) || out.set(src[1], new Map()).get(src[1]); } continue; }
    const c = m[1].trim();
    if (!cur || c === '-') continue;
    const n = /^[#=]+$/.test(c) ? 0 : parseInt(c.replace(/\*$/, ''), 10);
    if (Number.isFinite(n)) cur.set(+m[2], Math.max(n, cur.get(+m[2]) || 0));
  }
  return out;
}

/* test outcomes a make run printed: GoogleTest and Unity lines -> Map(name -> status) */
export function parseCTestOutput(text) {
  const out = new Map();
  for (const m of text.matchAll(/^\[\s+(OK|FAILED|SKIPPED)\s+\]\s+([\w/]+\.[\w/]+)(?: \(\d+ ms\))?\s*$/gm))
    out.set(m[2], m[1] === 'OK' ? 'passed' : m[1] === 'FAILED' ? 'failed' : 'skipped');
  for (const m of text.matchAll(/^[^\s:]+:\d+:(\w+):(PASS|FAIL|IGNORE)\b/gm)) out.set(m[1], m[2] === 'PASS' ? 'passed' : m[2] === 'FAIL' ? 'failed' : 'skipped');
  return out;
}

export const C_NETWORK = /\b(connect|getaddrinfo|socket)\b[^\n]*\b(Operation not permitted|Permission denied|Connection refused|No route to host|failure)\b|\bconnect\(\)[^\n]*/g;
