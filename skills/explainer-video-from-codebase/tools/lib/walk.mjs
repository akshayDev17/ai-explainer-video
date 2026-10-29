/* The candidate walk over a code map: from one symbol, down and back through the call graph, with the
   receiver class carried so self-calls resolve per receiver. Group rules (design §3.7, §3.15):
   - a non-test walk never enters test-group code: test doubles are counted and skipped;
   - a production walk expands any non-test code it reaches, labelling other groups' nodes (`crossGroup`);
   - an eval or dev walk folds every production symbol into a `uses-prod` leaf;
   - helper folding counts callers from the symbol's own group only, never through test code.
   A `py.callback` link (the callee runs a callable a caller handed it) is followed only from the caller that
   handed it over, so a walk that reached the callee some other way never picks up another caller's callable. */

export const FOLLOW = new Set(['static', 'ctor', 'framework', 'dispatch', 'queue', 'http', 'spawn', 'virtual']);
export const CROSSING = new Set(['queue', 'http', 'spawn']);
const DATA_BASES = /(^|\.)(BaseModel|BaseSettings|Exception|Error|Enum|StrEnum|IntEnum|TypedDict|NamedTuple|JSONResponse|Response)$/;
const isCallback = e => e.rule === 'py.callback';

export function indexCodemap(m, { fanin = 6, leafy = 5, ifaceFold = true } = {}) {
  const sym = new Map(m.symbols.map(s => [s.id, s]));
  const cls = new Map(m.classes.map(k => [k.id, k]));
  const G = id => sym.get(id)?.group || (id.startsWith('ext:') ? 'ext' : 'prod');
  const moduleOf = id => sym.get(id)?.module || (id.startsWith('ext:') ? 'ext' : id.split(':')[0]);
  const declCls = id => sym.get(id)?.cls || null;
  const isAbstract = id => (sym.get(id)?.decos || []).some(d => /abstractmethod/.test(d));
  const subclasses = new Map();
  for (const k of cls.values()) for (const b of k.bases) (subclasses.get(b) || subclasses.set(b, []).get(b)).push(k.id);
  const mro = (id, seen = new Set()) => seen.has(id) ? [] : (seen.add(id), [id, ...(cls.get(id)?.bases || []).flatMap(b => mro(b, seen))]);
  const lookup = (k, name) => { for (const c of mro(k)) { const x = cls.get(c)?.methods[name]; if (x) return x; } return null; };
  const overridesOf = (k, name, acc = []) => { for (const s of subclasses.get(k) || []) { const x = cls.get(s).methods[name]; if (x) acc.push(x); overridesOf(s, name, acc); } return acc; };
  const isData = (k, seen = new Set()) => { if (seen.has(k)) return false; seen.add(k); const c = cls.get(k); if (!c) return false;
    if (c.decos?.some(d => /dataclass/.test(d)) || c.baseExprs.some(b => DATA_BASES.test(b))) return true; return c.bases.some(b => isData(b, seen)); };
  const entryIds = new Set(m.entries.map(e => e.id));
  const altFactories = new Set(Object.entries(m.factories || {}).filter(([f, v]) => new Set(v.map(x => x.cls || x.ext)).size > 1 && !entryIds.has(f)).map(([f]) => f));
  const siteOf = new Map((m.config?.sites || []).map(s => [s.factory, s]));

  const out = new Map(), handedBy = new Map();
  for (const e of m.edges) {
    if (isCallback(e)) (handedBy.get(e.passedBy) || handedBy.set(e.passedBy, []).get(e.passedBy)).push(e);
    else (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e);
  }
  const visible = (grp, id) => grp === 'test' || G(id) !== 'test';
  const crossTargets = new Set(m.edges.filter(e => CROSSING.has(e.kind)).map(e => e.to));

  // fan-in (same-group callers; a production caller also counts for a library target) and subtree size
  const callers = new Map();
  for (const e of m.edges) if (FOLLOW.has(e.kind) && e.kind !== 'virtual' && !isCallback(e) && (G(e.from) === G(e.to) || (G(e.to) === 'ext' && G(e.from) === 'prod')))
    (callers.get(e.to) || callers.set(e.to, new Set()).get(e.to)).add(e.from);
  const subtree = new Map();
  const subtreeSize = start => {
    if (subtree.has(start)) return subtree.get(start);
    const grp = G(start), seen = new Set([start]), q = [start];
    while (q.length) { const x = q.pop(); for (const e of out.get(x) || []) if (FOLLOW.has(e.kind) && visible(grp, e.to) && !seen.has(e.to)) { seen.add(e.to); q.push(e.to); } }
    const n = [...seen].filter(x => !x.startsWith('ext:')).length - 1;
    subtree.set(start, n);
    return n;
  };
  const isHelper = id => !entryIds.has(id) && !crossTargets.has(id) && sym.get(id)?.kind !== 'class' &&
    (callers.get(id)?.size || 0) >= fanin && subtreeSize(id) <= leafy;

  /* walk from `start` as group `grp`. `stopAtCrossing` leaves queue/http/spawn targets unexpanded (segments,
     test reach); `stop` are symbols left unexpanded as `mocked` (what a test replaces); `ctx0` the receiver class */
  function expand(start, { grp = G(start.id), stopAtCrossing = false, stop = null, ctx0 } = {}) {
    const nodes = new Map(), order = [], dispatch = [], constructs = new Set(), crossings = [], branches = [], folded = new Set(), seenSite = new Set();
    const testDoubles = new Set(), usesProd = new Set(), crossGroup = new Set();
    const leafOf = kind => ifaceFold ? kind : null;
    const visit = (id, ctx, depth, via, parent, leaf) => {
      if (!visible(grp, id)) { testDoubles.add(id); return; }
      const key = id + '|' + (ctx || '');
      if (nodes.has(key)) return;
      const node = { id, ctx, depth, via, parent, folded: false };
      nodes.set(key, node); order.push(node);
      if (leaf) { node.folded = leaf; folded.add(id); return; }
      if (stop && stop.has(id)) { node.folded = 'mocked'; folded.add(id); return; }
      if (depth > 0 && grp !== 'prod' && G(id) === 'prod') { node.folded = 'uses-prod'; folded.add(id); usesProd.add(id); return; }
      if (depth > 0 && isHelper(id)) { node.folded = 'helper'; folded.add(id); return; }
      if (id.startsWith('ext:')) return;
      if (G(id) !== grp) crossGroup.add(id);
      const edges = out.get(id) || [];
      const sites = new Map();
      for (const e of edges) if (e.self || (e.site && (e.kind === 'dispatch' || e.kind === 'virtual'))) (sites.get(e.site) || sites.set(e.site, []).get(e.site)).push(e);
      for (const e of edges) {
        if (!FOLLOW.has(e.kind)) continue;
        if (!visible(grp, e.to)) { testDoubles.add(e.to); continue; }
        if (e.cfg) branches.push({ from: id, to: e.to, cfg: e.cfg, line: e.line, onFailure: e.onFailure });
        if (e.kind === 'ctor') {
          const k = cls.has(e.to) ? e.to : declCls(e.to);
          if (cls.has(e.to)) { if (isData(e.to)) constructs.add(e.to); continue; }
          if (isData(k)) continue;
          visit(e.to, k, depth + 1, 'ctor', id, altFactories.has(id) ? leafOf('alternative') : null);
          continue;
        }
        if (e.self) {
          if (seenSite.has(e.site + key)) continue;
          seenSite.add(e.site + key);
          const all = sites.get(e.site).map(x => x.to).filter(t => visible(grp, t));
          let targets, how;
          if (ctx) { const t = lookup(ctx, e.self); targets = [...new Set([t, ...overridesOf(ctx, e.self)].filter(Boolean))].filter(t => visible(grp, t)); how = 'receiver'; }
          else { targets = all; how = 'cha'; }
          if (all.length > 1 || targets.length > 1) dispatch.push({ site: e.site, attr: e.self, how, before: all.length, after: targets.length, ctx, targets });
          for (const t of targets) visit(t, ctx, depth + 1, targets.length > 1 ? 'virtual' : 'static', id);
          continue;
        }
        if (e.kind === 'virtual' || e.kind === 'dispatch') {
          if (e.site && seenSite.has(e.site + key + e.kind)) continue;
          if (e.site) seenSite.add(e.site + key + e.kind);
          const alts = (e.site ? (sites.get(e.site) || [e]).filter(x => x.kind === e.kind || x.kind === 'static') : [e]).filter(x => visible(grp, x.to));
          if (e.kind === 'dispatch' && e.rule === 'haystack.pipeline') {
            const comp = edges.filter(x => x.rule === 'haystack.pipeline' && x.component === e.component);
            dispatch.push({ site: `${id}@${e.line}:${e.component}`, attr: e.component, how: 'factory', before: comp.length, after: comp.length, targets: comp.map(x => x.to),
              selectors: comp.map(x => x.selectors), narrowedBy: e.narrowedBy, config: configOf(e.narrowedBy) });
            for (const x of comp) visit(x.to, declCls(x.to), depth + 1, 'framework', id);
            continue;
          }
          const concrete = alts.filter(x => !isAbstract(x.to));
          dispatch.push({ site: e.site, attr: e.site?.split(':').pop(), how: e.kind === 'dispatch' ? 'factory' : 'cha', before: alts.length, after: concrete.length,
            targets: alts.map(x => x.to), narrowedBy: e.narrowedBy, config: configOf(e.narrowedBy), collaborator: true });
          for (const x of alts) visit(x.to, declCls(x.to), depth + 1, e.kind, id, isAbstract(x.to) ? leafOf('interface') : concrete.length > 1 ? leafOf('alternative') : null);
          continue;
        }
        if (CROSSING.has(e.kind)) {
          crossings.push({ from: id, to: e.to, kind: e.kind, evidence: e.evidence, intoGroup: G(e.to) });
          if (!stopAtCrossing) visit(e.to, null, depth + 1, e.kind, id);
          continue;
        }
        if (e.kind === 'framework') { visit(e.to, declCls(e.to), depth + 1, 'framework', id); continue; }
        visit(e.to, e.recvClass || (e.passCtx ? ctx : null), depth + 1, 'static', id);
      }
      // callables this symbol handed to a callee: they run inside that callee, so they hang under it
      for (const e of handedBy.get(id) || []) if (visible(grp, e.to)) visit(e.to, declCls(e.to) ? ctx : null, depth + 2, 'callback', e.from);
    };
    visit(start.id, ctx0 !== undefined ? ctx0 : start.kind === 'ui-route' ? null : declCls(start.id), 0, 'entry', null);
    const ids = new Set(order.map(n => n.id));
    const own = new Set([...ids].filter(i => !folded.has(i) && !i.startsWith('ext:')));
    return { order, ids, own, folded, constructs, crossings, branches, dispatch, testDoubles, usesProd, crossGroup,
      modules: new Set([...own].map(moduleOf)), maxDepth: Math.max(...order.map(n => n.depth)) };
  }
  const configOf = factory => { const s = factory && siteOf.get(factory);
    return s ? { classification: s.classification, alternatives: s.alternatives.map(a => ({ cls: a.cls, group: a.group, guards: a.guards })) } : undefined; };

  return { sym, G, moduleOf, declCls, out, entryIds, isHelper, expand };
}
