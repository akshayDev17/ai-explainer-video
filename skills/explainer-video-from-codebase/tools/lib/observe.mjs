/* Map the Python collector's records onto a code map (design §3.17, Appendix A.7): which static edges fired, which
   code ran under which test, and which calls ran with no static edge at all. It never removes or demotes an edge: the
   result is an overlay beside the code map, which is not edited.

   A record is (caller, callee, test, calls), each code unit as [file relative to the repo root, co_qualname]. Its id
   is the code map's: `pkg.module:Class.method`, `…:outer.<locals>.inner`, `pkg.module:<module>` for module code. */

const KINDS = ['static', 'ctor', 'virtual', 'dispatch', 'framework', 'queue', 'http'];
const STATUS_RANK = { error: 4, failed: 3, xpassed: 2, passed: 1, xfailed: 0, skipped: 0 };

const modOf = rel => rel.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').join('.');
const idOf = ([rel, q]) => `${modOf(rel)}:${q}`;
const byStr = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const pairKey = (a, b) => a + '|' + b;

// a test's outcome from its phases: pytest's counting (a failed setup is an error, a failed teardown adds one); a
// test with no call report was cut off mid-call (the time limit) and is an error
function statusOf(rec) {
  if (rec.call === 'error' || rec.setup === 'failed') return 'error';
  if (rec.setup === 'skipped' || rec.call === 'skipped') return rec.xfail ? 'xfailed' : 'skipped';
  if (rec.call === 'failed') return 'failed';
  if (rec.call === 'xfailed' || rec.call === 'xpassed') return rec.call;
  if (rec.call === 'passed') return rec.xfail ? 'xpassed' : 'passed';
  return 'error';
}

function category(sym, grp, a, b) {
  const n = b.split(/[.:]/).pop(), s = sym.get(b);
  if (/^__\w+__$/.test(n) && n !== '__init__') return 'dunder';
  if ((s.decos || []).some(d => /property|setter|cached_property/.test(d))) return 'property';
  if ((s.decos || []).some(d => /validator|model_validator|field_validator|computed_field/.test(d))) return 'validator';
  if (grp(a) === 'test' || grp(b) === 'test') return 'test-side';
  if (n === '__init__') return 'init';
  return 'other';
}

