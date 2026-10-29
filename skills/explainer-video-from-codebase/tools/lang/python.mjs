/* The Python adapter: facts per file, then name / member / constructor resolution into typed
   edges. Rule packs (../rules/) read the same facts and add framework links on top.

   Resolution rules (design rev3 §3.4): local defs, function-local imports, module imports with
   aliases and relative imports, re-exports through __init__; `self.m()` through the MRO plus a
   `virtual` edge per subclass override; receivers typed by a local constructor, an annotated
   parameter, a class attribute or a factory's returns (with branch guards); `super().m()`; a
   generic base `Base[T]` unwrapped. Build fixes over the spike: `self.x = self._make()` types the
   attribute by the method's returns (B19), a callable or coroutine passed as an argument is linked
   from the callee that runs it (B17), and a call inside an `except` is labelled "on failure". */
import { dirname } from 'node:path';
import { STDLIB } from './python-stdlib.mjs';
import { normaliseDep } from './python-deps.mjs';

export function newPythonModel() {
  return {
    symbols: new Map(), classes: new Map(), modules: new Map(),
    rawCalls: [], decorated: [], dictPairs: [], returns: [], mains: [], annotParams: [], paramDefaults: [], moduleAssigns: [],
    fnAssigns: new Map(), fnAlias: new Map(), fnLists: new Map(), settingsFields: [], settingsProps: [], externalImports: new Map(),
    uses: new Map(),          // fn -> { called, awaited, passed }: name -> first line (how a callee runs what it was handed)
    typeAliases: new Map(),   // alias symbol -> { type, provider, module, imports }: filled by rule packs before resolveCalls
    edges: [], dispatchSites: [], callStats: { resolved: 0, unresolvedName: 0, unresolvedAttr: 0 },
    unresolved: { inRepo: 0, external: 0, builtin: 0, local: 0 }, externalCalls: new Map(),
    importNotes: { cross: new Map(), ambiguous: new Map() },   // calls whose head import crossed package roots / lost to two claims
    defNodes: 0, defsVisited: 0, defScopes: 0,
  };
}

const str = n => n && n.type === 'string'
  ? n.namedChildren.filter(c => c.type === 'string_content').map(c => c.text).join('') : null;
