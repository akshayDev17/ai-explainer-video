/* Rule pack: React Router, both styles. Route objects in an array (`createBrowserRouter([...])`, `useRoutes`, or any
   route table in a file that imports react-router) with `path` or `index` and an `element`, `Component`,
   `component` or `lazy: () => import(…)`; and `<Route path element={<X/>}>` elements, nested `<Route>`s and
   `children` arrays joining their parents' paths. Each one is a `ui-route` entry at the component it renders (a
   `lazy(() => import('./X'))` component is that module's default export). */
export function uiRoutes(ts, R) {
  const entries = [];
  for (const d of ts.routeDefs) {
    let r = null;
    if (d.lazy) { const mod = R.resolveModule(d.lazy, d.file); r = mod ? R.exportOf(mod, 'default') : null; }
    else r = R.resolveExpr(d.comp, { module: d.file, locals: null });
    const s = r?.id && ts.symbols.get(r.id);
    if (!s || s.kind === 'main') continue;
    entries.push({ kind: 'ui-route', path: d.path, id: r.id, file: d.file, line: d.line, rule: d.rule, ...(d.lazy ? { lazy: d.lazy } : {}) });
  }
  return entries;
}
