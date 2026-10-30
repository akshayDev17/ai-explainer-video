/* Map a JavaScript / TypeScript test run onto a code map (design §3.14 TS/JS row, §3.17). Each test file ran in its
   own runner process under V8 precise coverage (NODE_V8_COVERAGE), so a function that ran there ran under that test
   file: attribution is per test file, never per test. Coverage records which functions ran, not who called them, so no
   edge is marked observed; a direct test link counts as observed when its target ran in its test's file. It never
   removes or demotes an edge: the result is an overlay beside the code map, which is not edited.

   A covered function is matched to a code-map symbol through the script's source map when there is one (Node's own,
   or the inline map of a script jest or vitest compiled through node:vm, which trace/js/fmtrace-srcmap.cjs records);
   else by its position when the script V8 ran is the file itself (plain JavaScript), or the file with something
   appended (TypeScript with its types stripped in place, plus a sourceURL comment) and every named function sits on a
   line of the file that names it; and otherwise by name when exactly one symbol of that file has it. A named function
   that matches nothing is counted, never guessed; an anonymous one (a callback inside a symbol) has nothing of its own
   to mark.
   A file whose run ended cleanly but reported no test is listed as not collected (the runner's own config leaves it
   out, or it defines none), never as an error. */
import { fileURLToPath } from 'node:url';

const byStr = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const STATUS_RANK = { error: 4, failed: 3, passed: 1, skipped: 0 };

/* ---------------- source maps (v3, `mappings` only) ---------------- */
const B64 = Object.fromEntries([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]));
export function decodeMappings(mappings) {
  const lines = []; let src = 0, sLine = 0, sCol = 0;
  for (const line of mappings.split(';')) {
    const segs = []; let gCol = 0;
    for (const seg of line.split(',')) {
      if (!seg) continue;
      const v = []; let shift = 0, val = 0;
      for (const ch of seg) { const d = B64[ch]; if (d == null) break; val += (d & 31) << shift; if (d & 32) shift += 5; else { v.push(val & 1 ? -(val >>> 1) : val >>> 1); val = 0; shift = 0; } }
      gCol += v[0];
      if (v.length >= 4) { src += v[1]; sLine += v[2]; sCol += v[3]; segs.push([gCol, src, sLine, sCol]); }
    }
    lines.push(segs);
  }
  return lines;
}
// the original line (1-based) a generated offset maps to, through a source-map-cache entry
function sourceMapLine(entry, offset) {
  if (!entry?.lineLengths || !entry.data?.mappings) return null;
  let line = 0, start = 0;
  while (line < entry.lineLengths.length && start + entry.lineLengths[line] < offset) { start += entry.lineLengths[line] + 1; line++; }
  const segs = (entry.decoded ||= decodeMappings(entry.data.mappings))[line] || [];
  const col = offset - start;
  let best = null; for (const s of segs) { if (s[0] <= col) best = s; else break; }
  best ||= segs[0];
  return best ? best[2] + 1 : null;
}

const lineStarts = text => { const out = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') out.push(i + 1); return out; };
const lineOf = (starts, off) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; };
const nameMatches = (s, fn) => { const n = fn.replace(/^(get|set|async) /, ''); return n && (s.name === n || s.name.split('.').pop() === n || (s.kind === 'class' && s.name === n)); };

