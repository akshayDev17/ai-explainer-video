/* Rule pack: registry dispatch. A `{TypeName: "key"}` table read by a dispatcher whose task name is dynamic routes
   each message type to the consumer keyed "key". A function that constructs TypeName links to that consumer only
   when it (or a caller up to 3 levels) reaches a dispatcher within 3 calls, i.e. the message really is enqueued.
   The link carries the producer's group: a test that builds a job and reaches the (mocked) dispatcher is test
   evidence ("this test enqueues X"), never a production crossing. */
import { addEdge } from '../lang/python.mjs';

export function linkRegistry(py, dispatchers, consumerByKey) {
  const fwd = new Map(), rev = new Map();
  for (const e of py.edges) if (!e.rule && /^(static|virtual|dispatch|ctor)$/.test(e.kind)) {
    (fwd.get(e.from) || fwd.set(e.from, new Set()).get(e.from)).add(e.to);
    (rev.get(e.to) || rev.set(e.to, new Set()).get(e.to)).add(e.from); }
  const reaches = (start, targets, depth) => { let frontier = [start]; const seen = new Set(frontier);
    for (let d = 0; d < depth; d++) { const nx = []; for (const x of frontier) for (const y of fwd.get(x) || []) { if (targets.has(y)) return true; if (!seen.has(y)) { seen.add(y); nx.push(y); } } frontier = nx; } return false; };
  const ancestors = (f, depth) => { const out = new Set([f]); let fr = [f];
    for (let d = 0; d < depth; d++) { const nx = []; for (const x of fr) for (const y of rev.get(x) || []) if (!out.has(y)) { out.add(y); nx.push(y); } fr = nx; } return out; };
  const classByName = new Map([...py.classes.values()].filter(k => k.id === `${k.module}:${k.name}`).map(k => [k.name, k.id]));
  const groupOf = id => py.symbols.get(id)?.group || py.modules.get(id.split(':')[0])?.group || 'prod';
  const keys = [];
  for (const p of py.dictPairs) {
    const consumer = consumerByKey.get(p.value), cls = classByName.get(p.key);
    if (!consumer || !cls) continue;
    const all = [...new Set(py.edges.filter(e => e.kind === 'ctor' && e.to === cls).map(e => e.from))];
    const kept = all.filter(f => [...ancestors(f, 3)].some(a => reaches(a, dispatchers, 3)));
    keys.push({ key: p.value, messageType: cls, consumer, evidence: `${p.file}:${p.line}`, candidates: all.length, kept: kept.length,
      dropped: all.filter(f => !kept.includes(f)) });
    for (const f of kept) addEdge(py, f, consumer, 'queue', null, { rule: 'registry', group: groupOf(f),
      evidence: `constructs ${p.key} and reaches a dispatcher; ${p.file}:${p.line} maps it to "${p.value}"` });
  }
  return keys;
}
