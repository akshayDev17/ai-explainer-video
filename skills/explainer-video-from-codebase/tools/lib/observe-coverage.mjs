/* Map a coverage-based test run (Go's -coverprofile, gcov) onto a code map (design §3.14, §3.17). Coverage says which
   lines ran, not who called them, so no edge is marked observed: a symbol ran when a counted line or block inside it
   ran (the innermost symbol holding it), and a direct test link counts as observed when its target ran in the unit
   its test ran in — the test itself (Go, one run per test) or its test binary (make, `binary`). Nothing is removed or
   demoted: the result is an overlay beside the code map, which is not edited. */
const byStr = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/* counts: Map(repo-relative file -> [{ start, end, count }]) -> Set(symbol id) */
export function symbolsRan(m, counts) {
  const inFile = new Map();
  for (const s of m.symbols) if (s.kind !== 'class') (inFile.get(s.file) || inFile.set(s.file, []).get(s.file)).push(s);
  const ran = new Set();
  for (const [file, blocks] of counts) {
    const syms = inFile.get(file); if (!syms) continue;
    for (const b of blocks) {
      if (!b.count) continue;
      let best = null;
      for (const s of syms) if (s.start <= b.start && b.start <= s.end && (!best || s.start > best.start || (s.start === best.start && s.end < best.end))) best = s;
      if (best) ran.add(best.id);
    }
  }
  return ran;
}
// gcov line counts per source -> the blocks symbolsRan reads
export const linesToBlocks = lines => [...lines].map(([line, count]) => ({ start: line, end: line, count }));

/* units: [{ key, tests: [test ids], ran: Set }], results: Map(test id -> { status, message, nodeid }), granularity:
   'test' | 'binary', ownFile: which code-map files this runner measures */
export function observeCoverage(m, { units, results, failures, denied, granularity, ownFile, notCollected = [], runtime = {} }) {
  const sym = new Map(m.symbols.map(s => [s.id, s]));
  const grp = id => sym.get(id)?.group || '?';
  const unitOf = new Map(); for (const u of units) for (const t of u.tests) unitOf.set(t, u);
  const outcome = { collected: 0, passed: 0, failed: 0, errors: 0, skipped: 0, xfailed: 0, xpassed: 0, unknown: 0, notRun: 0 };
  for (const r of results.values()) { outcome.collected++; if (r.status === 'not run') outcome.notRun++; else if (outcome[r.status] != null) outcome[r.status]++; }
  outcome.errors += failures.filter(f => f.status === 'error').length;
  const byTest = {};
  let dObs = 0, dAll = 0, pObs = 0, pAll = 0, linked = 0;
  for (const t of (m.tests || []).filter(x => ownFile(x.file))) {
    const r = results.get(t.id), u = unitOf.get(t.id);
    if (!r) continue;
    const direct = [...new Set(t.direct.map(d => d.to).filter(to => sym.has(to) && grp(to) !== 'test' && sym.get(to).kind !== 'class'))];
    const ran = r.status === 'not run' ? null : u?.ran;
    const missing = ran ? direct.filter(to => !ran.has(to)).sort(byStr) : direct;
    if (ran && direct.length) { linked++; dAll += direct.length; dObs += direct.length - missing.length;
      const prod = direct.filter(to => grp(to) === 'prod'); pAll += prod.length; pObs += prod.filter(to => ran.has(to)).length; }
    byTest[t.id] = { file: t.file, nodeids: r.nodeid ? [r.nodeid] : [], status: r.status, unit: u?.key ?? null, direct: { total: direct.length, observed: direct.length - missing.length, missing } };
  }
  let fixO = 0, fixN = 0;
  for (const b of m.fixtureBindings || []) { const r = results.get(b.fn), u = unitOf.get(b.fn); if (!r || r.status === 'not run' || !u) continue; fixN++; if (u.ran.has(b.fixture)) fixO++; }
  const ranAnywhere = new Set(units.flatMap(u => [...u.ran]));
  const fns = m.symbols.filter(s => (s.kind === 'function' || s.kind === 'method') && ownFile(s.file));
  const functionsRan = {};
  for (const g of ['prod', 'eval', 'test', 'dev']) { const f = fns.filter(s => s.group === g); functionsRan[g] = { ran: f.filter(s => ranAnywhere.has(s.id)).length, total: f.length }; }
  const ran = {};
  for (const u of [...units].sort((a, b) => byStr(a.key, b.key))) for (const id of u.ran) (ran[id] ||= []).push(u.key);
  return {
    runtime, granularity, outcome, notCollected, failures, deniedBySandbox: denied,
    summary: {
      functionsRan,
      pairs: 'not recorded: coverage says which code ran under a test, not which function called which',
      directLinksPerTest: { tests: linked, observed: dObs, total: dAll, prod: { observed: pObs, total: pAll }, granularity },
      fixtureLinks: { observed: fixO, total: fixN },
    },
    ran: Object.fromEntries(Object.entries(ran).sort(([a], [b]) => byStr(a, b))),
    byUnit: Object.fromEntries([...units].sort((a, b) => byStr(a.key, b.key)).map(u => [u.key, { tests: [...u.tests].sort(byStr), ran: [...u.ran].sort(byStr) }])),
    byTest, pairs: [], edges: [], noStaticEdge: [], callbacks: [],
  };
}
