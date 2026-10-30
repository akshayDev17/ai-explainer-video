/* Rule pack: frontend and Node HTTP clients. `fetch(url, { method })` (the global, not an in-repo function of that
   name), `axios.get/post/…(url)`, `axios(config)` / `axios.request(config)`, `ky.get/…(url)` and `ky(url, { method })`,
   and instances made by `axios.create({ baseURL })` or `ky.create/extend({ prefixUrl })`, whose base is prefixed.
   The URL is folded to a string (B15): string and template literals, `+`, and identifiers or object members that
   name a const, here or imported; `process.env.X ?? '/api'` folds to its default; what cannot be known is `{}`.
   Any scheme://host is dropped. The path is matched against every route the repo serves, in any language
   (FastAPI, Express, Next.js): a placeholder matches a route parameter, and the route with the most literal
   segments wins. A method that cannot be folded links only when every method the path serves leads to one handler;
   otherwise the call stays unlinked, with why (`unlinked`). A URL whose leading base could not be folded is matched by its tail instead, only when one route
   has that tail more literally than every other (`match: "suffix"`). A match is an `http` crossing from the caller to the route handler. */
import { addTsEdge, foldString, constOf } from '../lang/typescript.mjs';

const VERB = /^(get|post|put|patch|delete|head|options)$/;
const segsOf = p => p.replace(/\?.*$/, '').split('/').filter(Boolean);
const isParam = s => /^\{[^}]+\}$/.test(s);

// does a route (its segments) answer a call path (its segments, `{}` where unknown)?
const fits = (rs, cs) => rs.length === cs.length && rs.every((r, i) => isParam(r) ? cs[i] !== '' : r === cs[i]);
const literal = rs => rs.filter(s => !isParam(s)).length;

// the route `best` picks among those serving the method (`best` gives [] for none, [route], or the routes that tie);
// when the method is unknown, the one handler every method the routes serve would pick, with no tie for any of them,
// else { ambiguous: the routes it could be }
function byMethod(routes, method, best) {
  const serving = m => routes.filter(r => r.method === '*' || r.method === m);
  if (method) { const c = best(serving(method)); return { route: c.length === 1 ? c[0] : null }; }
  const picks = [...new Set(routes.map(r => r.method))].map(m => best(serving(m))), all = picks.flat();
  if (picks.every(c => c.length <= 1) && new Set(all.map(r => r.id)).size <= 1) return { route: all[0] || null };
  return { route: null, ambiguous: [...new Set(all.map(r => `${r.method} ${r.path}`))].sort() };
}

export function matchRoute(routes, method, path, { suffix = false } = {}) {
  const cs = segsOf(path);
  const result = (r, match) => r.route ? { route: r.route, match } : r.ambiguous ? { route: null, ambiguous: r.ambiguous } : null;
  const exact = byMethod(routes, method, rs => rs.filter(r => fits(r.segs, cs)).sort((a, b) => literal(b.segs) - literal(a.segs)).slice(0, 1));
  if (exact.route || exact.ambiguous || !suffix || !cs.some(s => s !== '{}')) return result(exact, 'exact');
  // the tail match must be unambiguous: one route, or one with more literal segments in its tail than any other
  const tailLit = r => literal(r.segs.slice(r.segs.length - cs.length));
  const tailOf = rs => { const tail = rs.filter(r => r.segs.length > cs.length && fits(r.segs.slice(r.segs.length - cs.length), cs)).sort((a, b) => tailLit(b) - tailLit(a));
    return tail.filter(r => tailLit(r) === tailLit(tail[0])); };
  return result(byMethod(routes, method, tailOf), 'suffix');
}

export function routeTable(httpRoutes) {
  return httpRoutes.map(e => ({ ...e, segs: segsOf(e.path.replace(/\{\*?(\w+)\.{0,3}\}/g, '{$1}')) }));
}

