/* Rule pack: Celery / Taskiq.
   - consumers: `@<broker>.task(task_name=K)` / `@shared_task` -> a `queue-consumer` entry keyed K, or `scheduled`
     when the decorator carries `schedule=`;
   - producers: `.kiq()/.delay()/.apply_async()` on a consumer, `send_task("K")`, `AsyncKicker(task_name="K")` ->
     a `queue` crossing to the consumer. A kicker whose name is not a literal makes its function a dispatcher, which
     the registry pack uses. */
import { addEdge } from '../lang/python.mjs';

export function consumerEntry(py, d) {
  if (!/(\.|^)(task|shared_task)$/.test(d.expr)) return null;
  const s = py.symbols.get(d.id);
  return { kind: d.kwNames.includes('schedule') ? 'scheduled' : 'queue-consumer', id: d.id,
    key: d.kwArgs.task_name || d.kwArgs.name || d.strArgs[0] || s.name, line: d.line, file: s.file, rule: 'celery-taskiq.consumer' };
}

const literal = a => a && a.type === 'string' ? a.s : null;

export function linkProducers(py, R, entries) {
  const consumerByKey = new Map(entries.filter(e => e.kind === 'queue-consumer' || e.kind === 'scheduled').map(e => [e.key, e.id]));
  const consumers = new Set(consumerByKey.values());
  const kickers = [];
  for (const c of py.rawCalls) {
    if (c.attr === 'send_task' && literal(c.args[0]) != null) kickers.push({ fn: c.from, key: literal(c.args[0]), line: c.line });
    if (/(^|\.)AsyncKicker$|(^|\.)kicker$/.test(c.expr)) {
      const kw = c.args.find(a => a.kw === 'task_name');
      const key = kw ? kw.s : literal(c.args[0]);
      kickers.push({ fn: c.from, key, dynamic: key == null, line: c.line });
    }
  }
  const links = [], dispatchers = new Set();
  const sym = id => py.symbols.get(id);
  const sameNameInBases = id => { const s = sym(id); return s?.cls ? R.mro(s.cls).slice(1).map(b => py.classes.get(b)?.methods.get(s.name)).filter(Boolean) : []; };
  for (const k of kickers) {
    if (k.key != null) { const consumer = consumerByKey.get(k.key);
      if (consumer) { addEdge(py, k.fn, consumer, 'queue', k.line, { rule: 'taskiq.literal-key', evidence: `${sym(k.fn)?.file}:${k.line} kicks "${k.key}"` }); links.push({ fn: k.fn, key: k.key }); } }
    else { dispatchers.add(k.fn); for (const m of sameNameInBases(k.fn)) dispatchers.add(m); }
  }
  // methods that call a dispatcher in the same class count as dispatchers too (enqueue_batch -> enqueue)
  const rev = new Map();
  for (const e of py.edges) if (!e.rule && /^(static|virtual|dispatch|ctor)$/.test(e.kind)) (rev.get(e.to) || rev.set(e.to, new Set()).get(e.to)).add(e.from);
  for (const d of [...dispatchers]) for (const caller of rev.get(d) || []) if (sym(caller)?.cls && sym(caller)?.cls === sym(d)?.cls) dispatchers.add(caller);
  for (const d of [...dispatchers]) for (const m of sameNameInBases(d)) dispatchers.add(m);
  for (const c of py.rawCalls) if (c.attr && /^(kiq|delay|apply_async)$/.test(c.attr) && !c.obj.includes('(')) {
    const r = R.resolveName(c.obj.split('.')[0], c);
    if (r?.id && consumers.has(r.id)) { addEdge(py, c.from, r.id, 'queue', c.line, { rule: `taskiq.${c.attr}` }); links.push({ fn: c.from, direct: r.id }); }
  }
  return { links, dispatchers, consumerByKey };
}
