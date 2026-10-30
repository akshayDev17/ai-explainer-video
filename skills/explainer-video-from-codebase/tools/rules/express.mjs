/* Rule pack: Express. An app is `express()` (the default import of 'express' or its `require`); a router is
   `express.Router()` or `Router()` from 'express' (a module-level variable, imported or not, a function's local, or a
   parameter annotated `Router` / `Express` / `Application`). `<app|router>.<method>(path, ...handlers)` and
   `<router>.route(path).<method>(...handlers)` make an `http` entry at the last handler; each handler before it is
   middleware, linked from that handler (`framework`, express.middleware). `<app|router>.use([prefix,] router)` mounts
   a router: a route's path is every mount prefix up the chain, then its own; `:id` is written `{id}`. A function
   handed to a registration is the router's to run, so it is never a call from the registering code. */
import { addTsEdge, foldString } from '../lang/typescript.mjs';

const METHOD = /^(get|post|put|patch|delete|del|all|options|head)$/;
const EXPRESS = /^express(\.default)?(\.Router)?$|^express\.(Express|Application|Router)$/;

export function expressRoutes(ts, R) {
  const isExpress = (spec, sc) => { if (!spec) return false; const r = R.resolveExpr(spec.expr, sc); return !!(r?.ext && EXPRESS.test(r.ext)); };
  // the router an expression names, as `<owner>#<name>`, or null
  const routerOf = (name, c) => {
    if (!/^[\w$]+$/.test(name)) return null;
    if (c.types?.has(name)) return isExpress(c.types.get(name), c) ? `${c.from}#${name}` : null;
    const r = R.resolveName(name, c);
    return r?.var && isExpress(r.var, r.var) ? `${r.in}#${r.name}` : null;
  };
  const argRouter = (a, c) => {
    if (a.name) return routerOf(a.name, c);
    const req = /^require\(\s*["'`]([^"'`]+)["'`]\s*\)$/.exec(a.text);
    if (req) { const mod = R.resolveModule(req[1], c.module); const r = mod && R.exportOf(mod, '*'); return r?.var && isExpress(r.var, r.var) ? `${r.in}#${r.name}` : null; }
    return null;
  };
  const handlerOf = (a, c) => {
    if (a.fnId) return a.fnId;
    if (a.name || a.member) { const r = R.resolveExpr(a.name || a.member, c); const s = r?.id && ts.symbols.get(r.id); return s && (s.kind === 'function' || s.kind === 'method') ? r.id : null; }
    return null;
  };
  const pathOf = (a, c) => a?.ir ? foldString(ts, R, a.ir, c).s : null;
  const mounts = new Map(), regs = [], claimed = new Set();
  ts.rawCalls.forEach((c, i) => {
    if (!c.attr) return;
    const chained = c.routeChain || null;
    const owner = chained ? routerOf(chained.owner, c) : c.obj ? routerOf(c.obj, c) : null;
    if (!owner) return;
    if (c.attr === 'use') {
      const prefix = c.args[0] && (c.args[0].type === 'string' || c.args[0].type === 'template_string') ? pathOf(c.args[0], c) : '';
      for (const a of c.args) { const child = argRouter(a, c); if (child && child !== owner && !mounts.has(child)) mounts.set(child, { parent: owner, prefix: prefix || '' }); }
      claimed.add(i);
      return;
    }
    if (!METHOD.test(c.attr)) return;
    const path = chained ? (chained.path ? foldString(ts, R, chained.path, c).s : null) : pathOf(c.args[0], c);
    if (path == null || !path.startsWith('/') && path !== '*') return;
    const handlers = (chained ? c.args : c.args.slice(1)).map(a => handlerOf(a, c)).filter(Boolean);
    claimed.add(i);
    if (!handlers.length) return;
    regs.push({ owner, method: c.attr === 'all' ? '*' : c.attr === 'del' ? 'DELETE' : c.attr.toUpperCase(), path, handler: handlers.at(-1), middleware: handlers.slice(0, -1), file: c.file, line: c.line });
  });
  const fullPath = (owner, path, seen = new Set()) => {
    let p = path;
    for (let o = owner; mounts.has(o) && !seen.has(o); o = mounts.get(o).parent) { seen.add(o); p = `${mounts.get(o).prefix.replace(/\/$/, '')}${p.startsWith('/') ? '' : '/'}${p}`; }
    p = p.replace(/\/{2,}/g, '/').replace(/:(\w+)\??/g, '{$1}');
    return p.length > 1 ? p.replace(/\/$/, '') : p;
  };
  const routes = [];
  for (const g of regs) {
    const path = fullPath(g.owner, g.path);
    routes.push({ kind: 'http', method: g.method, path, id: g.handler, file: g.file, line: g.line, rule: 'express' });
    for (const mw of g.middleware) addTsEdge(ts, g.handler, mw, 'framework', g.line, { rule: 'express.middleware', evidence: `${g.file}:${g.line} ${g.method} ${path} runs ${ts.symbols.get(mw)?.name} first` });
  }
  return { routes, claimed, mounts: [...mounts].map(([child, m]) => ({ child, parent: m.parent, prefix: m.prefix })) };
}