// which code-map symbols ran in one process's coverage dump; `root` is the copy the run used
export function functionsRan(m, dump, root, readFile) {
  const ran = new Set(); let unmapped = 0, scripts = 0, anonymous = 0;
  const syms = new Map();
  for (const s of m.symbols) if (s.kind !== 'main' && /\.[cm]?[jt]sx?$/.test(s.file)) (syms.get(s.file) || syms.set(s.file, []).get(s.file)).push(s);
  const ctorOf = new Map(m.symbols.filter(s => s.name === 'constructor' && s.cls).map(s => [s.cls, s.id]));
  const smc = dump['source-map-cache'] || {};
  for (const script of dump.result || []) {
    let path; try { path = script.url.startsWith('file://') ? fileURLToPath(script.url) : script.url; } catch { continue; }
    if (!path.startsWith(root + '/')) continue;
    const rel = path.slice(root.length + 1), here = syms.get(rel);
    if (!here) continue;
    scripts++;
    const text = readFile(rel);
    const len = Math.max(0, ...script.functions.filter(f => f.ranges[0]?.startOffset === 0).map(f => f.ranges[0].endOffset));
    const starts = text != null ? lineStarts(text) : null;
    const fns = script.functions.filter(f => f.ranges[0] && !(f.ranges[0].startOffset === 0 && !f.functionName));
    const lineText = off => text.slice(starts[lineOf(starts, off) - 1], starts[lineOf(starts, off)] ?? text.length);
    const identical = text != null && (len === text.length || (len > text.length && fns.every(f => f.ranges[0].endOffset <= text.length)
      && fns.filter(f => f.functionName).every(f => lineText(f.ranges[0].startOffset).includes(f.functionName.replace(/^(get|set|async) /, '')) || /constructor/.test(lineText(f.ranges[0].startOffset)))));
    const sm = smc[script.url] || smc[path];
    for (const f of fns) {
      const r0 = f.ranges[0];
      if (!r0.count) continue;
      const line = sm ? sourceMapLine(sm, r0.startOffset) : identical ? lineOf(starts, r0.startOffset) : null;
      let cand = line != null ? here.filter(s => s.start === line) : [];
      if (cand.length > 1) cand = cand.filter(s => nameMatches(s, f.functionName));
      if (!cand.length && f.functionName && !identical) { const named = here.filter(s => nameMatches(s, f.functionName)); if (named.length === 1) cand = named; }
      // a class's constructor runs under the class's name; a class with none has nothing of its own to mark
      cand = cand.map(s => s.kind === 'class' ? ctorOf.get(s.id) : s.id).filter(Boolean);
      if (cand.length === 1) ran.add(cand[0]); else if (f.functionName) unmapped++; else anonymous++;
    }
  }
  return { ran, unmapped, scripts, anonymous };
}

/* ---------------- outcomes ---------------- */
const safeTitle = s => s.replace(/:/g, '-').replace(/\s+/g, ' ').trim();
// a test-id pattern from a code-map test title: `%s`, `%i`, `$x`, `${x}` stand for what `.each` and templates fill in
const titleRe = q => new RegExp('^' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%[sdifjop#]|\\\$\\\{[^}]*\\\}|\\\$\w+/g, '.+?') + '$');

// jest's --json and vitest's json reporter (the same shape): per test file, per assertion
export function parseJestJson(json, root) {
  const tests = [], suiteErrors = [];
  for (const tr of json?.testResults || []) {
    const file = tr.name?.startsWith(root + '/') ? tr.name.slice(root.length + 1) : tr.name;
    const ars = tr.assertionResults || [];
    for (const a of ars) tests.push({ file, titles: [...(a.ancestorTitles || []), a.title], status: a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped',
      message: (a.failureMessages || []).join('\n') });
    if ((tr.status === 'failed' && !ars.some(a => a.status === 'failed')) || (tr.message && !ars.length)) suiteErrors.push({ file, message: tr.message || tr.failureMessage || '' });
  }
  return { tests, suiteErrors };
}

// node --test's TAP: `# Subtest: T` opens a test at an indent, `ok N - T` / `not ok N - T` at that indent closes it, and
// the YAML block under it says whether it was a suite and carries the error. A suite fails on its own only by a hook
export function parseTap(text) {
  const tests = [], suiteErrors = [], stack = [];
  const lines = text.split('\n');
  const unescape = t => t.replace(/\\(.)/g, '$1');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], ind = l.match(/^ */)[0].length;
    const sub = /^ *# Subtest: (.*)$/.exec(l);
    if (sub) { stack.push({ ind, title: unescape(sub[1]) }); continue; }
    const pt = /^ *(not )?ok \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/.exec(l);
    if (!pt) continue;
    while (stack.length && stack.at(-1).ind > ind) stack.pop();
    if (stack.at(-1)?.ind === ind) stack.pop();
    const titles = [...stack.map(x => x.title), unescape(pt[2])];
    const yaml = [];
    if (lines[i + 1]?.trim() === '---') for (let j = i + 2; j < lines.length && lines[j].trim() !== '...'; j++) yaml.push(lines[j]);
    const y = yaml.join('\n'), type = /^\s*type: '(\w+)'/m.exec(y)?.[1], failureType = /^\s*failureType: '(\w+)'/m.exec(y)?.[1];
    const block = /^( *)error: \|-\n([\s\S]*?)(?=\n\1\w+:|(?![\s\S]))/m.exec(y);
    const line = /^\s*error: (?:'(.*)'|"(.*)")$/m.exec(y), code = /^\s*code: '?(EPERM|EACCES|EROFS|ECONN\w+|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)'?$/m.exec(y)?.[1];
    const message = [...(block ? block[2] : line?.[1] ?? line?.[2] ?? '').split('\n'), ...(code && !(block?.[2] || line?.[0] || '').includes(code) ? [`code: ${code}`] : [])]
      .map(x => x.trim()).filter(Boolean).join('\n');
    if (type === 'suite') { if (pt[1] && failureType !== 'subtestsFailed') suiteErrors.push({ titles, message }); continue; }
    tests.push({ titles, status: pt[3] ? 'skipped' : pt[1] ? 'failed' : 'passed', message });
  }
  return { tests, suiteErrors };
}

