/* Rule pack: Go HTTP routers — net/http, gin, echo, chi. A router is a value made by `http.NewServeMux()` (or the
   `http` package's default mux), `gin.Default()` / `gin.New()`, `echo.New()`, `chi.NewRouter()` / `chi.NewMux()`; a
   variable, a struct field or a parameter typed as one of their router types (`*http.ServeMux`, `*gin.Engine`,
   `*gin.RouterGroup`, `*echo.Echo`, `*echo.Group`, `chi.Router`, `*chi.Mux`) is one too. A route registration makes
   an `http` entry at its handler:
   - net/http: `Handle` / `HandleFunc(pattern, h)`, the pattern's method and path (Go 1.22: "GET /items/{id}"),
     else any method; `http.HandlerFunc(f)` is f, a value whose type has `ServeHTTP` is that method, and a call of an
     in-repo function that wraps a handler (`logged(h)`) is h, the wrapper linked as middleware;
   - gin: `GET/POST/…/Any/Handle(…, h...)`, the last handler is the route's, the ones before it its middleware;
   - echo: `GET/POST/…/Any/Add(…, h, mw...)`, the first is the route's, the rest its middleware;
   - chi: `Get/Post/…/Method/Handle/HandleFunc(…, h)`.
   Prefixes compose: gin and echo `Group(prefix)`, chi `Route(prefix, func(r chi.Router) {…})`, `Group(func(r) {…})`
   and `Mount(prefix, sub)`, net/http `Handle(prefix, http.StripPrefix(p, sub))` or `Handle(p, sub)`, and a router
   handed to a function (`routes.Register(api)`) carries its prefix into that function's parameter. `:id` and `*rest`
   (gin, echo), `{id:[0-9]+}` (chi) and `{rest...}` (net/http) are written `{id}`. A function handed to a
   registration is the router's to run, never a call from the registering code. */
import { addGoEdge, foldGo } from '../lang/go.mjs';

const KIND = [
  [/^net\/http\.(ServeMux|NewServeMux)$/, 'net-http'],
  [/^github\.com\/gin-gonic\/gin\.(Engine|RouterGroup|IRouter|IRoutes|Default|New)$/, 'gin'],
  [/^github\.com\/labstack\/echo(\/v\d+)?\.(Echo|Group|New)$/, 'echo'],
  [/^github\.com\/go-chi\/chi(\/v\d+)?\.(Mux|Router|NewRouter|NewMux)$/, 'chi'],
];
const kindOfExt = ext => KIND.find(([re]) => re.test(ext || ''))?.[1] || null;
const METHODS = {
  'net-http': /^(Handle|HandleFunc)$/,
  gin: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Handle)$/,
  echo: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE|Any|Add)$/,
  chi: /^(Get|Post|Put|Patch|Delete|Head|Options|Connect|Trace|Method|MethodFunc|Handle|HandleFunc)$/,
};
const VERB = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', Head: 'HEAD', Options: 'OPTIONS', Connect: 'CONNECT', Trace: 'TRACE' };

