/* Rule pack: Next.js, read from the file layout of an app that depends on `next` (a package.json naming it, or a
   next.config file beside one). App Router: a `page.*` file under `app/` is a `ui-route` at its default export,
   and a `route.*` file an `http` entry per exported GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS. Pages Router:
   a file under `pages/api/` is an `http` entry (any method) at its default export, every other page a `ui-route`. Route groups
   `(x)` and slots `@x` add no segment, `_x` folders are private; `[id]` is `:id` in a UI path and `{id}` in an
   HTTP one; `[...x]` and `[[...x]]` catch the rest. `src/app` and `src/pages` count as well. */
import { posix } from 'node:path';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const SPECIAL_PAGE = /^_(app|document|error)$/;

export function nextRoots(packageJsons, files) {
  const roots = new Set();
  for (const { dir, json } of packageJsons) if (json && ['dependencies', 'devDependencies', 'peerDependencies'].some(k => json[k]?.next)) roots.add(dir);
  for (const f of files) if (/(^|\/)next\.config\.(js|mjs|cjs|ts|mts)$/.test(f)) roots.add(posix.dirname(f) === '.' ? '' : posix.dirname(f));
  return [...roots].sort();
}

export function nextEntries(ts, R, roots) {
  const entries = [];
  const segs = (parts, http) => {
    const out = [];
    for (const s of parts) {
      if (/^\(.*\)$/.test(s) || s.startsWith('@')) continue;
      const m = /^\[\[?\.\.\.(\w+)\]\]?$/.exec(s) || /^\[(\w+)\]$/.exec(s);
      out.push(m ? (s.includes('...') ? (http ? `{${m[1]}}` : '*') : http ? `{${m[1]}}` : `:${m[1]}`) : s);
    }
    return '/' + out.join('/');
  };
  for (const root of roots) {
    const at = d => root ? `${root}/${d}` : d;
    for (const [rel] of ts.modules) {
      for (const base of [at('app'), at('src/app')]) {
        if (!rel.startsWith(base + '/')) continue;
        const parts = rel.slice(base.length + 1).split('/'), file = parts.pop(), name = file.replace(/\.[^.]+$/, '');
        if (parts.some(p => p.startsWith('_'))) continue;
        if (name === 'page') { const r = R.exportOf(rel, 'default'); if (r?.id) entries.push({ kind: 'ui-route', path: segs(parts, false), id: r.id, file: rel, line: ts.symbols.get(r.id)?.start, rule: 'nextjs.app' }); }
        if (name === 'route') for (const m of HTTP_METHODS) { const r = R.exportOf(rel, m); if (r?.id) entries.push({ kind: 'http', method: m, path: segs(parts, true), id: r.id, file: rel, line: ts.symbols.get(r.id)?.start, rule: 'nextjs.route' }); }
      }
      for (const base of [at('pages'), at('src/pages')]) {
        if (!rel.startsWith(base + '/')) continue;
        const parts = rel.slice(base.length + 1).split('/'), file = parts.pop(), name = file.replace(/\.[^.]+$/, '');
        if (SPECIAL_PAGE.test(name) || parts.some(p => p.startsWith('_'))) continue;
        const all = name === 'index' ? parts : [...parts, name];
        const r = R.exportOf(rel, 'default');
        if (!r?.id) continue;
        if (all[0] === 'api') entries.push({ kind: 'http', method: '*', path: segs(all, true), id: r.id, file: rel, line: ts.symbols.get(r.id)?.start, rule: 'nextjs.api' });
        else entries.push({ kind: 'ui-route', path: segs(all, false), id: r.id, file: rel, line: ts.symbols.get(r.id)?.start, rule: 'nextjs.pages' });
      }
    }
  }
  return entries;
}