const NETWORK = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b|connect E\w+|getaddrinfo E\w+|fetch failed/;
const PERMISSION = /\b(EPERM|EACCES|EROFS)\b/;
// the attempts a run recorded, else the target its error names (a worker thread is not hooked by the preload)
const attempts = (run, message) => run.network.length ? run.network
  : [...new Set([...message.matchAll(/\bconnect E\w+ (\S+?)(?=[\s,)]|$)|\bgetaddrinfo E\w+ (\S+?)(?=[\s,)]|$)/g)].map(x => x[1] ? `connect ${x[1]}` : `getaddrinfo ${x[2]}`))];

/* runs: [{ file, outcomes: { tests, suiteErrors }, coverage: [dump], network: [attempt], timedOut, exitCode }] */
export function observeV8(m, runs, { root, readFile, node }) {
  const sym = new Map(m.symbols.map(s => [s.id, s]));
  const grp = id => sym.get(id)?.group || '?';
  const tests = (m.tests || []).filter(t => /\.[cm]?[jt]sx?$/.test(t.file));
  const testsIn = new Map(); for (const t of tests) (testsIn.get(t.file) || testsIn.set(t.file, []).get(t.file)).push(t);
  const ranIn = new Map(), statusBy = new Map(), nodeidsOf = new Map(), failures = [], denied = [], notCollected = [];
  const outcome = { collected: 0, passed: 0, failed: 0, errors: 0, skipped: 0, xfailed: 0, xpassed: 0 };
  let unmapped = 0, scripts = 0, anonymous = 0;
  for (const run of runs) {
    const ran = new Set();
    for (const d of run.coverage) { const r = functionsRan(m, d, root, readFile); r.ran.forEach(x => ran.add(x)); unmapped += r.unmapped; scripts += r.scripts; anonymous += r.anonymous; }
    ranIn.set(run.file, ran);
    const known = testsIn.get(run.file) || [];
    const idOf = titles => { const q = `${run.file}:${safeTitle(titles.map(safeTitle).join(' > '))}`;
      return known.find(t => t.id === q)?.id || known.find(t => titleRe(t.id).test(q))?.id || null; };
    const reported = run.outcomes.tests.filter(t => !t.file || t.file === run.file);
    for (const t of reported) {
      outcome.collected++;
      outcome[{ passed: 'passed', failed: 'failed', skipped: 'skipped' }[t.status]]++;
      const id = idOf(t.titles), nodeid = `${run.file}::${t.titles.join(' > ')}`, name = id || nodeid;
      (nodeidsOf.get(name) || nodeidsOf.set(name, new Set()).get(name)).add(nodeid);
      if (!statusBy.has(name) || STATUS_RANK[t.status] > STATUS_RANK[statusBy.get(name)]) statusBy.set(name, t.status);
      if (t.status !== 'failed') continue;
      failures.push({ test: id, nodeid, status: 'failed', phase: 'call', message: t.message });
      const network = NETWORK.test(t.message) ? attempts(run, t.message) : [];
      if (network.length || PERMISSION.test(t.message)) denied.push({ test: id, nodeid, status: 'failed', network, permission: !network.length && PERMISSION.test(t.message), message: t.message });
    }
    const errs = [...run.outcomes.suiteErrors];
    if (!reported.length && !errs.length && run.exitCode === 0 && !run.timedOut) notCollected.push(run.file);
    if (!reported.length && !errs.length && (run.exitCode !== 0 || run.timedOut)) errs.push({ message: run.timedOut ? 'cut off by the time limit' : `the runner exited ${run.exitCode} and reported no test` });
    for (const e of errs) {
      outcome.errors++;
      const nodeid = e.titles ? `${run.file}::${e.titles.join(' > ')}` : run.file;
      failures.push({ test: null, nodeid, status: 'error', phase: e.titles ? 'setup' : 'collect', message: e.message || '' });
      const network = NETWORK.test(e.message || '') ? attempts(run, e.message || '') : [];
      if (network.length || PERMISSION.test(e.message || '')) denied.push({ test: null, nodeid, status: 'error', network, permission: !network.length, message: e.message || '' });
    }
  }

  /* ---- per test (by its file's run): direct links and hooks that ran ---- */
  const byTest = {};
  let dObs = 0, dAll = 0, pObs = 0, pAll = 0, linked = 0;
  for (const t of tests) {
    const ran = ranIn.get(t.file);
    if (!ran && !statusBy.has(t.id)) continue;
    const direct = [...new Set(t.direct.map(d => d.to).filter(to => sym.has(to) && grp(to) !== 'test' && sym.get(to).kind !== 'class'))];
    const missing = ran ? direct.filter(to => !ran.has(to)).sort(byStr) : direct;
    if (ran && direct.length) { linked++; dAll += direct.length; dObs += direct.length - missing.length;
      const prod = direct.filter(to => grp(to) === 'prod'); pAll += prod.length; pObs += prod.filter(to => ran.has(to)).length; }
    byTest[t.id] = { file: t.file, nodeids: [...(nodeidsOf.get(t.id) || [])].sort(byStr), status: statusBy.get(t.id) || null,
      direct: { total: direct.length, observed: direct.length - missing.length, missing } };
  }
  for (const [name, status] of statusBy) if (!byTest[name]) byTest[name] = { file: name.split('::')[0], nodeids: [...nodeidsOf.get(name)].sort(byStr), status, direct: { total: 0, observed: 0, missing: [] } };
  let fixO = 0, fixN = 0;
  const testFile = new Map(tests.map(t => [t.id, t.file]));
  for (const b of m.fixtureBindings || []) { const ran = ranIn.get(testFile.get(b.fn)); if (!ran) continue; fixN++; if (ran.has(b.fixture)) fixO++; }

  const ranAnywhere = new Set([...ranIn.values()].flatMap(s => [...s]));
  const fns = m.symbols.filter(s => (s.kind === 'function' || s.kind === 'method') && /\.[cm]?[jt]sx?$/.test(s.file));
  const functionsRanBy = {};
  for (const g of ['prod', 'eval', 'test', 'dev']) { const f = fns.filter(s => s.group === g); functionsRanBy[g] = { ran: f.filter(s => ranAnywhere.has(s.id)).length, total: f.length }; }
  const ran = {};
  for (const [file, set] of [...ranIn].sort(([a], [b]) => byStr(a, b))) for (const id of set) (ran[id] ||= []).push(file);
  const byFile = Object.fromEntries([...ranIn].sort(([a], [b]) => byStr(a, b)).map(([file, set]) => [file, { ran: [...set].sort(byStr) }]));
  return {
    runtime: { node }, granularity: 'test-file', outcome, notCollected: notCollected.sort(byStr), failures, deniedBySandbox: denied,
    summary: {
      scripts, functionsRan: functionsRanBy, unmappedFunctions: unmapped, anonymousCallbacks: anonymous,
      pairs: 'not recorded: V8 coverage says which functions ran in a test file, not which called which (an inspector-based tracer would be needed)',
      directLinksPerTest: { tests: linked, observed: dObs, total: dAll, prod: { observed: pObs, total: pAll }, granularity: 'test-file' },
      fixtureLinks: { observed: fixO, total: fixN },
    },
    ran: Object.fromEntries(Object.entries(ran).sort(([a], [b]) => byStr(a, b))), byFile, byTest,
    pairs: [], edges: [], noStaticEdge: [], callbacks: [],
  };
}