export const modOf = rel => rel.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').join('.');
const simpleType = t => {   // `X | None`, `Optional[X]`, `"X"` -> X
  const s = t.replace(/^["']|["']$/g, '').replace(/\s*\|\s*None\b|\bNone\s*\|\s*/g, '').replace(/^Optional\[(.*)\]$/, '$1').trim();
  return /^[A-Za-z_][\w.]*$/.test(s) ? s : null;
};
const exits = blk => { const last = blk && blk.namedChildren[blk.namedChildren.length - 1]; return !!last && /return_statement|raise_statement/.test(last.type); };
// an argument, kept as plain data so rule packs never hold tree nodes
const argOf = a => {
  const v = a.type === 'keyword_argument' ? a.childForFieldName('value') : a;
  return { type: a.type, kw: a.type === 'keyword_argument' ? a.childForFieldName('name').text : null, text: a.text,
    vtype: v?.type, vtext: v?.text, s: str(v), fn: v?.type === 'call' ? v.childForFieldName('function').text : null,
    items: v?.type === 'list' || v?.type === 'tuple' ? v.namedChildren.map(x => ({ type: x.type, text: x.text, s: str(x) })) : null };
};
const exceptLabel = n => { const v = n.childForFieldName('value'); const t = v?.type === 'as_pattern' ? v.namedChildren[0] : v;
  return 'except' + (t ? ' ' + t.text.replace(/\s+/g, ' ') : ''); };

export function extractPythonFile(py, rel, root, group, text) {
  const module = modOf(rel);
  const isPkg = rel.endsWith('__init__.py');
  const pkg = isPkg ? module : module.split('.').slice(0, -1).join('.');
  const M = { file: rel, group, imports: new Map(), defs: new Map() };
  py.modules.set(module, M);
  const lines = text.split('\n');
  const spanText = (a, b) => lines.slice(a - 1, b).join('\n');
  const defNodes = root.descendantsOfType(['function_definition', 'class_definition']);
  py.defNodes += defNodes.length;
  const qualname = n => { let q = n.childForFieldName('name').text;
    for (let p = n.parent; p; p = p.parent) if (p.type === 'class_definition') q = `${p.childForFieldName('name').text}.${q}`;
      else if (p.type === 'function_definition') q = `${p.childForFieldName('name').text}.<locals>.${q}`;
    return q; };
  py.defScopes += new Set(defNodes.map(qualname)).size;
  const absImport = (relNode) => {
    const dots = (relNode.text.match(/^\.+/) || [''])[0].length;
    const rest = relNode.text.slice(dots);
    const base = pkg.split('.').slice(0, Math.max(0, pkg.split('.').length - (dots - 1)));
    return [...base, ...(rest ? [rest] : [])].filter(Boolean).join('.');
  };
  const noteExternal = (name, rel_) => { const top = name.split('.')[0]; if (!py.externalImports.has(top)) py.externalImports.set(top, rel_); };
  function addImports(node, table) {
    if (node.type === 'import_statement') {
      for (const c of node.namedChildren) {
        if (c.type === 'dotted_name') { table.set(c.text.split('.')[0], { module: c.text.split('.')[0], in: module }); noteExternal(c.text, rel); }
        if (c.type === 'aliased_import') { table.set(c.childForFieldName('alias').text, { module: c.childForFieldName('name').text, in: module }); noteExternal(c.childForFieldName('name').text, rel); }
      }
    } else if (node.type === 'import_from_statement') {
      const mn = node.childForFieldName('module_name');
      const from = mn.type === 'relative_import' ? absImport(mn) : mn.text;
      if (mn.type !== 'relative_import') noteExternal(from, rel);
      for (const c of node.childrenForFieldName('name')) {
        if (c.type === 'dotted_name') table.set(c.text, { from, name: c.text, in: module });
        if (c.type === 'aliased_import') table.set(c.childForFieldName('alias').text, { from, name: c.childForFieldName('name').text, in: module });
      }
    }
  }
  const scope = ctx => ({ module, imports: ctx.imports, locals: ctx.locals, cls: ctx.cls });
  // a definition's id names its scope: `m:f`, `m:Class.f`, `m:Outer.Inner`, `m:f.<locals>.g`
  const scopedId = (ctx, name) => ctx.inClass ? `${ctx.cls}.${name}` : ctx.fn ? `${ctx.fn}.<locals>.${name}` : `${module}:${name}`;
  const use = (fn, how, name, node) => { const u = py.uses.get(fn) || py.uses.set(fn, { called: new Map(), awaited: new Map(), passed: new Map() }).get(fn);
    if (!u[how].has(name)) u[how].set(name, node.startPosition.row + 1); };
  // `name = <call>` (also inside conditionals and `x or Default()`) for factory-return and receiver analysis
  function recordAssign(ctx, name, right, line) {
    const calls = [];
    const grab = n => { if (!n) return; if (n.type === 'call') calls.push(n.childForFieldName('function').text);
      else if (n.type === 'parenthesized_expression' || n.type === 'conditional_expression' || n.type === 'boolean_operator') n.namedChildren.forEach(grab);
      else if (n.type === 'identifier' && ctx.ptypes && ctx.ptypes.has(n.text)) calls.push({ annot: ctx.ptypes.get(n.text) }); };
    grab(right);
    if (!calls.length) return null;
    const list = py.fnAssigns.get(ctx.fn) || py.fnAssigns.set(ctx.fn, new Map()).get(ctx.fn);
    for (const c of calls) (list.get(name) || list.set(name, []).get(name)).push({ expr: c, guards: ctx.guards, line, ...scope(ctx) });
    return calls;
  }
  function visitBlock(node, ctx) {   // sequential statements: an `if` whose body always exits guards what follows
    let guards = ctx.guards;
    for (const c of node.namedChildren) {
      visit(c, { ...ctx, guards });
      if (c.type === 'if_statement' && exits(c.childForFieldName('consequence')) && !c.childrenForFieldName('alternative').length)
        guards = [...guards, { text: c.childForFieldName('condition').text, neg: true }];
    }
  }
  function visit(node, ctx) {
    switch (node.type) {
      case 'block': visitBlock(node, ctx); return;
      case 'import_statement': case 'import_from_statement':
        addImports(node, ctx.imports); return;
      case 'except_clause': case 'except_group_clause':
        for (const c of node.namedChildren) visit(c, { ...ctx, onFailure: exceptLabel(node) });
        return;
      case 'decorated_definition': {
        const def = node.childForFieldName('definition');
        const decos = node.namedChildren.filter(c => c.type === 'decorator');
        const id = visit(def, { ...ctx, decos: decos.map(d => d.namedChildren[0].text) });
        for (const d of decos) {
          const e = d.namedChildren[0];
          const call = e.type === 'call' ? e : null;
          const expr = (call ? call.childForFieldName('function') : e).text;
          const args = call ? call.childForFieldName('arguments').namedChildren : [];
          py.decorated.push({ id, expr, line: d.startPosition.row + 1, text: e.text, module, fn: ctx.fn, imports: ctx.imports, locals: ctx.locals, types: ctx.types,
            strArgs: args.map(str).filter(s => s != null),
            kwNames: args.filter(a => a.type === 'keyword_argument').map(a => a.childForFieldName('name').text),
            kwArgs: Object.fromEntries(args.filter(a => a.type === 'keyword_argument')
              .map(a => [a.childForFieldName('name').text, str(a.childForFieldName('value'))])) });
        }
        return id;
      }
      case 'class_definition': {
        py.defsVisited++;
        const name = node.childForFieldName('name').text;
        const id = scopedId(ctx, name);
        const sup = node.childForFieldName('superclasses');
        const baseOf = c => c.type === 'subscript' ? c.childForFieldName('value') : c;   // Base[T]
        const baseExprs = sup ? sup.namedChildren.map(baseOf).filter(c => c.type === 'identifier' || c.type === 'attribute').map(c => c.text) : [];
        const start = node.startPosition.row + 1, end = node.endPosition.row + 1;
        py.classes.set(id, { id, module, name, baseExprs, methods: new Map(), imports: ctx.imports, attrTypes: new Map(),
          decos: ctx.decos || [], file: rel, line: start });
        py.symbols.set(id, { id, group, kind: 'class', file: rel, start, end, name, module, text: spanText(start, end) });
        if (!ctx.inClass) (ctx.fn ? ctx.locals : M.defs).set(name, id);
        const isSettings = baseExprs.some(b => /BaseSettings$/.test(b));
        for (const c of node.childForFieldName('body').namedChildren) {
          if (isSettings && c.type === 'expression_statement' && c.namedChildren[0]?.type === 'assignment') {
            const a = c.namedChildren[0], l = a.childForFieldName('left'), r = a.childForFieldName('right');
            if (l?.type === 'identifier' && a.childForFieldName('type')) {
              let def = r, alias = null;
              if (r?.type === 'call' && /(^|\.)Field$/.test(r.childForFieldName('function').text)) {
                const as = r.childForFieldName('arguments').namedChildren;
                const kw = n => as.find(x => x.type === 'keyword_argument' && x.childForFieldName('name').text === n)?.childForFieldName('value');
                def = kw('default') || as.find(x => x.type !== 'keyword_argument') || null;
                alias = str(kw('alias')) || str(kw('validation_alias'));
              }
              py.settingsFields.push({ cls: id, name: l.text, alias, file: rel, line: a.startPosition.row + 1, group,
                default: def ? (def.type === 'string' ? str(def) : def.text) : undefined, defaultIsString: def?.type === 'string' });
            }
          }
          if (isSettings && c.type === 'decorated_definition' && c.namedChildren.some(d => d.type === 'decorator' && d.text === '@property')) {
            const fn = c.childForFieldName('definition');
            const ret = fn.childForFieldName('body').namedChildren.find(s => s.type === 'return_statement');
            if (ret) py.settingsProps.push({ cls: id, name: fn.childForFieldName('name').text, expr: ret.namedChildren[0]?.text, file: rel, line: fn.startPosition.row + 1 });
          }
          visit(c, { ...ctx, cls: id, inClass: true, decos: null });
        }
        return id;
      }
      case 'function_definition': {
        py.defsVisited++;
        const name = node.childForFieldName('name').text;
        const id = scopedId(ctx, name);
        const start = node.startPosition.row + 1, end = node.endPosition.row + 1;
        const params = node.childForFieldName('parameters').namedChildren.map(p => (p.type === 'identifier' ? p : p.type === 'typed_parameter' ? p.namedChildren[0] : p.childForFieldName('name'))?.text).filter(Boolean);
        const sym = { id, group, kind: ctx.inClass ? 'method' : 'function', file: rel, start, end, name, module,
          cls: ctx.inClass ? ctx.cls : null, decos: ctx.decos || [], params, text: spanText(start, end),
          ...(node.children.some(c => c.type === 'async') ? { async: true } : {}) };
        py.symbols.set(id, sym);
        if (ctx.inClass) py.classes.get(ctx.cls).methods.set(name, id);
        else if (ctx.fn) ctx.locals.set(name, id);
        else M.defs.set(name, id);
        if (group === 'test') {   // assertion lines: what a test promises (the pytest pack decides which functions are tests)
          const body = node.childForFieldName('body');
          const asserts = [...body.descendantsOfType('assert_statement'), ...body.descendantsOfType('call').filter(c => /(^|\.)(assert\w*|raises)$/.test(c.childForFieldName('function').text))];
          sym.asserts = asserts.length;
          sym.assertLines = [...new Set(asserts.map(a => a.startPosition.row + 1))].sort((a, b) => a - b);
        }
        const isFixture = (ctx.decos || []).some(d => /(^|\.)fixture(\(|$)/.test(d));
        const inner = { ...ctx, fn: id, imports: new Map(ctx.imports), locals: new Map(ctx.locals || []), types: new Map(), ptypes: new Map(),
          cls: ctx.cls, inClass: false, guards: [], decos: null, fixture: isFixture, onFailure: null };
        for (const p of node.childForFieldName('parameters').namedChildren) {
          const pname = p.type === 'typed_parameter' ? p.namedChildren[0] : p.childForFieldName('name');
          const ptype = p.childForFieldName('type');
          const pval = p.childForFieldName('value');
          if (pname && ptype) { const t = simpleType(ptype.text); if (t) { inner.types.set(pname.text, { t: 'annot', expr: t }); inner.ptypes.set(pname.text, t);
            py.annotParams.push({ fn: id, param: pname.text, annot: t, line: p.startPosition.row + 1, ...scope(inner) }); } }
          if (pname && pval && pval.type === 'call') {
            const a0 = pval.childForFieldName('arguments').namedChildren[0];
            py.paramDefaults.push({ fn: id, param: pname.text, call: pval.childForFieldName('function').text, a0: a0?.text ?? null,
              type: ptype ? simpleType(ptype.text) : null, line: p.startPosition.row + 1, ...scope(inner) });
          }
        }
        visit(node.childForFieldName('body'), inner);
        return id;
      }
      case 'assignment': {
        const l = node.childForFieldName('left'), r = node.childForFieldName('right');
        if (ctx.fn && l && r && l.type === 'identifier') {
          (py.fnAlias.get(ctx.fn) || py.fnAlias.set(ctx.fn, {}).get(ctx.fn))[l.text] = r.text;
          if (r.type === 'call') ctx.types.set(l.text, { t: 'call', expr: r.childForFieldName('function').text });
          if (r.type === 'list' || r.type === 'tuple') (py.fnLists.get(ctx.fn) || py.fnLists.set(ctx.fn, {}).get(ctx.fn))[l.text] = r.namedChildren.map(x => ({ type: x.type, text: x.text, s: str(x) }));
          recordAssign(ctx, l.text, r, node.startPosition.row + 1);
        }
        // class attributes: self.x = Klass(...) / factory() / self._make() / annotated param / x or Default()
        if (ctx.fn && ctx.cls && l && r && l.type === 'attribute' && l.childForFieldName('object').text === 'self') {
          const calls = recordAssign(ctx, 'self.' + l.childForFieldName('attribute').text, r, node.startPosition.row + 1);
          if (calls) { const k = py.classes.get(ctx.cls); const nm = l.childForFieldName('attribute').text;
            (k.attrTypes.get(nm) || k.attrTypes.set(nm, []).get(nm)).push(...calls.map(c => ({ expr: c, guards: ctx.guards, ...scope(ctx) }))); }
        }
        if (!ctx.fn && !ctx.cls && l?.type === 'identifier' && r)
          py.moduleAssigns.push({ module, file: rel, name: l.text, rtype: r.type, rtext: r.text, line: node.startPosition.row + 1,
            fn: r.type === 'call' ? r.childForFieldName('function').text : null,
            sub: r.type === 'subscript' ? { value: r.childForFieldName('value').text, items: r.namedChildren.slice(1).map(argOf) } : null,
            args: r.type === 'call' ? r.childForFieldName('arguments').namedChildren.map(argOf) : null, imports: ctx.imports });
        break;
      }
      case 'return_statement': {
        const v = node.namedChildren[0];
        if (ctx.fn && v) {
          if (v.type === 'call') py.returns.push({ fn: ctx.fn, kind: 'call', expr: v.childForFieldName('function').text, guards: ctx.guards, line: node.startPosition.row + 1, ...scope(ctx) });
          else if (v.type === 'identifier') py.returns.push({ fn: ctx.fn, kind: 'name', name: v.text, guards: ctx.guards, line: node.startPosition.row + 1, ...scope(ctx) });
          else if (v.type === 'attribute' && v.childForFieldName('object').text === 'self') py.returns.push({ fn: ctx.fn, kind: 'name', name: v.text, guards: ctx.guards, line: node.startPosition.row + 1, ...scope(ctx) });
        }
        break;
      }
      case 'yield': {   // a fixture's `yield X(...)` is its return value
        const v = node.namedChildren[0];
        if (ctx.fn && ctx.fixture && v) {
          if (v.type === 'call') py.returns.push({ fn: ctx.fn, kind: 'call', expr: v.childForFieldName('function').text, guards: ctx.guards, line: node.startPosition.row + 1, ...scope(ctx) });
          else if (v.type === 'identifier') py.returns.push({ fn: ctx.fn, kind: 'name', name: v.text, guards: ctx.guards, line: node.startPosition.row + 1, ...scope(ctx) });
        }
        break;
      }
      case 'dictionary':
        for (const p of node.namedChildren.filter(c => c.type === 'pair')) {
          const k = str(p.childForFieldName('key')), v = str(p.childForFieldName('value'));
          if (k != null && v != null) py.dictPairs.push({ key: k, value: v, file: rel, line: p.startPosition.row + 1 });
        }
        break;
      case 'if_statement': {
        const cond = node.childForFieldName('condition');
        if (!ctx.fn && /__name__\s*==\s*['"]__main__['"]/.test(cond.text)) {
          const id = `${module}:<main>`;
          const start = node.startPosition.row + 1, end = node.endPosition.row + 1;
          py.symbols.set(id, { id, group, kind: 'main', file: rel, start, end, name: '<main>', module, text: spanText(start, end) });
          py.mains.push(id);
          visit(node.childForFieldName('consequence'), { ...ctx, fn: id, inClass: false, imports: new Map(ctx.imports), locals: new Map(), types: new Map(), ptypes: new Map(), guards: [] });
          return;
        }
        visit(cond, ctx);
        const g0 = ctx.guards || [];
        visit(node.childForFieldName('consequence'), { ...ctx, guards: [...g0, { text: cond.text, neg: false }] });
        let prior = [{ text: cond.text, neg: true }];
        for (const alt of node.childrenForFieldName('alternative')) {
          if (alt.type === 'elif_clause') {
            const c2 = alt.childForFieldName('condition');
            visit(c2, ctx);
            visit(alt.childForFieldName('consequence'), { ...ctx, guards: [...g0, ...prior, { text: c2.text, neg: false }] });
            prior = [...prior, { text: c2.text, neg: true }];
          } else visit(alt.childForFieldName('body'), { ...ctx, guards: [...g0, ...prior] });
        }
        return;
      }
      case 'await': {
        const v = node.namedChildren[0];
        if (ctx.fn && v?.type === 'identifier') use(ctx.fn, 'awaited', v.text, node);
        break;
      }
      case 'call': {
        const fnNode = node.childForFieldName('function');
        const args = node.childForFieldName('arguments');
        if (ctx.fn && fnNode.type === 'identifier') use(ctx.fn, 'called', fnNode.text, node);
        if (ctx.fn && args) for (const a of args.namedChildren) { const v = a.type === 'keyword_argument' ? a.childForFieldName('value') : a; if (v?.type === 'identifier') use(ctx.fn, 'passed', v.text, node); }
        py.rawCalls.push({ from: ctx.fn || `${module}:<module>`, module, file: rel, expr: fnNode.text, line: node.startPosition.row + 1,
          obj: fnNode.type === 'attribute' ? fnNode.childForFieldName('object').text : null,
          attr: fnNode.type === 'attribute' ? fnNode.childForFieldName('attribute').text : null,
          imports: ctx.imports, locals: ctx.locals, types: ctx.types, cls: ctx.cls, guards: ctx.guards, onFailure: ctx.onFailure || null,
          top: !ctx.fn, args: args ? args.namedChildren.map(argOf) : [] });
        break;
      }
    }
    for (const c of node.namedChildren) visit(c, ctx);
  }
  visit(root, { imports: M.imports, fn: null, cls: null, inClass: false, locals: new Map(), types: new Map(), guards: [], onFailure: null });
}

/* ---------------- package roots ---------------- */

const packagesOf = py => {   // every in-repo package: a directory holding modules, or an __init__.py
  const out = new Set();
  for (const [k, M] of py.modules) { const parts = k.split('.'); for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('.'));
    if (M.file.endsWith('__init__.py')) out.add(k); }
  return out;
};
const initDirsOf = py => new Set([...py.modules.values()].filter(M => M.file.endsWith('__init__.py')).map(M => dirname(M.file)));

/* Modules are named from the repo root; an absolute import is also resolved the way Python finds it from a package
   root below it. A file's package root is the top of the contiguous run of ancestor directories holding an
   __init__.py, and its dotted name there is that run plus the file: `backend/app/x.py`, with `backend/app/__init__.py`
   and no `backend/__init__.py`, is also `app.x` (claimed under the root `backend`). A name whose top-level part is a
   standard-library module is never claimed (an in-repo `logging/` never captures `import logging`). Returns every
   claim, `alias -> [{ key, root }]`, and the package roots. */
export function packageAliases(py) {
  const initDirs = initDirsOf(py), claims = new Map(), roots = new Set();
  for (const [key, M] of py.modules) {
    const dirs = M.file.split('/').slice(0, -1);
    let k = 0; while (k < dirs.length && initDirs.has(dirs.slice(0, dirs.length - k).join('/'))) k++;
    const root = dirs.slice(0, dirs.length - k);
    if (!k || !root.length) continue;
    const alias = key.slice(root.join('.').length + 1);
    if (STDLIB.has(alias.split('.')[0])) continue;
    (claims.get(alias) || claims.set(alias, []).get(alias)).push({ key, root: root.join('/') });
    roots.add(root.join('/'));
  }
  return { claims, roots: [...roots].sort() };
}

/* ---------------- resolution ---------------- */

export function resolverFor(py, deps = new Set()) {
  const { modules, classes, symbols } = py;
  const pkgs = packagesOf(py), initDirs = initDirsOf(py);
  const { claims, roots: packageRoots } = packageAliases(py);
  const inRepo = m => modules.has(m) || pkgs.has(m);
  // a standard-library name resolves at the repo root only to a package (`logging/__init__.py`), never a loose module
  const atRoot = name => { const top = name.split('.')[0]; return inRepo(name) && (!STDLIB.has(top) || !!modules.get(top)?.file.endsWith('__init__.py')); };
  // beside the importing file when its directory is no package (a script dir on sys.path), then the package roots
  const sibling = (name, from) => { const f = modules.get(from)?.file, dir = f && dirname(f);
    if (!dir || dir === '.' || initDirs.has(dir) || f.endsWith('__init__.py') || STDLIB.has(name.split('.')[0])) return null;
    const m = `${dir.split('/').join('.')}.${name}`; return inRepo(m) ? m : null; };
  /* through the package roots: the longest claimed dotted prefix, the rest appended (`app.api.routes` via `app` when
     api/ has no __init__.py). Several claims: the one whose root holds the importing file wins, else the name stays
     external (`ambiguous`). A claim under another root resolves (`cross`) unless the repo declares the top-level name
     as a dependency (`integrations/stripe/` never captures a declared `stripe`). */
  const claimed = (name, from) => {
    const parts = name.split('.'), dir = dirname(modules.get(from)?.file || '.');
    for (let i = parts.length; i >= 1; i--) {
      const alias = parts.slice(0, i).join('.'), cs = claims.get(alias);
      if (!cs) continue;
      const at = c => [c.key, ...parts.slice(i)].join('.');
      const live = cs.filter(c => inRepo(at(c)));
      const own = live.filter(c => dir === c.root || dir.startsWith(c.root + '/')).sort((a, b) => b.root.length - a.root.length)[0];
      if (own) return { key: at(own) };
      if (live.length > 1) return { ambiguous: { name: alias, roots: live.map(c => c.root).sort() } };
      if (live.length && !deps.has(normaliseDep(parts[0]))) return { key: at(live[0]), cross: { name: alias, root: live[0].root } };
      return {};
    }
    return {};
  };
  const locate = (name, from) => atRoot(name) ? { key: name } : (n => n ? { key: n } : claimed(name, from))(sibling(name, from));
  // an absolute module name as the importing module sees it, or null when no in-repo module answers to it
  const findModule = (name, from) => locate(name, from).key || null;
  const via = l => ({ ...(l.cross ? { cross: l.cross } : {}), ...(l.ambiguous ? { ambiguous: l.ambiguous } : {}) });
  function resolveImport(t, depth = 0) {
    if (!t || depth > 4) return null;
    if (t.module) { const l = locate(t.module, t.in); return l.key ? { module: l.key, ...via(l) } : { ext: t.module, ...via(l) }; }
    const l = locate(t.from, t.in), from = l.key, m = from && modules.get(from);
    if (m?.defs.has(t.name)) return { id: m.defs.get(t.name), ...via(l) };
    const followed = m?.imports.has(t.name) ? resolveImport(m.imports.get(t.name), depth + 1) : null;
    if (followed && !followed.missing) return followed;
    if (!from) { const s = locate(`${t.from}.${t.name}`, t.in); return s.key ? { module: s.key, ...via(s) } : { ext: `${t.from}.${t.name}`, ...via(l), ...via(s) }; }
    const sub = `${from}.${t.name}`;
    // `missing`: an in-repo module that does not define the name; counted as an in-repo miss
    return inRepo(sub) ? { module: sub, ...via(l) } : { missing: sub };
  }
  function resolveName(name, c) {
    if (c.locals && c.locals.has(name)) return { id: c.locals.get(name) };
    if (c.imports.has(name)) return resolveImport(c.imports.get(name));
    const M = modules.get(c.module);
    return M && M.defs.has(name) ? { id: M.defs.get(name) } : null;
  }
  const resolveExpr = (expr, c) => {   // `Klass` / `mod.Klass` / `fn`
    if (!expr.includes('.')) return resolveName(expr, c);
    const [head, ...rest] = expr.split('.');
    const r = resolveName(head, c);
    if (r && r.module) { const mod = rest.length > 1 ? `${r.module}.${rest.slice(0, -1).join('.')}` : r.module; const id = modules.get(mod)?.defs.get(rest[rest.length - 1]); return id ? { id } : null; }
    if (r && r.ext) return { ext: `${r.ext}.${rest.join('.')}` };
    return null;
  };
  for (const k of classes.values()) k.bases = k.baseExprs.map(b => {
    const r = b.includes('.') ? null : resolveName(b, { imports: k.imports, module: k.module });
    return r && r.id && classes.has(r.id) ? r.id : null; }).filter(Boolean);
  const subclasses = new Map();
  for (const k of classes.values()) for (const b of k.bases) (subclasses.get(b) || subclasses.set(b, []).get(b)).push(k.id);
  const mro = (id, seen = new Set()) => seen.has(id) ? [] : (seen.add(id), [id, ...(classes.get(id)?.bases || []).flatMap(b => mro(b, seen))]);
  const lookup = (clsId, m) => { for (const c of mro(clsId)) { const x = classes.get(c)?.methods.get(m); if (x) return x; } return null; };
  const overrides = (clsId, m, out = []) => { for (const s of subclasses.get(clsId) || []) { const x = classes.get(s).methods.get(m); if (x) out.push(x); overrides(s, m, out); } return out; };
  // `self._make` inside a class -> the method it names (B19: a receiver set by a self-method factory)
  const selfMethod = (expr, sc) => { const m = /^(self|cls)\.(\w+)$/.exec(expr); return m && sc.cls ? lookup(sc.cls, m[2]) : null; };

  /* factory return analysis: which classes can a function return, under which guards */
  const retMemo = new Map();
  const returnsOf = new Map(); for (const r of py.returns) (returnsOf.get(r.fn) || returnsOf.set(r.fn, []).get(r.fn)).push(r);
  function factoryReturns(fnId, depth = 0) {
    if (retMemo.has(fnId)) return retMemo.get(fnId);
    if (depth > 3) return [];
    retMemo.set(fnId, []);
    const out = [];
    const viaExpr = (expr, sc, guards, line) => {
      if (typeof expr === 'string' && expr.includes('(')) expr = expr.slice(0, expr.indexOf('('));   // Builder(...).with_x(...)
      if (typeof expr === 'object' && expr.annot) { const r = resolveExpr(expr.annot, sc); if (r?.id && classes.has(r.id)) out.push({ cls: r.id, guards, line, annot: true }); return; }
      const sm = selfMethod(expr, sc);
      if (sm) { for (const x of factoryReturns(sm, depth + 1)) out.push({ ...x, guards: [...guards, ...x.guards], via: sm }); return; }
      const r = resolveExpr(expr, sc);
      if (!r) return;
      if (r.ext) { if (/^[A-Z]/.test(expr.split('.').pop())) out.push({ ext: r.ext, guards, line }); return; }
      if (r.id && classes.has(r.id)) out.push({ cls: r.id, guards, line });
      else if (r.id && symbols.get(r.id)?.kind === 'function') for (const x of factoryReturns(r.id, depth + 1)) out.push({ ...x, guards: [...guards, ...x.guards], via: r.id });
    };
    for (const ret of returnsOf.get(fnId) || []) {
      if (ret.kind === 'call') viaExpr(ret.expr, ret, ret.guards, ret.line);
      else for (const a of py.fnAssigns.get(fnId)?.get(ret.name) || []) viaExpr(a.expr, a, [...a.guards, ...ret.guards], a.line);
    }
    retMemo.set(fnId, out);
    return out;
  }
  const byReturns = fnId => { const fr = factoryReturns(fnId).filter(x => x.cls); const cs = [...new Set(fr.map(x => x.cls))];
    return cs.length ? { mode: 'factory', factory: fnId, cls: cs, returns: fr } : null; };
  // receiver type from a type spec: concrete classes (ctor) or factory returns (narrowed) or annotation (CHA)
  function receiverOf(spec, sc) {
    if (!spec) return null;
    if (spec.t === 'returns') { const r = byReturns(spec.fn); return r && r.cls.length === 1 ? { mode: 'ctor', cls: r.cls } : r; }   // a param bound to a provider (pytest fixture)
    if (spec.t === 'annot') { const r = resolveExpr(spec.expr, sc);
      if (r?.id && py.typeAliases.has(r.id)) {   // Annotated[T, Depends(provider)]: the provider's returns narrow T
        const a = py.typeAliases.get(r.id); const pr = a.provider ? resolveExpr(a.provider, a) : null;
        const fr = pr?.id ? byReturns(pr.id) : null;
        if (fr) return fr;
        const t = a.type ? resolveExpr(a.type, a) : null; return t?.id && classes.has(t.id) ? { mode: 'annot', cls: [t.id] } : null; }
      return r?.id && classes.has(r.id) ? { mode: 'annot', cls: [r.id] } : null; }
    const sm = selfMethod(spec.expr, sc);
    if (sm) return byReturns(sm);
    const r = resolveExpr(spec.expr, sc);
    if (!r || !r.id) return null;
    if (classes.has(r.id)) return { mode: 'ctor', cls: [r.id] };
    if (symbols.get(r.id)?.kind === 'function') return byReturns(r.id);
    return null;
  }
  function attrReceiver(clsId, attr) {   // self.<attr> typed by assignments in the class (or bases)
    for (const c of mro(clsId)) { const specs = classes.get(c)?.attrTypes.get(attr); if (!specs) continue;
      const cls = [], facts = [];
      for (const s of specs) {
        if (typeof s.expr === 'object' && s.expr.annot) { const r = resolveExpr(s.expr.annot, s); if (r?.id && classes.has(r.id)) { cls.push(r.id); facts.push({ mode: 'annot', cls: r.id }); } continue; }
        const rc = receiverOf({ t: 'call', expr: s.expr }, s); if (rc) { cls.push(...rc.cls); facts.push({ mode: rc.mode, cls: rc.cls, factory: rc.factory }); }
      }
      if (cls.length) { const narrowed = facts.filter(f => f.mode !== 'annot'); return { mode: narrowed.length && narrowed.length === facts.length ? 'factory' : (narrowed.length ? 'mixed' : 'annot'), cls: [...new Set(cls)], facts }; }
    }
    return null;
  }
  return { packageRoots, findModule, resolveImport, resolveName, resolveExpr, mro, lookup, overrides, subclasses, factoryReturns, receiverOf, attrReceiver };
}

const CFG_GUARD = /settings\.|getattr\(\s*settings\b|is_prod|is_dev|env_mode/;
// a guard reads config when its text does, or when a local it names was assigned from config (`x = getattr(settings, …)`)
const readsConfig = (g, alias) => CFG_GUARD.test(g.text) || (g.text.match(/[A-Za-z_]\w*/g) || []).some(id => alias?.[id] && CFG_GUARD.test(alias[id]));

export function addEdge(py, from, to, kind, line, extra = {}) {
  if (!from || !to || from === to) return;
  const e = { from, to, kind, line, ...extra };
  const gf = py.symbols.get(from)?.group || py.modules.get(from.split(':')[0])?.group, gt = py.symbols.get(to)?.group;
  if (gf && gt && gf !== gt) e.groups = [gf, gt];
  py.edges.push(e);
}

const BUILTINS = new Set(['print', 'len', 'str', 'int', 'float', 'bool', 'dict', 'list', 'set', 'tuple', 'range', 'enumerate', 'zip', 'map',
  'filter', 'sorted', 'reversed', 'min', 'max', 'sum', 'any', 'all', 'isinstance', 'issubclass', 'getattr', 'setattr', 'hasattr', 'delattr',
  'open', 'iter', 'next', 'repr', 'type', 'super', 'id', 'hash', 'abs', 'round', 'format', 'vars', 'dir', 'callable', 'object', 'frozenset',
  'bytes', 'bytearray', 'memoryview', 'divmod', 'pow', 'chr', 'ord', 'hex', 'oct', 'bin', 'globals', 'locals', 'input', 'exec', 'eval',
  'compile', 'property', 'staticmethod', 'classmethod', 'slice', 'complex', 'ascii', 'breakpoint', 'aiter', 'anext']);

export function resolveCalls(py, R) {
  const { classes, symbols, modules } = py;
  const noteMiss = (c, head) => {   // classify an unresolved call by where its head name comes from
    const r = R.resolveName(head, c);
    if (r && (r.id || r.module || r.missing)) py.unresolved.inRepo++;
    else if (r && r.ext) { py.unresolved.external++; const top = r.ext.split('.')[0]; py.externalCalls.set(top, (py.externalCalls.get(top) || 0) + 1); }
    else if (BUILTINS.has(head)) py.unresolved.builtin++;
    else py.unresolved.local++;
  };
  const tally = (map, note) => { const k = JSON.stringify(note); (map.get(k) || map.set(k, { ...note, calls: 0 }).get(k)).calls++; };
  for (const c of py.rawCalls) {
    const head = (c.attr ? c.obj : c.expr).split('.')[0], r0 = head.includes('(') ? null : R.resolveName(head, c);
    if (r0?.cross) tally(py.importNotes.cross, r0.cross);
    if (r0?.ambiguous) tally(py.importNotes.ambiguous, r0.ambiguous);
    const alias = py.fnAlias.get(c.from);
    const cg = (c.guards || []).filter(x => readsConfig(x, alias));
    const extra = { ...(cg.length ? { cfg: cg.map(x => (x.neg ? 'not ' : '') + x.text.replace(/\s+/g, ' ')) } : {}), ...(c.onFailure ? { onFailure: c.onFailure } : {}) };
    const add = (to, kind, more = {}) => addEdge(py, c.from, to, kind, c.line, { ...more, ...extra });
    if (!c.attr) {
      const r = R.resolveName(c.expr, c);
      if (r && r.id) {
        if (classes.has(r.id)) { add(r.id, 'ctor'); const init = R.lookup(r.id, '__init__'); if (init) add(init, 'ctor'); }
        else { add(r.id, 'static'); linkCallbacks(c, r.id); }
        py.callStats.resolved++;
      } else { py.callStats.unresolvedName++; noteMiss(c, c.expr.split('.')[0]); }
      continue;
    }
    let clsId = null, recv = null;
    if (c.obj === 'super()' && c.cls) {   // super().m(): next class in the MRO, same receiver object
      let target = null; for (const k of R.mro(c.cls).slice(1)) { target = classes.get(k)?.methods.get(c.attr); if (target) break; }
      if (target) { add(target, 'static', { passCtx: true, super: true }); py.callStats.resolved++; } else py.callStats.unresolvedAttr++;
      continue;
    }
    if ((c.obj === 'self' || c.obj === 'cls') && c.cls) { clsId = c.cls; recv = { mode: 'self' }; }
    else if (c.types && c.types.has(c.obj)) {
      const rc = R.receiverOf(c.types.get(c.obj), c);
      if (rc) { recv = rc; clsId = rc.cls[0]; }
    } else if (/^self\.\w+$/.test(c.obj) && c.cls) {
      const ar = R.attrReceiver(c.cls, c.obj.slice(5));
      if (ar) { recv = ar; clsId = ar.cls[0]; }
    }
    if (clsId) {
      const site = `${c.from}@${c.line}:${c.attr}`;
      if (recv.mode === 'self') {
        const target = R.lookup(clsId, c.attr);
        if (target) { add(target, 'static', { self: c.attr, site }); linkCallbacks(c, target); }
        for (const o of R.overrides(clsId, c.attr)) add(o, 'virtual', { self: c.attr, site, evidence: `override of ${c.attr} in subclass` });
        if (target || R.overrides(clsId, c.attr).length) { py.callStats.resolved++; continue; }
      } else if (recv.mode === 'ctor') {   // concrete type: no subclass can be the receiver
        const target = R.lookup(clsId, c.attr);
        if (target) { add(target, 'static', { recvClass: clsId, site }); linkCallbacks(c, target); py.callStats.resolved++; continue; }
      } else {
        // annotation (CHA) or factory / class-attribute narrowing
        const annotCls = recv.mode === 'annot' ? recv.cls[0] : null;
        const chaRoot = annotCls || (recv.facts?.find(f => f.mode === 'annot')?.cls) || null;
        const cha = chaRoot ? [R.lookup(chaRoot, c.attr), ...R.overrides(chaRoot, c.attr)].filter(Boolean) : [];
        const narrowed = recv.mode === 'annot' ? null : [...new Set(recv.cls.map(k => R.lookup(k, c.attr)).filter(Boolean))];
        if (recv.mode === 'annot') {
          const target = R.lookup(clsId, c.attr);
          if (target) { add(target, 'static'); linkCallbacks(c, target); }
          for (const o of R.overrides(clsId, c.attr)) add(o, 'virtual', { evidence: `override of ${c.attr} in subclass`, site });
          if (target || R.overrides(clsId, c.attr).length) { py.callStats.resolved++; if (R.overrides(clsId, c.attr).length) py.dispatchSites.push({ site, attr: c.attr, from: c.from, mode: 'annot', cha: cha.length, narrowed: null }); continue; }
        } else if (narrowed.length) {
          for (const t of narrowed) add(t, narrowed.length === 1 ? 'static' : 'dispatch', { site, narrowedBy: recv.factory || 'class-attr', recvClass: narrowed.length === 1 ? recv.cls[0] : undefined });
          if (narrowed.length === 1) linkCallbacks(c, narrowed[0]);
          py.dispatchSites.push({ site, attr: c.attr, from: c.from, mode: recv.mode, cha: cha.length, narrowed: narrowed.length, factory: recv.factory, recvCls: recv.cls });
          py.callStats.resolved++; continue;
        }
      }
    }
    const r = !c.obj.includes('(') ? R.resolveName(c.obj.split('.')[0], c) : null;
    if (r && r.module) {
      const mod = c.obj.includes('.') ? `${r.module}.${c.obj.split('.').slice(1).join('.')}` : r.module;
      const id = modules.get(mod)?.defs.get(c.attr);
      if (id) { add(id, 'static'); linkCallbacks(c, id); py.callStats.resolved++; continue; }
    } else if (r && r.id && classes.has(r.id)) {
      const id = R.lookup(r.id, c.attr);
      if (id) { add(id, 'static'); linkCallbacks(c, id); py.callStats.resolved++; continue; }
    }
    py.callStats.unresolvedAttr++;
    if (!c.obj.includes('(')) noteMiss(c, c.obj.split('.')[0]);
  }

  /* B17: a callable or a coroutine handed to an in-repo callee runs where the callee calls, awaits or forwards that
     parameter, so the callee links to it. The link is only true for this caller (`passedBy`): a walk that reached the
     callee some other way must not follow it. */
  function linkCallbacks(c, calleeId) {
    const callee = symbols.get(calleeId), u = py.uses.get(calleeId);
    if (!callee?.params || !u) return;
    const params = callee.kind === 'method' && /^(self|cls)$/.test(callee.params[0]) && c.attr ? callee.params.slice(1) : callee.params;
    const positional = c.args.filter(a => a.type !== 'keyword_argument' && a.type !== 'comment');
    const pass = (a, param) => {
      if (!param) return;
      // `f` handed over is run by `param(...)`; `f()` handed over is a coroutine, run by `await param` or `wait_for(param)`
      const name = a.vtype === 'identifier' ? a.vtext : a.vtype === 'call' && /^[A-Za-z_]\w*$/.test(a.fn) ? a.fn : null;
      const line = a.vtype === 'identifier' ? u.called.get(param) : (u.awaited.get(param) ?? u.passed.get(param));
      if (!name || line == null) return;
      const r = R.resolveName(name, c);
      const fn = r?.id && symbols.get(r.id);
      if (!fn || (fn.kind !== 'function' && fn.kind !== 'method') || (a.vtype === 'call' && !fn.async)) return;
      addEdge(py, calleeId, r.id, 'static', line, { rule: 'py.callback', passedBy: c.from, passedAt: `${c.file}:${c.line}`,
        evidence: `${c.file}:${c.line} hands ${a.vtext} to ${callee.name}(${param}); ${callee.file}:${line} runs it` });
    };
    positional.forEach((a, i) => pass(a, params[i]));
    for (const a of c.args) if (a.type === 'keyword_argument') pass(a, a.kw);
  }
}

/* language conventions that make an entry: `if __name__ == "__main__":`, and a module-level `Ctor(kw=fn)` */
export function pythonEntries(py, R) {
  const entries = [];
  for (const m of py.mains) entries.push({ kind: 'main', id: m, file: py.symbols.get(m).file });
  for (const c of py.rawCalls) if (c.top) for (const a of c.args) {
    if (a.type !== 'keyword_argument' || a.vtype !== 'identifier') continue;
    const r = R.resolveName(a.vtext, { imports: py.modules.get(c.module).imports, module: c.module });
    if (r && r.id && py.symbols.get(r.id)?.kind === 'function') entries.push({ kind: 'registered-callback', id: r.id, via: `${c.expr}(${a.kw}=…)`, line: c.line, file: py.symbols.get(r.id).file });
  }
  return entries;
}

export const conftestScope = file => { const d = dirname(file); return d === '.' ? '' : d + '/'; };
