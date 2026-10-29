/* Rule pack: Python HTTP clients (httpx / requests / aiohttp / a test client). `<client>.get/post/…(url)` where url
   is a string or f-string literal, or a local bound to one: a leading `{base}` and any scheme://host are dropped,
   then the path is matched against the mined route table. A match is an `http` crossing to the route handler. */
import { addEdge } from '../lang/python.mjs';

export const routeRe = e => new RegExp('^' + e.path.replace(/\{[^}]+\}/g, '[^/]+') + '$');

export function linkHttpCalls(py, entries) {
  const routes = entries.filter(e => e.kind === 'http').map(e => ({ e, re: routeRe(e) }));
  const calls = [];
  for (const c of py.rawCalls) {
    const a0 = c.args[0];
    if (!c.attr || !/^(get|post|put|patch|delete)$/.test(c.attr) || !a0) continue;
    const lit = a0.type === 'string' ? a0.text : a0.type === 'identifier' ? py.fnAlias.get(c.from)?.[a0.text] : null;
    if (!lit || !/^[rbfRBF]*["']/.test(lit)) continue;
    const url = lit.replace(/^[rbfRBF]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '').replace(/\{[^}]*\}/g, '{}').replace(/^\{\}/, '').replace(/^https?:\/\/[^/]+/, '');
    if (!url.startsWith('/')) continue;
    const path = url.replace(/\?.*$/, '').replace(/\{\}/g, 'X');
    const method = c.attr.toUpperCase();
    const hit = routes.find(r => r.e.method === method && r.re.test(path))?.e;
    const group = py.modules.get(c.module)?.group;
    calls.push({ from: c.from, file: c.file, line: c.line, method, url, handler: hit?.id || null, group });
    if (hit) addEdge(py, c.from, hit.id, 'http', c.line, { rule: 'py.http-client', group, evidence: `${c.file}:${c.line} ${method} ${url}` });
  }
  return calls;
}
