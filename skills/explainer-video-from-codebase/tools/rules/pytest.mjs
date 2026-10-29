/* Rule pack: pytest (and unittest-style test classes, and unittest.mock targets).
   - tests: `test*` at module level, or `test*` methods of a `Test*` / `TestCase` class, in a test-group file;
   - fixtures: `@pytest.fixture` / `@pytest_asyncio.fixture`; a test-side parameter named like a visible fixture (its
     class, its module, then conftest.py in its directory and each parent) is bound to it, `autouse=True` binds to
     every test in scope, and the fixture's returned or yielded class types the parameter;
   - mock targets: `patch("a.b.c")` (decorator, context manager, `mocker.patch`), `patch.object(X, "m")`,
     `monkeypatch.setattr(…)`, resolved the way `patch` looks them up. A patch started in `pytest_configure`,
     `pytest_sessionstart` or at conftest module level is session-wide: it applies to every test under that conftest;
   - direct test links: every edge from a test's own side (its body, fixtures, helpers, test class) into non-test
     code, minus whatever that test mocks. */
import { dirname } from 'node:path';
import { addEdge } from '../lang/python.mjs';

const isConftest = f => /(^|\/)conftest\.py$/.test(f);
const inScope = (conftest, file) => { const d = dirname(conftest); return d === '.' || file.startsWith(d + '/'); };
const SESSION_HOOK = /:(pytest_configure|pytest_sessionstart|<module>)$/;

export function findTests(py, R) {
  const isTestClass = k => /^Test/.test(k.name) || R.mro(k.id).some(c => py.classes.get(c)?.baseExprs.some(b => /(^|\.)(Async)?TestCase$/.test(b)));
  const tests = [];
  for (const s of py.symbols.values()) {
    if (s.group !== 'test' || (s.kind !== 'function' && s.kind !== 'method') || s.id.includes('<locals>') || s.id.includes('<main>') || !/^test/.test(s.name)) continue;
    if (s.cls && !isTestClass(py.classes.get(s.cls))) continue;
    tests.push({ id: s.id, file: s.file, line: s.start, end: s.end, asserts: s.asserts, assertLines: s.assertLines });
  }
  return tests;
}

