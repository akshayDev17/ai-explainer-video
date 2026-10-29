/* Rule pack: FastAPI / Starlette.
   - routes: `@<router>.get/post/…(path)` -> an `http` entry, its path rebuilt from `include_router(prefix=)` +
     `APIRouter(prefix=)` + the decorator path;
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

export function routePrefixes(py, R) {
  const routerPrefix = new Map(), includePrefix = new Map();
  for (const a of py.moduleAssigns) if (a.fn && /APIRouter$/.test(a.fn)) {
    const kw = a.args.find(x => x.kw === 'prefix');
    routerPrefix.set(a.module, kw ? kw.s : '');
  }
  for (const c of py.rawCalls) if (c.top && /\.include_router$/.test(c.expr) && c.args.length) {
    const kw = c.args.find(x => x.kw === 'prefix');
    const r = R.resolveName(c.args[0].text.split('.')[0], { imports: py.modules.get(c.module).imports, module: c.module });
    if (r && r.module) includePrefix.set(r.module, kw ? kw.s : '');
  }
  return module => (includePrefix.get(module) || '') + (routerPrefix.get(module) || '');
}

const HTTP = /\.(get|post|put|patch|delete|api_route|websocket)$/;
export function routeEntry(py, d, prefixOf) {
  if (!HTTP.test(d.expr)) return null;
  const s = py.symbols.get(d.id);
  return { kind: 'http', id: d.id, method: d.expr.split('.').pop().toUpperCase(), path: prefixOf(s.module) + (d.strArgs[0] || ''),
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
