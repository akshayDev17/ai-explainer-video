/* Rule pack: Haystack pipelines. A builder function (Pipeline() + add_component + connect) wires components;
   `p.run()` on a builder's result calls each component's `run` in connect order. A component built by a
   factory becomes `dispatch` links carrying the factory's branch guards; a library component is a named
   external leaf. */
import { addEdge } from '../lang/python.mjs';

const literal = a => a && a.type === 'string' ? a.s : null;

export function linkPipelines(py, R) {
  const builders = new Map();
  const sym = id => py.symbols.get(id);
  for (const c of py.rawCalls) {
    if (c.attr === 'add_component' && c.args.length >= 2) {
      const b = builders.get(c.from) || builders.set(c.from, { fn: c.from, comps: new Map(), order: [] }).get(c.from);
      const v = c.args[1];
      const asTargets = (expr, sc) => { const r = R.resolveExpr(expr, sc);
        if (r?.id && py.classes.has(r.id)) return [{ cls: r.id }];
        if (r?.ext) return [{ ext: r.ext }];
        if (r?.id && sym(r.id)?.kind === 'function') return R.factoryReturns(r.id).map(x => ({ ...x, factory: r.id }));
        return []; };
      const type = v.type === 'identifier' ? c.types?.get(v.text) : null;
      const targets = v.type === 'call' ? asTargets(v.fn, c) : type ? asTargets(type.expr, c) : [];
      b.comps.set(literal(c.args[0]), { targets, line: c.line });
    }
  }
  for (const c of py.rawCalls) if (c.attr === 'connect' && c.args.length >= 2 && literal(c.args[0]) != null && literal(c.args[1]) != null) {
    const b = builders.get(c.from); if (b) b.order.push([literal(c.args[0]).split('.')[0], literal(c.args[1]).split('.')[0], c.line]);
  }
  for (const b of builders.values()) {   // topological order from the connect pairs
    const names = [...b.comps.keys()], indeg = new Map(names.map(n => [n, 0]));
    for (const [, y] of b.order) indeg.set(y, (indeg.get(y) || 0) + 1);
    const seq = [], q = names.filter(n => !indeg.get(n));
    while (q.length) { const n = q.shift(); seq.push(n); for (const [x, y] of b.order) if (x === n) { indeg.set(y, indeg.get(y) - 1); if (!indeg.get(y)) q.push(y); } }
    b.seq = seq.length === names.length ? seq : names;
  }
  const runs = [];
  for (const c of py.rawCalls) if (c.attr === 'run' && c.types?.has(c.obj)) {
    const spec = c.types.get(c.obj);
    const r = spec.expr ? R.resolveExpr(spec.expr, c) : null;
    const b = r?.id ? builders.get(r.id) : (spec.expr === 'Pipeline' ? builders.get(c.from) : null);
    if (!b) continue;
    b.seq.forEach((name, i) => {
      const comp = b.comps.get(name);
      const ev = `${sym(b.fn).file}:${comp.line} add_component("${name}") · connect order ${i + 1}/${b.seq.length}`;
      const kind = comp.targets.length > 1 ? 'dispatch' : 'framework';
      for (const t of comp.targets) {
        const extra = { rule: 'haystack.pipeline', order: i, component: name, evidence: ev, selectors: t.guards?.map(g => (g.neg ? 'not ' : '') + g.text), narrowedBy: t.factory };
        if (t.cls) { const run = R.lookup(t.cls, 'run'); if (run) addEdge(py, c.from, run, kind, c.line, extra); }
        else if (t.ext) addEdge(py, c.from, `ext:${t.ext}.run`, kind, c.line, { ...extra, external: true });
      }
    });
    runs.push({ caller: c.from, builder: b.fn, seq: b.seq, comps: Object.fromEntries([...b.comps].map(([n, v]) => [n, v.targets.map(t => t.cls || 'ext:' + t.ext)])) });
  }
  return runs;
}