export function findFixtures(py) {
  return [...py.symbols.values()].filter(s => (s.kind === 'function' || s.kind === 'method') && s.decos.some(d => /(^|\.)fixture(\(|$)/.test(d)))
    .map(s => ({ id: s.id, name: s.name, file: s.file, line: s.start, cls: s.cls || null, autouse: s.decos.some(d => /autouse\s*=\s*True/.test(d)) }));
}

// before call resolution: a bound parameter is typed by its fixture's returns
export function bindFixtures(py, tests, fixtures) {
  const bindings = [];
  const typesOf = new Map(); for (const c of py.rawCalls) if (!typesOf.has(c.from)) typesOf.set(c.from, c.types);
  const fixtureFor = (s, p) => {
    const cands = fixtures.filter(f => f.name === p && f.id !== s.id);
    return cands.find(f => f.cls && f.cls === s.cls) || cands.find(f => !f.cls && f.file === s.file)
      || cands.filter(f => !f.cls && isConftest(f.file) && inScope(f.file, s.file)).sort((a, b) => b.file.length - a.file.length)[0] || null;
  };
  for (const s of py.symbols.values()) if (s.group === 'test' && s.params && (s.kind === 'function' || s.kind === 'method')) {
    for (const p of s.params) { if (p === 'self' || p === 'cls') continue; const f = fixtureFor(s, p); if (!f) continue;
      bindings.push({ fn: s.id, param: p, fixture: f.id });
      const t = typesOf.get(s.id); if (t && !t.has(p)) t.set(p, { t: 'returns', fn: f.id }); }
  }
  for (const t of tests) for (const f of fixtures.filter(x => x.autouse))
    if (f.file === t.file || (isConftest(f.file) && inScope(f.file, t.file))) bindings.push({ fn: t.id, param: null, fixture: f.id, autouse: true });
  return bindings;
}

export function linkFixtures(py, bindings) {
  const s = id => py.symbols.get(id);
  for (const b of bindings) addEdge(py, b.fn, b.fixture, 'framework', s(b.fn)?.start, { rule: b.autouse ? 'pytest.fixture.autouse' : 'pytest.fixture',
    evidence: `${s(b.fn)?.file}: parameter ${b.param ?? '(autouse)'} -> fixture ${b.fixture.split(':').pop()} (${s(b.fixture)?.file}:${s(b.fixture)?.start})` });
}

export function mockTargets(py, R) {
  const resolveDotted = (raw, from) => { const parts = raw.split('.');
    for (let i = parts.length - 1; i >= 1; i--) { const mod = R.findModule(parts.slice(0, i).join('.'), from); if (!py.modules.has(mod)) continue;
      const rest = parts.slice(i), sc = { imports: py.modules.get(mod).imports, module: mod };
      const r = R.resolveName(rest[0], sc);
      if (rest.length === 1) return r?.id || null;
      if (rest.length === 2 && r?.id && py.classes.has(r.id)) return R.lookup(r.id, rest[1]);
      return null; }
    return null; };
  const fileOf = fn => py.symbols.get(fn)?.file || py.modules.get(fn.split(':')[0])?.file || '';
  const scoped = m => { const file = fileOf(m.fn); return isConftest(file) && SESSION_HOOK.test(m.fn) ? { ...m, scope: 'session', conftest: file } : m; };
  const mocks = [];
  for (const d of py.decorated) if (/(^|\.)patch$/.test(d.expr) && d.strArgs[0] && /\./.test(d.strArgs[0]))
    mocks.push({ fn: d.id, raw: d.strArgs[0], target: resolveDotted(d.strArgs[0], d.module), line: d.line, how: '@patch' });
  for (const c of py.rawCalls) {
    const a0 = c.args[0], s0 = a0?.type === 'string' ? a0.s : null, s1 = c.args[1]?.type === 'string' ? c.args[1].s : null;
    if ((/(^|\.)patch$/.test(c.expr) || /(^|\.)monkeypatch\.setattr$/.test(c.expr)) && s0 && /\./.test(s0))
      mocks.push(scoped({ fn: c.from, raw: s0, target: resolveDotted(s0, c.module), line: c.line, how: c.expr.split('.').pop() }));
    else if ((/(^|\.)patch\.object$/.test(c.expr) || /(^|\.)monkeypatch\.setattr$/.test(c.expr)) && a0 && s1) {
      let k = null; const r = R.resolveExpr(a0.text, c); if (r?.id && py.classes.has(r.id)) k = r.id;
      else if (c.types?.has(a0.text)) { const rc = R.receiverOf(c.types.get(a0.text), c); if (rc) k = rc.cls[0]; }
      mocks.push(scoped({ fn: c.from, raw: `${a0.text}.${s1}`, target: k ? R.lookup(k, s1) : null, line: c.line, how: 'patch.object' }));
    }
  }
  return mocks;
}

const FOLLOW = new Set(['static', 'ctor', 'framework', 'dispatch', 'queue', 'http', 'virtual']);
export function directLinks(py, tests, fixtures, mocks) {
  const out = new Map(); for (const e of py.edges) (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e);
  const G = id => py.symbols.get(id)?.group || (id.startsWith('ext:') ? 'ext' : 'prod');
  const fixtureIds = new Set(fixtures.map(f => f.id));
  const mocksIn = new Map(); for (const m of mocks) if (m.target && !m.scope) (mocksIn.get(m.fn) || mocksIn.set(m.fn, new Set()).get(m.fn)).add(m.target);
  const session = mocks.filter(m => m.target && m.scope === 'session');
  for (const t of tests) {
    const side = new Set([t.id]), q = [t.id];
    while (q.length) { const x = q.pop(); for (const e of out.get(x) || []) if (FOLLOW.has(e.kind) && G(e.to) === 'test' && !side.has(e.to)) { side.add(e.to); q.push(e.to); } }
    const tcls = py.symbols.get(t.id)?.cls; if (tcls) side.add(tcls);
    const mocked = new Set(session.filter(m => inScope(m.conftest, t.file)).map(m => m.target));
    for (const s of side) for (const m of mocksIn.get(s) || []) mocked.add(m);
    const links = new Map();
    for (const s of side) for (const e of out.get(s) || []) {
      if (!FOLLOW.has(e.kind) || G(e.to) === 'test' || e.to.startsWith('ext:') || mocked.has(e.to) || py.symbols.get(e.to)?.kind === 'class' || links.has(e.to)) continue;
      links.set(e.to, { to: e.to, via: s === t.id ? 'body' : fixtureIds.has(s) ? 'fixture' : 'helper', viaId: s, kind: e.kind, ...(e.rule ? { rule: e.rule } : {}), line: e.line, ...(e.recvClass ? { recvClass: e.recvClass } : {}) });
    }
    t.mocked = [...mocked].sort();
    t.direct = [...links.values()];
  }
}