export function observe(m, dumps) {
  const sym = new Map(m.symbols.map(s => [s.id, s]));
  const grp = id => sym.get(id)?.group || '?';
  const callable = id => sym.has(id) && sym.get(id).kind !== 'class' && sym.get(id).kind !== 'main';
  const tests = m.tests || [];
  const dotted = new Map(tests.map(t => [t.id.replace(':', '.'), t.id]));
  const known = new Set(tests.map(t => t.id));
  // a collector key (`tests/x.py::Class::test[param]`, `unittest::pkg.mod.Class.test`) -> the code map's test id
  const testIdOf = key => {
    if (key.startsWith('unittest::')) return dotted.get(key.slice('unittest::'.length)) || null;
    const [path, ...rest] = key.split('::');
    const id = `${modOf(path)}:${rest.join('.').replace(/\[.*\]$/, '')}`;
    return known.has(id) ? id : null;
  };
  const nameOf = key => testIdOf(key) || key;

  /* ---- merge every process's records ---- */
  const pairs = new Map(), ranBy = new Map(), outcomes = new Map(), network = new Map(), collectErrors = new Map(), fixtureErrors = new Map();
  let collected = null, records = 0, unmappedRecords = 0, bodies = 0;
  const unmappedSample = new Set(), python = new Set();
  for (const d of dumps) {
    if (d.python) python.add(d.python);
    if (d.collected != null) collected = Math.max(collected ?? 0, d.collected);
    for (const e of d.collectErrors || []) collectErrors.set(e.nodeid, e);
    for (const e of d.fixtureErrors || []) fixtureErrors.set(e.nodeid, e);
    for (const [k, rec] of Object.entries(d.outcomes || {})) outcomes.set(k, { ...outcomes.get(k), ...rec });
    for (const [k, v] of Object.entries(d.network || {})) network.set(k, [...new Set([...(network.get(k) || []), ...v])]);
    for (const p of d.pairs || []) {
      records++;
      const to = idOf(p.to);
      if (!callable(to)) {
        if (p.to[1] === '<module>' || sym.get(to)?.kind === 'class') bodies++;
        else { unmappedRecords++; if (unmappedSample.size < 8) unmappedSample.add(to); }
        continue;
      }
      if (p.test != null) { const t = nameOf(p.test); (ranBy.get(t) || ranBy.set(t, { keys: new Set(), ran: new Set() }).get(t)).ran.add(to); ranBy.get(t).keys.add(p.test); }
      if (!p.from) continue;
      const from = idOf(p.from), k = pairKey(from, to);
      const x = pairs.get(k) || pairs.set(k, { from, to, n: 0, tests: new Set() }).get(k);
      x.n += p.n;
      if (p.test != null) x.tests.add(nameOf(p.test));
    }
  }

  /* ---- outcome, failures, tests the sandbox denied ---- */
  const outcome = { collected: collected ?? outcomes.size, passed: 0, failed: 0, errors: collectErrors.size + fixtureErrors.size, skipped: 0, xfailed: 0, xpassed: 0 };
  const statusBy = new Map(), failures = [], denied = [];
  for (const [key, rec] of [...outcomes].sort(([a], [b]) => byStr(a, b))) {
    const status = statusOf(rec), name = nameOf(key);
    outcome[{ passed: 'passed', failed: 'failed', error: 'errors', skipped: 'skipped', xfailed: 'xfailed', xpassed: 'xpassed' }[status]]++;
    if (rec.teardown === 'failed') outcome.errors++;
    const prev = statusBy.get(name);
    if (!prev || STATUS_RANK[status] > STATUS_RANK[prev]) statusBy.set(name, status);
    if (status !== 'failed' && status !== 'error' && rec.teardown !== 'failed') continue;
    const phase = rec.setup === 'failed' ? 'setup' : (status === 'failed' || status === 'error') ? 'call' : 'teardown';
    failures.push({ test: testIdOf(key), nodeid: rec.nodeid || key, status, phase, message: rec.message || '' });
    const net = network.get(key) || [];
    if (net.length || rec.permission) denied.push({ test: testIdOf(key), nodeid: rec.nodeid || key, status, network: net, permission: !!rec.permission, message: rec.message || '' });
  }
  for (const e of [...collectErrors.values()].sort((a, b) => byStr(a.nodeid, b.nodeid)))
    failures.push({ test: null, nodeid: e.nodeid, status: 'error', phase: 'collect', message: e.message || '' });
  for (const e of [...fixtureErrors.values()].sort((a, b) => byStr(a.nodeid, b.nodeid))) {
    failures.push({ test: null, nodeid: e.nodeid, status: 'error', phase: e.phase, message: e.message || '' });
    const net = network.get(e.nodeid) || [];
    if (net.length || e.permission) denied.push({ test: null, nodeid: e.nodeid, status: 'error', network: net, permission: !!e.permission, message: e.message || '' });
  }

  /* ---- static edges that fired ---- */
  const uniq = [...new Map(m.edges.map(e => [e.from + '|' + e.to + '|' + e.kind, e])).values()];
  const countable = uniq.filter(e => KINDS.includes(e.kind) && sym.has(e.from) && callable(e.to));
  const fired = e => pairs.get(pairKey(e.from, e.to));
  const tally = edges => { const byKind = {}; let observed = 0;
    for (const e of edges) { const k = e.kind + (e.rule ? '/' + e.rule : ''); const b = byKind[k] || (byKind[k] = [0, 0]); b[1]++; if (fired(e)) { b[0]++; observed++; } }
    return { observed, total: edges.length, byKind: Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => byStr(a, b))) }; };
  const edges = countable.filter(fired).map(e => { const p = fired(e);
    return { from: e.from, to: e.to, kind: e.kind, ...(e.rule ? { rule: e.rule } : {}), ...(e.passedBy ? { passedBy: e.passedBy } : {}), n: p.n, tests: [...p.tests].sort(byStr) }; })
    .sort((a, b) => byStr(a.from, b.from) || byStr(a.to, b.to) || byStr(a.kind, b.kind));

  /* ---- per test: direct links that ran under their own test ---- */
  const byTest = {};
  let dObs = 0, dAll = 0, pObs = 0, pAll = 0, linkedTests = 0;
  const testById = new Map(tests.map(t => [t.id, t]));
  for (const name of [...new Set([...ranBy.keys(), ...statusBy.keys()])].sort(byStr)) {
    const r = ranBy.get(name), ran = r?.ran || new Set(), t = testById.get(name);
    const direct = t ? [...new Set(t.direct.map(d => d.to).filter(to => callable(to) && grp(to) !== 'test'))] : [];
    const missing = r ? direct.filter(to => !ran.has(to)).sort(byStr) : [];
    if (r && direct.length) { linkedTests++; dAll += direct.length; dObs += direct.length - missing.length;
      const prod = direct.filter(to => grp(to) === 'prod'); pAll += prod.length; pObs += prod.filter(to => ran.has(to)).length; }
    byTest[name] = { nodeids: [...(r?.keys || [])].sort(byStr), status: statusBy.get(name) || null, ran: [...ran].sort(byStr),
      direct: { total: direct.length, observed: direct.length - missing.length, missing } };
  }
  let fixO = 0, fixN = 0;
  for (const b of m.fixtureBindings || []) { const r = ranBy.get(b.fn); if (!r) continue; fixN++; if (r.ran.has(b.fixture)) fixO++; }

  /* ---- calls that ran with no static edge of any kind ---- */
  const anyEdge = new Set(m.edges.map(e => pairKey(e.from, e.to)));
  const noStaticEdge = [...pairs.values()].filter(p => sym.has(p.from) && p.from !== p.to && !anyEdge.has(pairKey(p.from, p.to)))
    .map(p => ({ from: p.from, to: p.to, n: p.n, tests: p.tests.size, category: category(sym, grp, p.from, p.to) }))
    .sort((a, b) => byStr(a.from, b.from) || byStr(a.to, b.to));
  const byCategory = {};
  for (const x of noStaticEdge) byCategory[x.category] = (byCategory[x.category] || 0) + 1;
  // the callback links (a callable handed to the code that runs it) the run confirmed
  const callbacks = edges.filter(e => e.rule === 'py.callback').map(e => ({ from: e.from, to: e.to, passedBy: e.passedBy || null, tests: e.tests.length }));
  const prodNoEdge = noStaticEdge.filter(x => x.category === 'other' && grp(x.from) === 'prod' && grp(x.to) === 'prod').length;

  const fns = m.symbols.filter(s => s.kind === 'function' || s.kind === 'method');
  const ranAnywhere = new Set([...ranBy.values()].flatMap(r => [...r.ran]).concat([...pairs.values()].map(p => p.to)));
  const functionsRan = {};
  for (const g of ['prod', 'eval', 'test', 'dev']) { const f = fns.filter(s => s.group === g); functionsRan[g] = { ran: f.filter(s => ranAnywhere.has(s.id)).length, total: f.length }; }

  const summary = {
    records, distinctPairs: pairs.size, functionsRan,
    edges: { all: tally(countable), prodToProd: tally(countable.filter(e => grp(e.from) === 'prod' && grp(e.to) === 'prod')),
      testToNonTest: tally(countable.filter(e => grp(e.from) === 'test' && grp(e.to) !== 'test')) },
    directLinksPerTest: { tests: linkedTests, observed: dObs, total: dAll, prod: { observed: pObs, total: pAll } },
    fixtureLinks: { observed: fixO, total: fixN },
    noStaticEdge: { pairs: noStaticEdge.length, prodToProd: prodNoEdge, byCategory: Object.fromEntries(Object.entries(byCategory).sort(([a], [b]) => byStr(a, b))) },
    callbacks: callbacks.length,
    unmapped: { records: unmappedRecords, sample: [...unmappedSample].sort(byStr) }, moduleAndClassBodies: bodies,
  };
  return {
    python: [...python].sort(byStr), outcome, failures, deniedBySandbox: denied, summary,
    pairs: [...pairs.values()].map(p => ({ from: p.from, to: p.to, n: p.n, tests: p.tests.size })).sort((a, b) => byStr(a.from, b.from) || byStr(a.to, b.to)),
    edges, noStaticEdge, callbacks, byTest,
  };
}
