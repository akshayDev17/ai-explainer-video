/* Direct test links, for every language whose test pack records tests, hooks bound as framework edges, and mock
   targets (jest / vitest, go test, gtest / Catch2): every edge from a test's own side (its body, its hooks, test-side
   helpers, reached through test-group edges) into non-test code is a direct link to its target, unless that test
   mocks the target. A mock with a `scope: 'session'` applies to every test under its `covers` directory; one recorded
   on `<file>:<module>` (hoisted) to every test in that file; any other to the tests whose side holds its `fn`. */
const under = (dir, file) => !dir || file.startsWith(dir + '/');

const FOLLOW = new Set(['static', 'ctor', 'framework', 'dispatch', 'queue', 'http', 'virtual']);
export function directLinks(tests, mocks, edges, symbolOf) {
  const out = new Map(); for (const e of edges) (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e);
  const G = id => symbolOf(id)?.group || (id.startsWith('ext:') ? 'ext' : 'prod');
  const mocksIn = new Map(); for (const m of mocks) if (m.target && !m.scope) (mocksIn.get(m.fn) || mocksIn.set(m.fn, new Set()).get(m.fn)).add(m.target);
  const session = mocks.filter(m => m.target && m.scope === 'session');
  for (const t of tests) {
    const side = new Set([t.id]), q = [t.id];
    while (q.length) { const x = q.pop(); for (const e of out.get(x) || []) if (FOLLOW.has(e.kind) && G(e.to) === 'test' && !side.has(e.to)) { side.add(e.to); q.push(e.to); } }
    const mocked = new Set(session.filter(m => under(m.covers, t.file)).map(m => m.target));
    for (const s of [...side, `${t.file}:<module>`]) for (const m of mocksIn.get(s) || []) mocked.add(m);
    const hooks = new Set([...side].filter(s => symbolOf(s)?.hook));
    const links = new Map();
    for (const s of side) for (const e of out.get(s) || []) {
      if (!FOLLOW.has(e.kind) || G(e.to) === 'test' || e.to.startsWith('ext:') || mocked.has(e.to) || symbolOf(e.to)?.kind === 'class' || links.has(e.to)) continue;
      links.set(e.to, { to: e.to, via: s === t.id ? 'body' : hooks.has(s) ? 'fixture' : 'helper', viaId: s, kind: e.kind, ...(e.rule ? { rule: e.rule } : {}), line: e.line, ...(e.recvClass ? { recvClass: e.recvClass } : {}) });
    }
    t.mocked = [...mocked].sort();
    t.direct = [...links.values()];
  }
}