export function goRoutes(go, R) {
  const fold = (a, c) => a ? foldGo(R, a.ir, c) : null;
  const extCallee = (ir, sc) => ir?.k === 'call' ? R.calleeOf(ir.fn, sc)?.ext || null : null;
  // a router expression -> { key, kind } (the key names one router value); mounts records where a child hangs
  const mounts = new Map(), kinds = new Map();
  const root = (key, kind) => { kinds.set(key, kind); return { key, kind }; };
  const mount = (child, parent, prefix) => { if (child && parent && child.key !== parent.key && !mounts.has(child.key)) mounts.set(child.key, { parent: parent.key, prefix }); };
  function ownerOf(ir, c, depth = 0) {
    if (!ir || depth > 6) return null;
    if (ir.k === 'id') {
      const r = R.resolveName(ir.name, c);
      if (r?.ext === 'net/http') return root('net/http#DefaultServeMux', 'net-http');
      const spec = r?.local || r?.var;
      if (!spec) return null;
      const key = r.local ? `${c.from}#${ir.name}` : `${spec.module}#${ir.name}`;
      if (spec.t === 'annot') {
        const k = kindOfExt(R.classOf(spec.type, spec.module || c.module)?.ext);
        if (!k) return null;
        if (spec.closureOf != null) {   // chi `Route(prefix, func(r chi.Router) {…})` / `Group(func(r) {…})`: a child of the call's router
          const call = go.rawCalls[spec.closureOf], parent = call?.obj && ownerOf(call.obj, call, depth + 1);
          const child = root(`${c.from}@${call?.line}#${ir.name}`, k);
          if (parent) mount(child, parent, call.attr === 'Route' ? fold(call.args[0], call) : '');
          return child;
        }
        const p = go.symbols.get(c.from)?.params?.indexOf(ir.name);
        return root(p >= 0 ? `${c.from}#p${p}` : key, k);
      }
      if (spec.t !== 'expr') return null;
      const sc = r.local ? c : { module: spec.module, from: `${spec.module}:<module>`, types: null, consts: null };
      return named(key, valueOwner(spec.ir, sc, depth + 1));
    }
    if (ir.k === 'sel') {   // a struct field: `s.router`
      const t = R.typeOf(ir, c), k = t && kindOfExt(R.classOf(t.t, t.module)?.ext);
      if (!k) return null;
      const o = R.typeOf(ir.obj, c), cls = o && R.classOf(o.t, o.module)?.cls;
      return root(`${cls || c.from}.${ir.field}`, k);
    }
    if (ir.k === 'call') return named(`${c.from}@${c.line}`, valueOwner(ir, c, depth + 1));   // a chain: `r.Group("/v1").GET(…)`
    return null;
  }
  // the router a key names, given what its value makes
  const named = (key, v) => !v ? null : v.how === 'same' ? v.owner : v.how === 'new' ? root(key, v.kind) : (mount(root(key, v.parent.kind), v.parent, v.prefix), { key, kind: v.parent.kind });
  // what a value expression makes: a new router, a group of an existing one, or an existing one
  function valueOwner(ir, sc, depth) {
    if (depth > 6) return null;
    if (ir.k !== 'call') { const o = ownerOf(ir, sc, depth + 1); return o ? { how: 'same', owner: o } : null; }
    const ext = extCallee(ir, sc), k = kindOfExt(ext);
    if (k && /\.(NewServeMux|Default|New|NewRouter|NewMux)$/.test(ext)) return { how: 'new', kind: k };
    if (ir.fn.k === 'sel' && ir.fn.field === 'With') { const o = ownerOf(ir.fn.obj, sc, depth + 1); return o ? { how: 'same', owner: o } : null; }   // chi `r.With(mw)`
    if (ir.fn.k === 'sel' && /^(Group|Route)$/.test(ir.fn.field) && ir.args[0] && ir.args[0].k !== 'fn') {
      const parent = ownerOf(ir.fn.obj, sc, depth + 1);
      if (parent) return { how: 'group', parent, prefix: foldGo(R, ir.args[0], sc) };
    }
    // a function that builds and returns a router: `apiRouter()` is the router it returns
    const fn = R.calleeOf(ir.fn, sc)?.id;
    for (const ret of fn ? go.returns.filter(x => x.fn === fn && x.ir.k === 'id') : []) { const o = ownerOf(ret.ir, { ...ret, from: fn }, depth + 1); if (o) return { how: 'same', owner: o }; }
    return null;
  }
  const fnOf = id => { const s = id && go.symbols.get(id); return s && (s.kind === 'function' || s.kind === 'method') && !(s.decos || []).includes('abstractmethod') ? id : null; };
  // a handler argument -> { id, middleware: [ids] }
  function handlerOf(a, c, depth = 0) {
    if (!a || depth > 4) return null;
    if (a.fnId) return { id: a.fnId, middleware: [] };
    const ir = a.ir || a;
    if (ir.k === 'id' || ir.k === 'sel') {
      const t = R.calleeOf(ir, c); if (fnOf(t?.id)) return { id: t.id, middleware: [] };
      const v = R.typeOf(ir, c), cls = v && R.classOf(v.t, v.module)?.cls, sh = cls && R.lookup(cls, 'ServeHTTP');
      return sh ? { id: sh, middleware: [] } : null;
    }
    if (ir.k === 'lit') { const cls = R.classOf(ir.type, c.module)?.cls, sh = cls && R.lookup(cls, 'ServeHTTP'); return sh ? { id: sh, middleware: [] } : null; }
    if (ir.k === 'call') {
      const ext = extCallee(ir, c);
      if (/^net\/http\.HandlerFunc$/.test(ext || '')) return handlerOf(ir.args[0], c, depth + 1);
      const t = R.calleeOf(ir.fn, c), fn = fnOf(t?.id);
      if (!fn) return null;
      const inner = ir.args.map(x => handlerOf(x, c, depth + 1)).find(Boolean);
      return inner ? { id: inner.id, middleware: [...inner.middleware, fn] } : { id: fn, middleware: [] };   // `s.handleX()` returns the handler it builds
    }
    return null;
  }
  const regs = [], claimed = new Set(), byTarget = new Map();
  for (const c of go.rawCalls) if (c.target) (byTarget.get(c.target) || byTarget.set(c.target, []).get(c.target)).push(c);
  // a router handed to a function carries its prefix into the parameter
  for (const [fn, calls] of byTarget) {
    const s = go.symbols.get(fn); if (!s?.paramTypes) continue;
    s.paramTypes.forEach((t, p) => { if (!kindOfExt(R.classOf(t, s.file)?.ext)) return;
      for (const c of calls) { const o = c.args[p] && ownerOf(c.args[p].ir, c); if (o) { mount({ key: `${fn}#p${p}` }, o, ''); break; } } });
  }
  go.rawCalls.forEach((c, i) => {
    if (!c.attr || !c.obj) return;
    const owner = ownerOf(c.obj, c);
    if (!owner) return;
    const k = owner.kind;
    if (c.attr === 'Mount' && k === 'chi') { const sub = ownerOf(c.args[1]?.ir, c); if (sub) mount(sub, owner, fold(c.args[0], c)); claimed.add(i); return; }
    if (k === 'net-http' && c.attr === 'Handle') {   // a sub-mux under a pattern, with or without StripPrefix
      const a1 = c.args[1]?.ir;
      const strip = a1?.k === 'call' && /^net\/http\.StripPrefix$/.test(extCallee(a1, c) || '') ? a1 : null;
      const sub = ownerOf(strip ? strip.args[1] : a1, c);
      if (sub) { mount(sub, owner, strip ? foldGo(R, strip.args[0], c) : ''); claimed.add(i); return; }
    }
    if (!METHODS[k]?.test(c.attr)) return;
    let method, pathArg, hs;
    if (k === 'net-http') {
      const pat = fold(c.args[0], c);
      const m = pat && /^(?:([A-Z]+)\s+)?(?:[\w.-]+)?(\/\S*)$/.exec(pat);
      if (!m) return;
      method = m[1] || '*'; pathArg = m[2]; hs = [c.args[1]];
    } else if ((k === 'gin' && c.attr === 'Handle') || (k === 'echo' && c.attr === 'Add') || (k === 'chi' && /^Method(Func)?$/.test(c.attr))) {
      method = fold(c.args[0], c); pathArg = fold(c.args[1], c); hs = c.args.slice(2);
    } else {
      method = c.attr === 'Any' || c.attr === 'Handle' || c.attr === 'HandleFunc' ? '*' : VERB[c.attr] || c.attr; pathArg = fold(c.args[0], c); hs = c.args.slice(1);
    }
    if (pathArg == null || (!pathArg.startsWith('/') && !(pathArg === '' && mounts.has(owner.key)))) return;
    claimed.add(i);
    // chi `r.With(mw...).Get(…)`: the With call's arguments are this route's middleware, handed to the router too
    const withMw = [];
    for (let o = c.obj; o?.k === 'call' && o.fn.k === 'sel' && o.fn.field === 'With'; o = o.fn.obj) {
      withMw.push(...o.args.map(a => handlerOf(a, c)?.id).filter(Boolean));
      const w = go.rawCalls.findIndex(x => x.attr === 'With' && x.line === c.line && x.from === c.from); if (w >= 0) claimed.add(w);
    }
    const found = hs.map(a => handlerOf(a, c)).filter(Boolean);
    if (!found.length) return;
    const main = k === 'echo' ? found[0] : found.at(-1);
    const middleware = [...withMw, ...(k === 'echo' ? found.slice(1) : found.slice(0, -1)).map(h => h.id), ...main.middleware];
    regs.push({ owner: owner.key, kind: k, method: method.toUpperCase(), path: pathArg, handler: main.id, middleware, file: c.file, line: c.line });
  });
  const fullPath = (owner, path, seen = new Set()) => {
    let p = path;
    for (let o = owner; mounts.has(o) && !seen.has(o); o = mounts.get(o).parent) { seen.add(o); const pre = mounts.get(o).prefix || ''; p = `${pre.replace(/\/$/, '')}${p.startsWith('/') ? '' : '/'}${p}`; }
    p = p.replace(/\/{2,}/g, '/').replace(/\{\$\}/g, '').replace(/[:*](\w+)/g, '{$1}').replace(/\{(\w+)(?::[^}]*|\.\.\.)\}/g, '{$1}');
    return p.length > 1 ? p.replace(/\/$/, '') : p;
  };
  const routes = [];
  for (const g of regs) {
    const path = fullPath(g.owner, g.path);
    routes.push({ kind: 'http', method: g.method, path, id: g.handler, file: g.file, line: g.line, rule: `go.${g.kind}` });
    for (const mw of g.middleware) addGoEdge(go, g.handler, mw, 'framework', g.line, { rule: 'go.middleware', evidence: `${g.file}:${g.line} ${g.method} ${path} runs ${go.symbols.get(mw)?.name} around it` });
  }
  return { routes, claimed, mounts: [...mounts].map(([child, m]) => ({ child, parent: m.parent, prefix: m.prefix })) };
}
