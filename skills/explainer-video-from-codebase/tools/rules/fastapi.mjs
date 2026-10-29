/* Rule pack: FastAPI / Starlette.
   - routes: `@<router>.get/post/…(path)` where <router> is an APIRouter or FastAPI app (a module-level variable,
     imported or not, or a function's local or parameter, built by `APIRouter()` / `FastAPI()`, an in-repo subclass
     of either, or a factory returning one) -> an `http` entry. Its path is every `include_router(r, prefix=)` up the include chain (at module level
     or inside an app factory) + `APIRouter(prefix=)` + the decorator path;
   - DI: `p: T = Depends(provider)` and `Alias = Annotated[T, Depends(provider)]` -> handler links to provider;
     a parameter typed by such an alias is narrowed to whatever the provider returns. */
import { addEdge } from '../lang/python.mjs';

const simpleType = t => {
  const s = t.replace(/^["']|["']$/g, '').replace(/\s*\|\s*None\b|\bNone\s*\|\s*/g, '').replace(/^Optional\[(.*)\]$/, '$1').trim();
  return /^[A-Za-z_][\w.]*$/.test(s) ? s : null;
};

// before call resolution: aliases must be known for receivers typed by them
export function registerAliases(py) {
  for (const a of py.moduleAssigns) {
    if (!a.sub || !/(^|\.)Annotated$/.test(a.sub.value)) continue;
    const dep = a.sub.items.find(x => x.type === 'call' && /(^|\.)Depends$/.test(x.fn));
    if (!dep || !a.sub.items[0]) continue;
    const aid = `${a.module}:${a.name}`;
    py.modules.get(a.module).defs.set(a.name, aid);
    const provider = /^[\w.]+\(\s*([^,)]+)/.exec(dep.text)?.[1].trim() ?? null;
    py.typeAliases.set(aid, { type: simpleType(a.sub.items[0].text), provider, line: a.line, module: a.module, imports: a.imports, locals: new Map() });
  }
}

const ROUTER = /(^|\.)(APIRouter|FastAPI)$/;

// a router's prefix as mounted: each include_router prefix up the chain, then its own APIRouter(prefix=)
export function routePrefixes(py, R) {
  const routerClass = id => R.mro(id).some(c => py.classes.get(c).baseExprs.some(b => ROUTER.test(b) || ROUTER.test(R.resolveExpr(b, py.classes.get(c))?.ext || '')));
  const makesRouter = (expr, sc) => { if (!expr) return false; if (ROUTER.test(expr)) return true; const r = R.resolveExpr(expr, sc);
    return !!(r?.ext && ROUTER.test(r.ext)) || !!(r?.id && (py.classes.has(r.id) ? routerClass(r.id) : R.factoryReturns(r.id).some(x => x.ext && ROUTER.test(x.ext)))); };
  const routers = new Map();   // `module:name` (or `fn#name` for a local) -> own prefix
  for (const a of py.moduleAssigns) if (a.fn && makesRouter(a.fn, a)) {
    const kw = a.args.find(x => x.kw === 'prefix');
    routers.set(`${a.module}:${a.name}`, kw?.s || '');
  }
  const moduleRouter = (name, sc, depth = 0) => {   // a module-level router named in scope, followed through imports
    if (sc.locals?.has(name)) return null;
    if (routers.has(`${sc.module}:${name}`)) return `${sc.module}:${name}`;
    const t = sc.imports.get(name);
    if (!t?.from || depth > 4) return null;
    const mod = R.findModule(t.from, t.in), M = py.modules.get(mod);
    return M ? moduleRouter(t.name, { imports: M.imports, module: mod }, depth + 1) : null;
  };
  const routerOf = (expr, sc, fn) => {   // `router`, `items.router`, an imported router, or a local / parameter
    const parts = expr.split('.');
    if (parts.length === 1) {
      const spec = sc.types?.get(expr);
      if (fn && spec?.expr && makesRouter(spec.expr, sc)) return `${fn}#${expr}`;
      return moduleRouter(expr, sc);
    }
    const r = R.resolveName(parts[0], sc);
    if (!r?.module) return null;
    const id = `${[r.module, ...parts.slice(1, -1)].join('.')}:${parts.at(-1)}`;
    return routers.has(id) ? id : null;
  };
  const includes = new Map();   // router -> { parent, prefix }, the first include_router of it
  for (const c of py.rawCalls) if (c.attr === 'include_router' && c.args[0] && c.args[0].type !== 'keyword_argument') {
    const parent = routerOf(c.obj, c, c.top ? null : c.from), child = routerOf(c.args[0].text, c, c.top ? null : c.from);
    if (parent && child && !includes.has(child)) includes.set(child, { parent, prefix: c.args.find(x => x.kw === 'prefix')?.s || '' });
  }
  const mounted = (id, seen = new Set()) => { if (seen.has(id)) return ''; seen.add(id);
    const inc = includes.get(id); return (inc ? mounted(inc.parent, seen) + inc.prefix : '') + (routers.get(id) || ''); };
  // a decorator's route prefix, or null when its receiver is not a router (`@mock.patch(…)` is no route)
  return d => { const id = routerOf(d.expr.slice(0, d.expr.lastIndexOf('.')), d, d.fn); return id ? mounted(id) : null; };
}

const HTTP = /\.(get|post|put|patch|delete|api_route|websocket)$/;
export function routeEntry(py, d, prefixOf) {
  if (!HTTP.test(d.expr)) return null;
  const prefix = prefixOf(d);
  if (prefix == null) return null;
  const s = py.symbols.get(d.id);
  return { kind: 'http', id: d.id, method: d.expr.split('.').pop().toUpperCase(), path: prefix + (d.strArgs[0] || ''),
    line: d.line, file: s.file, rule: 'fastapi.route' };
}

export function linkDepends(py, R) {
  const links = [];
  const file = id => py.symbols.get(id)?.file;
  for (const p of py.annotParams) {
    const r = R.resolveExpr(p.annot, p); if (!r?.id || !py.typeAliases.has(r.id)) continue;
    const a = py.typeAliases.get(r.id); const pr = a.provider ? R.resolveExpr(a.provider, a) : null;
    if (!pr?.id) continue;
    addEdge(py, p.fn, pr.id, 'framework', p.line, { rule: 'fastapi.Depends', evidence: `${file(p.fn)}:${p.line} ${p.param}: ${p.annot} = Annotated[${a.type}, Depends(${a.provider})] (${py.modules.get(a.module)?.file}:${a.line})` });
    links.push({ fn: p.fn, provider: pr.id, param: p.param, via: p.annot });
  }
  for (const d of py.paramDefaults) {
    if (!/(^|\.)Depends$/.test(d.call) || !d.a0) continue;
    const r = R.resolveExpr(d.a0, d);
    if (!r?.id) continue;
    addEdge(py, d.fn, r.id, 'framework', d.line, { rule: 'fastapi.Depends', evidence: `${file(d.fn)}:${d.line} ${d.param}=Depends(${d.a0})` });
    links.push({ fn: d.fn, provider: r.id, param: d.param });
  }
  return links;
}
