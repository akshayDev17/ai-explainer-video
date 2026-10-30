/* Rule pack: gRPC (Go). A server registration `pb.Register<Svc>Server(s, impl)` makes an `rpc` entry at each method
   of impl's type that serves the service: the methods of the `<Svc>Server` interface when the generated code is in
   the repo (its `mustEmbed…` marker left out), else impl's exported methods that take a `context.Context` first. A
   method impl only inherits from an embedded `Unimplemented<Svc>Server` is not served by it. The entry's path is the
   gRPC method's HTTP/2 path, `/<package>.<Svc>/<Method>`, the package read from the generated `grpc.ServiceDesc`
   (`ServiceName: "pkg.Svc"`), else `/<Svc>/<Method>`.
   A client call is an `http` crossing to that method's handler: in generated client code, `cc.Invoke(ctx, method, …)`
   / `cc.NewStream(ctx, desc, method)` whose method string (or the const naming it) is the path; else a call on a
   value made by `pb.New<Svc>Client(conn)` from an external package, matched by service and method name. */
import { addGoEdge, foldGo } from '../lang/go.mjs';

export function grpcEntries(go, R) {
  const entries = [];
  const fullName = svc => go.serviceNames.find(s => s.iface === `${svc}Server`)?.name || go.serviceNames.find(s => s.name.split('.').pop() === svc)?.name || svc;
  const ifaceOf = svc => [...go.classes.values()].find(k => k.iface && k.name === `${svc}Server`);
  for (const c of go.rawCalls) {
    const name = c.attr || (c.fn?.k === 'id' ? c.fn.name : null);
    const m = name && /^Register(\w+)Server$/.exec(name);
    if (!m || c.args.length < 2) continue;
    const svc = m[1], t = R.typeOf(c.args[1].ir, c), impl = t && R.classOf(t.t, t.module)?.cls;
    if (!impl) continue;
    const iface = ifaceOf(svc);
    const names = iface ? [...iface.methods.keys()].filter(n => !/^mustEmbed/.test(n))
      : [...new Set(R.embedChain(impl).flatMap(k => [...go.classes.get(k).methods.keys()]))].filter(n => /^[A-Z]/.test(n) && /context\.Context/.test(go.symbols.get(R.lookup(impl, n))?.text.split('\n')[0] || ''));
    const full = fullName(svc);
    for (const n of names) {
      const id = R.lookup(impl, n), s = id && go.symbols.get(id);
      if (!s || /^Unimplemented/.test(go.symbols.get(s.cls)?.name || '') || (s.decos || []).includes('abstractmethod')) continue;
      entries.push({ kind: 'rpc', path: `/${full}/${n}`, key: `${full}/${n}`, id, file: c.file, line: c.line, rule: 'grpc', service: full });
    }
  }
  return entries;
}

export function linkGrpcClients(go, R, rpcEntries) {
  const byPath = new Map(rpcEntries.map(e => [e.path, e])), links = [];
  const link = (c, e, how) => { addGoEdge(go, c.from, e.id, 'http', c.line, { rule: 'grpc.client', evidence: `${c.file}:${c.line} ${how} ${e.path}` });
    links.push({ from: c.from, file: c.file, line: c.line, path: e.path, handler: e.id }); };
  for (const c of go.rawCalls) {
    if (!c.attr) continue;
    if (c.attr === 'Invoke' || c.attr === 'NewStream') {
      const p = foldGo(R, c.args[c.attr === 'Invoke' ? 1 : 2]?.ir, c);
      const e = byPath.get(p);
      if (e) link(c, e, `invokes`);
      continue;
    }
    // a client made by an external package's New<Svc>Client: matched by service and method name
    let h = c.obj; if (h?.k !== 'id') continue;
    const spec = R.resolveName(h.name, c)?.local;
    const made = spec?.t === 'expr' && spec.ir.k === 'call' ? R.calleeOf(spec.ir.fn, c)?.ext : null;
    const m = made && /\.New(\w+)Client$/.exec(made);
    if (!m) continue;
    const e = rpcEntries.find(x => x.key.split('/')[0].split('.').pop() === m[1] && x.key.endsWith(`/${c.attr}`));
    if (e) link(c, e, `calls`);
  }
  return links;
}