export function linkHttpCalls(ts, R, httpRoutes) {
  const routes = routeTable(httpRoutes);
  const calls = [];
  const extOf = (name, sc) => /^[\w$]+$/.test(name) ? R.resolveName(name, sc)?.ext || null : null;
  // an axios / ky instance: a variable made by axios.create({ baseURL }) or ky.create/extend({ prefixUrl })
  const instanceOf = (name, c) => {
    const spec = c.types?.get(name) || (() => { const r = R.resolveName(name, c); return r?.var ? r.var : null; })();
    if (!spec || spec.t !== 'call') return null;
    const m = /^([\w$]+)\.(create|extend)$/.exec(spec.expr);
    const ext = m && extOf(m[1], spec.module ? spec : c);
    if (!ext || !/^(axios|ky)$/.test(ext)) return null;
    const cfg = spec.a0?.k === 'obj' ? spec.a0.pairs : {};
    const baseIr = cfg.baseURL || cfg.prefixUrl || cfg.prefixURL;
    const base = baseIr ? foldString(ts, R, baseIr, { module: spec.module || c.module, consts: spec.module === c.module ? c.consts : null }) : null;
    return { client: ext, base };
  };
  // the method an options / config argument sets: GET when there is none or it sets none, null (any) when it cannot be known
  const methodOf = (arg, sc) => {
    if (!arg) return 'GET';
    let o = arg, osc = sc;
    if (arg.k === 'id') { const local = sc.consts?.get(arg.name), found = local ? null : constOf(ts, R, arg.name, sc.module);
      o = local || found?.ir; if (found) osc = { module: found.module, consts: null }; }
    if (o?.k !== 'obj') return null;
    if (!o.pairs.method) return o.pairs['...'] ? null : 'GET';
    const m = foldString(ts, R, o.pairs.method, osc).s;
    return /^[a-z]+$/i.test(m) ? m.toUpperCase() : null;
  };
  for (const c of ts.rawCalls) {
    if (c.jsx || c.isNew) continue;
    let client = null, method = null, urlIr = null, base = null;
    const a0 = c.args[0]?.ir, a1 = c.args[1]?.ir;
    if (!c.attr && /^(fetch|window\.fetch|globalThis\.fetch)$/.test(c.expr) && !R.resolveName('fetch', c)?.id) { client = 'fetch'; urlIr = a0; method = methodOf(a1, c); }
    else if (!c.attr && /^(axios|ky)$/.test(extOf(c.expr, c) || '')) {
      client = extOf(c.expr, c);
      if (a0?.k === 'obj') { urlIr = a0.pairs.url; method = methodOf(a0, c); } else { urlIr = a0; method = methodOf(a1, c); }
    } else if (c.attr && c.obj && /^[\w$]+$/.test(c.obj)) {
      const ext = extOf(c.obj, c), inst = ext ? null : instanceOf(c.obj, c);
      const lib = /^(axios|ky)$/.test(ext || '') ? ext : inst?.client;
      if (!lib) continue;
      if (VERB.test(c.attr)) { client = lib; method = c.attr.toUpperCase(); urlIr = a0; }
      else if (c.attr === 'request' && a0?.k === 'obj') { client = lib; method = methodOf(a0, c); urlIr = a0.pairs.url; }
      else continue;
      base = inst?.base || null;
    } else continue;
    if (!urlIr) continue;
    const f = foldString(ts, R, urlIr, c);
    let url = f.s.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '');
    let baseStr = base ? base.s.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '') : '';
    if (/^[a-z][\w+.-]*:\/\//i.test(f.s)) baseStr = '';   // an absolute URL ignores the instance's base
    const unknownLead = url.startsWith('{}') || (!!base && baseStr.startsWith('{}'));
    url = `${baseStr.replace(/^\{\}/, '').replace(/\/$/, '')}${baseStr && !url.startsWith('/') && !url.startsWith('{}') ? '/' : ''}${url.replace(/^\{\}/, '')}`;
    if (!url.startsWith('/')) { if (!unknownLead) continue; url = '/' + url; }
    const path = url.replace(/\?.*$/, '').replace(/#.*$/, '');
    const m = matchRoute(routes, method, path, { suffix: unknownLead }), hit = m?.route ? m : null;
    const folded = [...new Set([...f.acc.folded, ...(base?.acc.folded || [])])], env = [...new Set([...f.acc.env, ...(base?.acc.env || [])])];
    const group = ts.modules.get(c.module)?.group;
    calls.push({ from: c.from, file: c.file, line: c.line, client, method, url: path, handler: hit?.route.id || null, group,
      ...(m?.ambiguous ? { unlinked: `the method is unknown and the path is served by ${m.ambiguous.join(', ')}` } : {}),
      ...(hit && hit.match !== 'exact' ? { match: hit.match } : {}), ...(folded.length ? { folded } : {}), ...(env.length ? { env } : {}) });
    if (hit) addTsEdge(ts, c.from, hit.route.id, 'http', c.line, { rule: 'js.http-client', group, evidence: `${c.file}:${c.line} ${method || '*'} ${path}${folded.length ? ` (folded ${folded.join(', ')})` : ''}${hit.match === 'suffix' ? ` (tail match: ${hit.route.method} ${hit.route.path})` : ''}`,
      ...(hit.match !== 'exact' ? { match: hit.match } : {}) });
  }
  return calls;
}
