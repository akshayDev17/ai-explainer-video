/* trace.mjs's C / C++ runner (design §3.14 C and C++ rows, §3.17): the repo's own `make` test target, built with
   coverage and read with gcov.
   - accepted: `make test`, `make check` and `make -C <dir> test|check` (the make on PATH); no variables, no other
     target, no other flag: the trace sets CC and CXX itself;
   - the run builds and runs the target once with `CC="cc --coverage"` and `CXX="c++ --coverage"` (a command-line
     variable wins over the Makefile's own, and the flag reaches both compiling and linking); every .gcda the run
     wrote is then read with `gcov -t`, inside the same sandbox, for the line counts of each source it covers;
   - what ran is attributed to the whole run (`granularity: suite`): make runs every test binary in one go, and their
     counters for a shared source add up, so no single test can be credited. A test whose own lines ran counts as run;
     its status comes from GoogleTest's `[ RUN ]` / `[ OK ]` / `[ FAILED ]` lines or Unity's `file:line:test:PASS`
     lines, else from the run's exit code. */
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

export const makeArgv = ({ make, dir, target }) => [make, ...(dir ? ['-C', dir] : []), target, 'CC=cc --coverage', 'CXX=c++ --coverage'];

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
