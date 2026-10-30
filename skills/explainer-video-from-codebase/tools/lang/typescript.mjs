/* The TypeScript / JavaScript adapter: facts per file (.ts .tsx .mts .cts .js .jsx .mjs .cjs), then module, name,
   member and constructor resolution into the same typed edges the Python adapter writes. Rule packs (../rules/)
   read the same facts and add framework links on top.

   Ids: a module is its repo-relative path with its extension (`web/src/api.ts`), so no TS id can meet a Python one;
   a symbol is `<module>:<qualname>` with the Python adapter's scoping (`K.m`, `f.<locals>.g`).

   Resolution rules (design rev3 §3.14, TS/JS row): ESM imports (default, named, namespace, re-exports, `export *`,
   `export default`) and CommonJS (`require`, destructured `require`, `module.exports`, `exports.x`); module
   specifiers the way graphify resolves them (relative paths with TypeScript's `.js` -> `.ts` convention, extension
   probing, directory indexes, tsconfig/jsconfig `paths` and `baseUrl` through `extends`, workspace packages, and the
   `@/` -> `src/` convention when no tsconfig exists); `this.m()` through the class chain plus a `virtual` edge per
   subclass override; `super.m()`; receivers typed by `new K()`, an annotated parameter or variable, a class field or
   constructor parameter property, a module-level singleton, or a factory's returns (with branch guards); object-literal
   members (`api.list()`); a rendered JSX component; a function handed to a call or a JSX prop; a call inside `catch`
   is labelled "on failure", and one under a config-reading `if` carries its guard. */
import { posix } from 'node:path';

export const TS_LANGS = new Set(['typescript', 'tsx', 'javascript']);
const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', 'index.cjs'];

export function newTsModel() {
  return {
    symbols: new Map(), classes: new Map(), modules: new Map(),
    rawCalls: [], handed: [], returns: [], mains: [], fnAssigns: new Map(),
    routeDefs: [], testCalls: [], mockCalls: [], envReads: [],
    edges: [], callStats: { resolved: 0, unresolvedName: 0, unresolvedAttr: 0 },
    unresolved: { inRepo: 0, external: 0, builtin: 0, local: 0 }, externalImports: new Map(), unresolvedImports: new Map(),
    defNodes: 0, defsVisited: 0, defScopes: 0,
    groupOf: null,   // id -> group across every language; set by mine.mjs before edges are added
  };
}

/* ---------------- expression IR: what const folding and the rule packs read, kept as plain data ---------------- */

const unquote = n => n.namedChildren.filter(c => c.type === 'string_fragment' || c.type === 'escape_sequence').map(c => c.text).join('');
export const strOf = n => !n ? null : n.type === 'string' ? unquote(n)
  : n.type === 'template_string' && !n.namedChildren.some(c => c.type === 'template_substitution') ? unquote(n) : null;
const ENV = /^(?:process\.env|import\.meta\.env)\.([A-Za-z_]\w*)$/;
const ENV_SUB = /^(?:process\.env|import\.meta\.env)\[\s*["'`]([A-Za-z_]\w*)["'`]\s*\]$/;
export function ir(n, depth = 0) {
  if (!n || depth > 8) return { k: 'unknown' };
  switch (n.type) {
    case 'string': return { k: 'str', v: unquote(n) };
    case 'number': return { k: 'str', v: n.text };
    case 'template_string': return { k: 'tpl', parts: n.namedChildren.map(c => c.type === 'template_substitution' ? ir(c.namedChildren[0], depth + 1)
      : { k: 'str', v: c.text }) };
    case 'identifier': return { k: 'id', name: n.text };
    case 'member_expression': { const m = ENV.exec(n.text); if (m) return { k: 'env', key: m[1] };
      return { k: 'member', obj: ir(n.childForFieldName('object'), depth + 1), prop: n.childForFieldName('property').text }; }
    case 'subscript_expression': { const m = ENV_SUB.exec(n.text); return m ? { k: 'env', key: m[1] } : { k: 'unknown' }; }
    case 'binary_expression': { const op = n.childForFieldName('operator')?.text, l = ir(n.childForFieldName('left'), depth + 1), r = ir(n.childForFieldName('right'), depth + 1);
      return op === '+' ? { k: 'cat', l, r } : op === '??' || op === '||' ? { k: 'or', l, r } : { k: 'unknown' }; }
    case 'parenthesized_expression': case 'as_expression': case 'satisfies_expression': case 'non_null_expression': case 'await_expression':
      return ir(n.namedChildren[0], depth + 1);
    case 'object': {
      const pairs = {};
      for (const p of n.namedChildren) {
        if (p.type === 'pair') { const k = p.childForFieldName('key'); const key = k.type === 'string' ? unquote(k) : k.text; pairs[key] = ir(p.childForFieldName('value'), depth + 1); }
        else if (p.type === 'shorthand_property_identifier') pairs[p.text] = { k: 'id', name: p.text };
        else if (p.type === 'spread_element') pairs['...'] = { k: 'spread', text: p.text };
      }
      return { k: 'obj', pairs };
    }
    case 'call_expression': return { k: 'call', fn: n.childForFieldName('function')?.text };
    default: return { k: 'unknown' };
  }
}

/* ---------------- types ---------------- */

// `X`, `ns.X`, `X<T>`, `X | null`, `X | undefined` -> the class name; anything else (unions, literals, functions) -> null
function simpleType(t) {
  if (!t) return null;
  if (t.type === 'type_annotation') return simpleType(t.namedChildren[0]);
  if (t.type === 'type_identifier' || t.type === 'nested_type_identifier' || t.type === 'identifier') return t.text;
  if (t.type === 'generic_type') return simpleType(t.childForFieldName('name') || t.namedChildren[0]);
  if (t.type === 'union_type') { const parts = t.namedChildren.filter(c => !/^(null|undefined)$/.test(c.text) && !(c.type === 'literal_type' && /^(null|undefined)$/.test(c.text)));
    return parts.length === 1 ? simpleType(parts[0]) : null; }
  if (t.type === 'parenthesized_type') return simpleType(t.namedChildren[0]);
  return null;
}
// a variable's value as a receiver spec: `new K()`, `make()`, `x as K`, `await …`
function valueSpec(v) {
  if (!v) return null;
  if (/^(await_expression|parenthesized_expression|non_null_expression)$/.test(v.type)) return valueSpec(v.namedChildren[0]);
  if (v.type === 'as_expression' || v.type === 'satisfies_expression') { const t = simpleType(v.namedChildren[1]); return t ? { t: 'annot', expr: t } : valueSpec(v.namedChildren[0]); }
  if (v.type === 'new_expression') return { t: 'new', expr: v.childForFieldName('constructor').text };
  if (v.type === 'call_expression') { const f = v.childForFieldName('function'); const a0 = v.childForFieldName('arguments')?.namedChildren?.[0];
    return { t: 'call', expr: f.text, a0: a0 ? ir(a0) : null }; }
  return null;
}

const FUNC = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const CLASS_DECL = new Set(['class_declaration', 'abstract_class_declaration']);
// calls that hand back the function they are given: the function is named by the variable it is assigned to
const WRAPPERS = /^(React\.)?(memo|forwardRef|useCallback|useMemo|observer|debounce|throttle|_\.debounce|_\.throttle|lazyWithRetry)$/;
const LAZY = /^(React\.)?lazy$|^loadable$/;
const TEST_API = /^(it|test|describe|suite|context)$/;
const HOOK_API = /^(beforeEach|beforeAll|afterEach|afterAll|before|after)$/;
const ROUTE_REG = /^(get|post|put|patch|delete|del|all|options|head|use)$/;
const safeTitle = s => s.replace(/:/g, '-').replace(/\s+/g, ' ').trim();

export function extractTsFile(ts, rel, root, group, text, lang) {
  const module = rel;
  const M = { file: rel, group, lang, imports: new Map(), defs: new Map(), objects: new Map(), vars: new Map(), consts: new Map(),
    exports: new Map(), starExports: [], defaultExport: null, cjsExports: false, importsRouter: false };
  ts.modules.set(module, M);
  const lines = text.split('\n');
  const spanText = (a, b) => lines.slice(a - 1, b).join('\n');
  const MOD = `${module}:<module>`;
  const noteExternal = (spec) => { const top = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (!spec.startsWith('.') && !ts.externalImports.has(top)) ts.externalImports.set(top, rel); };

  // definitions the self-check expects: declarations, class members, and functions or classes a variable names
  const counted = new Set();
  for (const n of root.descendantsOfType(['function_declaration', 'generator_function_declaration', 'class_declaration', 'abstract_class_declaration', 'method_definition', 'variable_declarator'])) {
    if (n.type === 'method_definition' && n.parent?.type !== 'class_body') continue;
    if (n.type === 'variable_declarator') { const v = n.childForFieldName('value'); if (n.childForFieldName('name')?.type !== 'identifier' || !v || !(FUNC.has(v.type) || v.type === 'class')) continue; }
    if (!n.childForFieldName('name') && n.type !== 'variable_declarator') continue;
    counted.add(n.id);
  }
  ts.defNodes += counted.size;
  const quals = new Set();

  const qualIn = (ctx, name) => ctx.inClass ? `${ctx.clsQual}.${name}` : ctx.fn ? `${ctx.qual}.<locals>.${name}` : ctx.describe?.length ? `${ctx.describe.join(' > ')}.<locals>.${name}` : name;
  const uniqueId = q => { let id = `${module}:${q}`, i = 2; while (ts.symbols.has(id)) id = `${module}:${q}#${i++}`; return id; };
  const params = fnNode => {
    const ps = fnNode.childForFieldName('parameters') || fnNode.childForFieldName('parameter');
    if (!ps) return [];
    const list = ps.type === 'formal_parameters' ? ps.namedChildren : [ps];
    return list.map(p => {
      const pat = p.type === 'required_parameter' || p.type === 'optional_parameter' ? p.childForFieldName('pattern') : p.type === 'assignment_pattern' ? p.childForFieldName('left') : p;
      const dflt = p.childForFieldName('value') || (p.type === 'assignment_pattern' ? p.childForFieldName('right') : null);
      return { name: pat?.type === 'identifier' ? pat.text : null, type: simpleType(p.childForFieldName('type')), dflt,
        prop: p.namedChildren.some(c => c.type === 'accessibility_modifier' || c.text === 'readonly') };
    });
  };

  // a function-like node becomes a symbol; its body is visited as that symbol
  function defineFn(node, name, ctx, { kind, counts = false, extra = {} } = {}) {
    if (counts) ts.defsVisited++;
    const q = qualIn(ctx, name);
    const id = uniqueId(q);
    quals.add(q);
    const start = node.startPosition.row + 1, end = node.endPosition.row + 1;
    const ps = params(node);
    const sym = { id, group, kind: kind || (ctx.inClass ? 'method' : 'function'), file: rel, start, end, name, module, lang,
      cls: ctx.inClass ? ctx.cls : null, decos: extra.decos || [], params: ps.map(p => p.name).filter(Boolean), text: spanText(start, end),
      ...(node.children.some(c => c.type === 'async') ? { async: true } : {}), ...(extra.sym || {}) };
    ts.symbols.set(id, sym);
    if (ctx.inClass) ts.classes.get(ctx.cls).methods.set(name, id);
    else if (!extra.noBind) (ctx.fn || ctx.describe?.length ? ctx.locals : M.defs).set(name, id);
    const inner = { ...ctx, fn: id, qual: q, inClass: false, locals: new Map(ctx.locals), types: new Map(ctx.types), consts: new Map(ctx.consts),
      guards: [], onFailure: null, decos: null, test: extra.test || ctx.test, declared: new Set(), outerTypes: extra.outerTypes || null };
    // a parameter is typed by its annotation, else by its default (`log = new Log()`); defaults run in the function
    for (const p of ps) { const spec = p.type ? { t: 'annot', expr: p.type } : valueSpec(p.dflt);
      if (p.name && spec) inner.types.set(p.name, spec);
      if (ctx.inClass && name === 'constructor' && p.prop && p.name && spec) addAttr(ctx.cls, p.name, spec, ctx);
      if (p.dflt) visit(p.dflt, inner); }
    const body = node.childForFieldName('body');
    if (body) {
      if (body.type === 'statement_block') visitBlock(body, inner);
      else { visit(body, inner); noteReturn(body, inner); }   // an arrow's expression body is its return value
    }
    return id;
  }
  function addAttr(clsId, name, spec, ctx) {
    const k = ts.classes.get(clsId); if (!k || !spec) return;
    (k.attrTypes.get(name) || k.attrTypes.set(name, []).get(name)).push({ ...spec, guards: ctx.guards || [], module, locals: ctx.locals, types: ctx.types });
  }
  function defineClass(node, name, ctx, counts) {
    if (counts) ts.defsVisited++;
    const q = qualIn(ctx, name);
    const id = uniqueId(q);
    quals.add(q);
    const her = node.namedChildren.find(c => c.type === 'class_heritage');
    let baseExprs = [], implementsExprs = [];
    if (her) for (const c of her.namedChildren) {
      if (c.type === 'extends_clause') { const v = c.childForFieldName('value') || c.namedChildren[0]; if (v) baseExprs.push(v.type === 'call_expression' ? v.childForFieldName('function').text : v.text); }
      else if (c.type === 'implements_clause') implementsExprs = c.namedChildren.map(simpleType).filter(Boolean);
      else if (c.type === 'identifier' || c.type === 'member_expression') baseExprs.push(c.text);   // JS: `extends X`
    }
    const start = node.startPosition.row + 1, end = node.endPosition.row + 1;
    const decos = node.namedChildren.filter(c => c.type === 'decorator').map(d => d.text.replace(/^@/, ''));
    ts.classes.set(id, { id, module, name, baseExprs, implementsExprs, methods: new Map(), attrTypes: new Map(), decos, file: rel, line: start,
      abstract: node.type === 'abstract_class_declaration', scope: { module, locals: ctx.locals } });
    ts.symbols.set(id, { id, group, kind: 'class', file: rel, start, end, name, module, lang, decos, text: spanText(start, end) });
    if (!ctx.inClass) (ctx.fn || ctx.describe?.length ? ctx.locals : M.defs).set(name, id);
    const cctx = { ...ctx, cls: id, clsQual: q, inClass: true };
    for (const m of node.childForFieldName('body').namedChildren) {
      if (m.type === 'method_definition') {
        const nm = m.childForFieldName('name').text;
        const getset = m.children.find(c => c.type === 'get' || c.type === 'set')?.type;
        const d = [...(m.namedChildren.filter(c => c.type === 'decorator').map(x => x.text.replace(/^@/, ''))),
          ...(m.children.some(c => c.type === 'static') ? ['static'] : []), ...(getset ? [getset === 'get' ? 'property' : 'setter'] : [])];
        defineFn(m, getset === 'set' ? `${nm}.setter` : nm, cctx, { counts: true, extra: { decos: d } });
      } else if (m.type === 'abstract_method_signature') {
        const nm = m.childForFieldName('name').text;
        defineFn(m, nm, cctx, { extra: { decos: ['abstract'] } });
      } else if (m.type === 'public_field_definition' || m.type === 'field_definition') {
        const nm = (m.childForFieldName('name') || m.childForFieldName('property'))?.text, v = m.childForFieldName('value');
        if (!nm) continue;
        if (v && FUNC.has(v.type)) defineFn(v, nm, cctx, {});
        else { const spec = valueSpec(v) || (simpleType(m.childForFieldName('type')) ? { t: 'annot', expr: simpleType(m.childForFieldName('type')) } : null);
          addAttr(id, nm, spec, { ...ctx, guards: [] }); if (v) visit(v, { ...ctx, fn: null, cls: id, inClass: false }); }
      } else if (m.type === 'class_static_block') visit(m, { ...cctx, inClass: false });
    }
    return id;
  }

  /* imports and exports */
  function addImport(node) {
    const src = strOf(node.childForFieldName('source'));
    if (src == null) return;
    noteExternal(src);
    if (/^react-router(-dom)?$|^@remix-run\/router$/.test(src)) M.importsRouter = true;
    if (node.children.some(c => c.type === 'type')) return;   // `import type`
    const clause = node.namedChildren.find(c => c.type === 'import_clause');
    if (!clause) return;
    const line = node.startPosition.row + 1;
    for (const c of clause.namedChildren) {
      if (c.type === 'identifier') M.imports.set(c.text, { source: src, name: 'default', line });
      else if (c.type === 'namespace_import') M.imports.set(c.namedChildren[0].text, { source: src, name: '*', line });
      else if (c.type === 'named_imports') for (const s of c.namedChildren.filter(x => x.type === 'import_specifier')) {
        if (s.children.some(x => x.type === 'type')) continue;
        const name = s.childForFieldName('name'), alias = s.childForFieldName('alias');
        M.imports.set((alias || name).text, { source: src, name: name.type === 'string' ? unquote(name) : name.text, line });
      }
    }
  }
  function addExport(node, ctx) {
    const src = strOf(node.childForFieldName('source'));
    const isDefault = node.children.some(c => c.type === 'default');
    const decl = node.childForFieldName('declaration');
    const val = node.childForFieldName('value');
    if (src != null) noteExternal(src);
    if (decl) {
      const id = visit(decl, ctx);
      const names = decl.type === 'lexical_declaration' || decl.type === 'variable_declaration'
        ? decl.namedChildren.filter(d => d.type === 'variable_declarator').map(d => d.childForFieldName('name')).filter(n => n?.type === 'identifier').map(n => n.text)
        : [decl.childForFieldName('name')?.text].filter(Boolean);
      if (isDefault) M.defaultExport = names[0] ? { local: names[0] } : id ? { id } : null;
      else for (const n of names) M.exports.set(n, { local: n });
      return;
    }
    const clause = node.namedChildren.find(c => c.type === 'export_clause');
    if (clause) {
      for (const s of clause.namedChildren.filter(x => x.type === 'export_specifier')) {
        const name = s.childForFieldName('name'), alias = s.childForFieldName('alias');
        const nm = name.type === 'string' ? unquote(name) : name.text, as = alias ? (alias.type === 'string' ? unquote(alias) : alias.text) : nm;
        const target = src != null ? { source: src, name: nm } : { local: nm };
        if (as === 'default') M.defaultExport = target; else M.exports.set(as, target);
      }
      return;
    }
    const ns = node.namedChildren.find(c => c.type === 'namespace_export');
    if (src != null && ns) { M.exports.set(ns.namedChildren[0].text, { source: src, name: '*' }); return; }
    if (src != null) { M.starExports.push(src); return; }
    if (isDefault && val) {
      if (val.type === 'identifier') M.defaultExport = { local: val.text };
      else if (FUNC.has(val.type)) M.defaultExport = { id: defineFn(val, 'default', ctx, {}) };
      else if (val.type === 'class') M.defaultExport = { id: defineClass(val, val.childForFieldName('name')?.text || 'default', ctx, false) };
      else if (val.type === 'object') { defineObject(val, 'default', ctx); M.defaultExport = { local: 'default' }; }
      else if (val.type === 'call_expression') {   // `export default memo(Page)`, `connect(...)(Page)`, `withRouter(Page)`
        visit(val, ctx);
        let c = val, inner = null;
        while (c?.type === 'call_expression') { const as = c.childForFieldName('arguments')?.namedChildren || [];
          inner = as.find(a => a.type === 'identifier') || inner; const fnArg = as.find(a => FUNC.has(a.type));
          if (fnArg && !inner) { M.defaultExport = { id: defineFn(fnArg, 'default', ctx, {}) }; return; }
          c = c.childForFieldName('function'); }
        M.defaultExport = inner ? { local: inner.text } : null;
      } else visit(val, ctx);
    }
  }
  function defineObject(obj, name, ctx) {
    const members = new Map();
    for (const p of obj.namedChildren) {
      if (p.type === 'method_definition') { const k = p.childForFieldName('name').text; members.set(k, defineFn(p, `${name}.${k}`, ctx, { extra: { noBind: true } })); }
      else if (p.type === 'pair') {
        const kn = p.childForFieldName('key'), v = p.childForFieldName('value'), k = kn.type === 'string' ? unquote(kn) : kn.text;
        if (FUNC.has(v.type)) members.set(k, defineFn(v, `${name}.${k}`, ctx, { extra: { noBind: true } }));
        else if (v.type === 'identifier') members.set(k, { local: v.text });
        else visit(v, ctx);
      } else if (p.type === 'shorthand_property_identifier') members.set(p.text, { local: p.text });
      else visit(p, ctx);
    }
    const key = ctx.fn ? null : name;
    if (key) M.objects.set(key, members);
    return members;
  }
  function requireOf(v) {   // `require('x')`, `require('x').y`
    if (v?.type === 'call_expression' && v.childForFieldName('function').text === 'require') { const s = strOf(v.childForFieldName('arguments').namedChildren[0]); return s != null ? { source: s, name: '*' } : null; }
    if (v?.type === 'member_expression') { const r = requireOf(v.childForFieldName('object')); return r && r.name === '*' ? { source: r.source, name: v.childForFieldName('property').text } : null; }
    return null;
  }
  function lazyImport(v) {   // `lazy(() => import('./Page'))`
    if (v?.type !== 'call_expression' || !LAZY.test(v.childForFieldName('function').text)) return null;
    const f = v.childForFieldName('arguments').namedChildren[0];
    const call = f && FUNC.has(f.type) ? f.descendantsOfType('call_expression').find(c => c.childForFieldName('function').type === 'import') : null;
    const s = call && strOf(call.childForFieldName('arguments').namedChildren[0]);
    return s != null ? { source: s, name: 'default', lazy: true } : null;
  }

  function declarator(d, ctx) {
    const nameN = d.childForFieldName('name'), v = d.childForFieldName('value');
    const line = d.startPosition.row + 1;
    const req = requireOf(v);
    if (req) {
      noteExternal(req.source);
      if (nameN?.type === 'identifier') M.imports.set(nameN.text, { ...req, line, cjs: true });
      else if (nameN?.type === 'object_pattern') for (const p of nameN.namedChildren) {
        if (p.type === 'shorthand_property_identifier_pattern') M.imports.set(p.text, { source: req.source, name: p.text, line, cjs: true });
        else if (p.type === 'pair_pattern' && p.childForFieldName('value')?.type === 'identifier') M.imports.set(p.childForFieldName('value').text, { source: req.source, name: p.childForFieldName('key').text, line, cjs: true });
      }
      return;
    }
    if (nameN?.type !== 'identifier') { if (v) visit(v, ctx); return; }
    const name = nameN.text;
    const lz = lazyImport(v);
    if (lz) { noteExternal(lz.source); M.imports.set(name, { ...lz, line }); return; }
    if (v && FUNC.has(v.type)) return defineFn(v, name, ctx, { counts: true });
    if (v?.type === 'class') return defineClass(v, name, ctx, true);
    if (v?.type === 'object' && !ctx.fn) { M.consts.set(name, ir(v)); defineObject(v, name, ctx); return; }
    if (v?.type === 'call_expression' && WRAPPERS.test(v.childForFieldName('function').text)) {
      const fnArg = v.childForFieldName('arguments').namedChildren.find(a => FUNC.has(a.type));
      if (fnArg) {
        const id = defineFn(fnArg, name, ctx, {});
        if (ctx.fn) ts.handed.push({ from: ctx.fn, to: id, line, file: rel, how: v.childForFieldName('function').text });
        for (const a of v.childForFieldName('arguments').namedChildren) if (a.id !== fnArg.id) visit(a, ctx);   // node objects are fresh per access: compare ids
        return;
      }
    }
    const t = simpleType(d.childForFieldName('type'));
    const spec = t ? { t: 'annot', expr: t } : valueSpec(v);
    if (ctx.fn) {
      ctx.declared?.add(name);
      if (spec) ctx.types.set(name, spec);
      if (v) ctx.consts.set(name, ir(v));
      if (spec && spec.t !== 'annot') (ts.fnAssigns.get(ctx.fn) || ts.fnAssigns.set(ctx.fn, new Map()).get(ctx.fn)).set(name, { ...spec, guards: ctx.guards, module, locals: ctx.locals, types: ctx.types });
    } else if (ctx.describe?.length) { if (spec) ctx.types.set(name, spec); if (v) ctx.consts.set(name, ir(v)); }
    else { if (spec) M.vars.set(name, { ...spec, line, module, locals: ctx.locals }); if (v) M.consts.set(name, ir(v)); }
    if (v) visit(v, ctx);
  }

  function noteReturn(v, ctx) {
    if (!ctx.fn || !v) return;
    const s = valueSpec(v), line = v.startPosition.row + 1;
    if (s?.t === 'new') ts.returns.push({ fn: ctx.fn, kind: 'new', expr: s.expr, guards: ctx.guards, line, module, locals: ctx.locals, types: ctx.types });
    else if (s?.t === 'call') ts.returns.push({ fn: ctx.fn, kind: 'call', expr: s.expr, guards: ctx.guards, line, module, locals: ctx.locals, types: ctx.types });
    else if (v.type === 'identifier') ts.returns.push({ fn: ctx.fn, kind: 'name', name: v.text, guards: ctx.guards, line, module, locals: ctx.locals, types: ctx.types });
  }

  /* react-router route tables: objects with `path`/`index` and an element in an array, and <Route> elements */
  const elementName = n => {
    if (!n) return null;
    if (n.type === 'jsx_expression') return elementName(n.namedChildren[0]);
    if (n.type === 'jsx_self_closing_element') return n.childForFieldName('name')?.text || null;
    if (n.type === 'jsx_element') return n.childForFieldName('open_tag')?.childForFieldName('name')?.text || null;
    if (n.type === 'identifier') return n.text;
    return null;
  };
  const joinPath = (a, b) => b == null ? a : b.startsWith('/') ? b : `${a.replace(/\/$/, '')}/${b}`;
  function routeObjects(arr, base, rule) {
    for (const o of arr.namedChildren.filter(x => x.type === 'object')) {
      const get = k => o.namedChildren.find(p => p.type === 'pair' && p.childForFieldName('key').text === k)?.childForFieldName('value');
      const pathN = get('path'), path = pathN ? strOf(pathN) : null, isIndex = get('index')?.text === 'true';
      const full = path != null ? joinPath(base, path) : base;
      const el = elementName(get('element')) || elementName(get('Component')) || elementName(get('component'));
      const lazyN = get('lazy'), lazyCall = lazyN?.descendantsOfType('call_expression').find(c => c.childForFieldName('function').type === 'import');
      const lazySrc = lazyCall ? strOf(lazyCall.childForFieldName('arguments').namedChildren[0]) : null;
      if ((path != null || isIndex) && (el || lazySrc)) ts.routeDefs.push({ file: rel, line: o.startPosition.row + 1, path: full || '/', comp: el, lazy: lazySrc, rule });
      const kids = get('children');
      if (kids?.type === 'array') routeObjects(kids, full, rule);
    }
  }
  const isRouteTable = arr => arr.namedChildren.some(o => o.type === 'object' && o.namedChildren.some(p => p.type === 'pair' && /^(path|index)$/.test(p.childForFieldName('key').text))
    && o.namedChildren.some(p => p.type === 'pair' && /^(element|Component|component|lazy|children)$/.test(p.childForFieldName('key').text)));
  function jsxRoute(n) {
    const open = n.type === 'jsx_element' ? n.childForFieldName('open_tag') : n;
    if (open?.childForFieldName('name')?.text !== 'Route') return;
    const attr = (o, k) => o.namedChildren.find(a => a.type === 'jsx_attribute' && a.namedChildren[0]?.text === k);
    const attrVal = (o, k) => attr(o, k)?.namedChildren[1];
    let base = '';
    for (let p = n.parent; p; p = p.parent) if (p.type === 'jsx_element' && p.childForFieldName('open_tag')?.childForFieldName('name')?.text === 'Route') {
      const pp = attrVal(p.childForFieldName('open_tag'), 'path'); const s = pp && (strOf(pp) ?? strOf(pp.namedChildren?.[0])); if (s != null) base = joinPath(s, base || null) || s; }
    const pv = attrVal(open, 'path'), path = pv ? (strOf(pv) ?? strOf(pv.namedChildren?.[0])) : null;
    const el = elementName(attrVal(open, 'element')) || elementName(attrVal(open, 'Component')) || elementName(attrVal(open, 'component'));
    if ((path != null || attr(open, 'index')) && el) ts.routeDefs.push({ file: rel, line: n.startPosition.row + 1, path: (path != null ? joinPath(base, path) : base) || '/', comp: el, rule: 'react-router.jsx' });
  }

  function visitBlock(node, ctx) {   // an `if` whose body always exits guards what follows
    let guards = ctx.guards;
    for (const c of node.namedChildren) {
      visit(c, { ...ctx, guards });
      if (c.type === 'if_statement' && !c.childForFieldName('alternative')) {
        const body = c.childForFieldName('consequence'), last = body?.type === 'statement_block' ? body.namedChildren.at(-1) : body;
        if (last && /return_statement|throw_statement/.test(last.type)) guards = [...guards, { text: cond(c), neg: true }];
      }
    }
  }
  const cond = c => c.childForFieldName('condition').text.replace(/^\(|\)$/g, '');
  const argInfo = (a, i) => ({ type: a.type, text: a.text.length > 200 ? a.text.slice(0, 200) : a.text, ...(i < 2 ? { ir: ir(a) } : {}),
    ...(a.type === 'identifier' ? { name: a.text } : {}), ...(a.type === 'member_expression' ? { member: a.text } : {}) });

  function call(node, ctx) {
    const fnNode = node.childForFieldName('function');
    const argsN = node.childForFieldName('arguments');
    const args = argsN?.type === 'arguments' ? argsN.namedChildren.filter(a => a.type !== 'comment') : [];
    const from = ctx.fn || MOD;
    const line = node.startPosition.row + 1;
    const expr = fnNode.text;
    // test API in a test-group file: `describe(title, fn)` scopes, `it/test(title, fn)` and hooks are symbols
    const head = fnNode.type === 'call_expression' ? fnNode.childForFieldName('function') : fnNode;   // `it.each([...])(title, fn)`
    const base = head.type === 'member_expression' ? head.childForFieldName('object').text : head.text;
    const fnArg = args.find(a => FUNC.has(a.type));
    if (group === 'test' && fnArg && (TEST_API.test(base) || HOOK_API.test(base)) && !ctx.fn) {
      const titleN = args[0].id !== fnArg.id ? args[0] : null;
      const title = safeTitle(titleN ? (strOf(titleN) ?? titleN.text) : base);
      const modifiers = head.type === 'member_expression' ? head.childForFieldName('property').text : null;
      if (/^(describe|suite|context)$/.test(base)) {
        ts.testCalls.push({ kind: 'describe', file: rel, line, title, describe: ctx.describe || [] });
        visitFnBody(fnArg, { ...ctx, describe: [...(ctx.describe || []), title], locals: new Map(ctx.locals), types: new Map(ctx.types), consts: new Map(ctx.consts) });
      } else if (HOOK_API.test(base)) {
        // `let cart; beforeEach(() => { cart = new Cart(); })`: what a hook assigns types the variable for the tests after it
        const id = defineFn(fnArg, [...(ctx.describe || []), base].join(' > '), { ...ctx, describe: [] }, { extra: { noBind: true, test: true, outerTypes: ctx.types, sym: { hook: base, scope: ctx.describe || [] } } });
        ts.testCalls.push({ kind: 'hook', hook: base, id, file: rel, line, describe: ctx.describe || [] });
      } else {
        const id = defineFn(fnArg, safeTitle([...(ctx.describe || []), title].join(' > ')), { ...ctx, describe: [] },
          { extra: { noBind: true, test: true, sym: { test: true, title, describe: ctx.describe || [], ...(modifiers && modifiers !== 'each' ? { modifier: modifiers } : {}) } } });
        ts.testCalls.push({ kind: 'test', id, file: rel, line, title, describe: ctx.describe || [] });
      }
      for (const a of args) if (a.id !== fnArg.id) visit(a, ctx);
      return;
    }
    if (/^(jest|vi)\.(mock|doMock|unmock|spyOn)$/.test(expr)) {
      const how = expr;
      const a1 = args[1];
      const factory = a1 && FUNC.has(a1.type) ? a1 : null;
      const objN = factory ? (factory.childForFieldName('body')?.type === 'object' ? factory.childForFieldName('body')
        : factory.childForFieldName('body')?.type === 'parenthesized_expression' ? factory.childForFieldName('body').namedChildren[0]
        : factory.childForFieldName('body')?.descendantsOfType('return_statement')[0]?.namedChildren[0]) : null;
      const keys = objN?.type === 'object' ? objN.namedChildren.map(p => p.type === 'pair' ? p.childForFieldName('key').text : p.type === 'method_definition' ? p.childForFieldName('name').text : p.type === 'shorthand_property_identifier' ? p.text : null).filter(Boolean) : null;
      const partial = objN?.type === 'object' && objN.namedChildren.some(p => p.type === 'spread_element');
      const replaced = /spyOn$/.test(how) ? /^mock(Implementation|ReturnValue|ResolvedValue|RejectedValue)(Once)?$/.test(node.parent?.type === 'member_expression' ? node.parent.childForFieldName('property').text : '') : true;
      ts.mockCalls.push({ fn: from, file: rel, line, how, spec: strOf(args[0]), obj: /spyOn$/.test(how) ? args[0]?.text : null, prop: /spyOn$/.test(how) ? strOf(args[1]) : null,
        keys: partial ? keys : null, replaced, module, locals: ctx.locals, types: ctx.types });
    }
    // an inline route handler (`app.get('/x', (req, res) => …)`) is a symbol named for its route
    const routeArg = fnNode.type === 'member_expression' && ROUTE_REG.test(fnNode.childForFieldName('property').text) ? args[0] : null;
    const routeName = routeArg && (routeArg.type === 'string' || routeArg.type === 'template_string') && strOf(routeArg) != null
      ? `${fnNode.childForFieldName('property').text.toUpperCase()} ${strOf(routeArg).replace(/:(\w+)/g, '{$1}')}` : null;
    // `r.route(path).get(h).post(h2)`: down the chain of method calls to the `.route(path)` they hang off
    let routeChain = null;
    if (fnNode.type === 'member_expression' && ROUTE_REG.test(fnNode.childForFieldName('property').text)) {
      let o = fnNode.childForFieldName('object');
      while (o?.type === 'call_expression' && o.childForFieldName('function').type === 'member_expression' && ROUTE_REG.test(o.childForFieldName('function').childForFieldName('property').text))
        o = o.childForFieldName('function').childForFieldName('object');
      const f = o?.type === 'call_expression' ? o.childForFieldName('function') : null;
      if (f?.type === 'member_expression' && f.childForFieldName('property').text === 'route') {
        const a0 = o.childForFieldName('arguments').namedChildren[0];
        routeChain = { owner: f.childForFieldName('object').text, path: a0 ? ir(a0) : null, s: strOf(a0) };
      }
    }
    const handlerName = routeName || (routeChain?.s != null ? `${fnNode.childForFieldName('property').text.toUpperCase()} ${routeChain.s.replace(/:(\w+)/g, '{$1}')}` : null);
    const info = args.map(argInfo);
    // a handler named for its route still runs from here when no rule pack claims the call as a route (the call's index)
    if (handlerName) args.forEach((a, i) => { if (FUNC.has(a.type)) { info[i].fnId = defineFn(a, handlerName, ctx, { extra: { noBind: true } });
      ts.handed.push({ from, to: info[i].fnId, line, file: rel, how: expr, call: ts.rawCalls.length }); } });
    const obj = fnNode.type === 'member_expression' ? fnNode.childForFieldName('object') : null;
    ts.rawCalls.push({ from, module, file: rel, expr, line, attr: obj ? fnNode.childForFieldName('property').text : null, obj: obj?.text ?? null,
      objCall: obj?.type === 'call_expression' ? { expr: obj.childForFieldName('function').text, args: (obj.childForFieldName('arguments')?.namedChildren || []).map(argInfo) } : null,
      objNew: obj?.type === 'new_expression' ? obj.childForFieldName('constructor').text : null, ...(routeChain ? { routeChain } : {}),
      locals: ctx.locals, types: ctx.types, consts: ctx.consts, cls: ctx.cls, guards: ctx.guards, onFailure: ctx.onFailure, top: !ctx.fn, args: info });
    for (const [i, a] of args.entries()) if ((a.type === 'identifier' || a.type === 'member_expression') && !/^(this|undefined|null)$/.test(a.text))
      ts.handed.push({ from, name: a.text, line, file: rel, callee: expr, argIndex: i, call: ts.rawCalls.length - 1, module, locals: ctx.locals, types: ctx.types, cls: ctx.cls });
    if (fnNode.type !== 'identifier' && fnNode.type !== 'member_expression') visit(fnNode, ctx);
    else if (obj) visit(obj, ctx);
    args.forEach((a, i) => { if (!info[i].fnId) visit(a, ctx); });
  }
  function visitFnBody(f, ctx) { const b = f.childForFieldName('body'); if (!b) return; if (b.type === 'statement_block') visitBlock(b, ctx); else visit(b, ctx); }

  function jsx(node, ctx) {
    const nameN = node.type === 'jsx_element' ? node.childForFieldName('open_tag')?.childForFieldName('name') : node.childForFieldName('name');
    const open = node.type === 'jsx_element' ? node.childForFieldName('open_tag') : node;
    if (M.importsRouter) jsxRoute(node);
    if (nameN && /^[A-Z]/.test(nameN.text.split('.').pop()) && nameN.text !== 'Route')
      ts.rawCalls.push({ from: ctx.fn || MOD, module, file: rel, expr: nameN.text, line: node.startPosition.row + 1, attr: null, obj: null, jsx: true,
        locals: ctx.locals, types: ctx.types, consts: ctx.consts, cls: ctx.cls, guards: ctx.guards, onFailure: ctx.onFailure, top: !ctx.fn, args: [] });
    for (const a of open?.namedChildren.filter(x => x.type === 'jsx_attribute') || []) {
      const v = a.namedChildren[1]?.type === 'jsx_expression' ? a.namedChildren[1].namedChildren[0] : null;
      if (v && (v.type === 'identifier' || v.type === 'member_expression') && /^on[A-Z]|^(action|loader|onSubmit|handler)$/.test(a.namedChildren[0].text))
        ts.handed.push({ from: ctx.fn || MOD, name: v.text, line: a.startPosition.row + 1, file: rel, callee: `<${nameN?.text || '>'} ${a.namedChildren[0].text}>`, jsx: true, module, locals: ctx.locals, types: ctx.types, cls: ctx.cls });
    }
  }

  function visit(node, ctx) {
    switch (node.type) {
      case 'comment': return;
      case 'statement_block': visitBlock(node, ctx); return;
      case 'import_statement': addImport(node); return;
      case 'export_statement': addExport(node, ctx); return;
      case 'function_declaration': case 'generator_function_declaration': {
        const n = node.childForFieldName('name');
        return defineFn(node, n ? n.text : 'default', ctx, { counts: !!n });
      }
      case 'class_declaration': case 'abstract_class_declaration': {
        const n = node.childForFieldName('name');
        return defineClass(node, n ? n.text : 'default', ctx, !!n);
      }
      case 'class':   // a class expression anywhere else (`register(class Foo {…})`): its methods are still symbols
        return defineClass(node, node.childForFieldName('name')?.text || 'class', ctx, false);
      case 'lexical_declaration': case 'variable_declaration': {
        let id = null; for (const d of node.namedChildren.filter(c => c.type === 'variable_declarator')) id = declarator(d, ctx) || id;
        return id;
      }
      case 'expression_statement': {
        const e = node.namedChildren[0];
        if (e?.type === 'assignment_expression') { assignment(e, ctx); return; }
        break;
      }
      case 'if_statement': {
        const c = cond(node);
        if (!ctx.fn && /require\.main\s*===?\s*module|import\.meta\.main\b|import\.meta\.url\s*===?.*process\.argv\[1\]|process\.argv\[1\].*===?\s*import\.meta\.url|fileURLToPath\(\s*import\.meta\.url\s*\)\s*===?\s*process\.argv\[1\]/.test(c)) {
          const id = `${module}:<main>`, start = node.startPosition.row + 1, end = node.endPosition.row + 1;
          ts.symbols.set(id, { id, group, kind: 'main', file: rel, start, end, name: '<main>', module, lang, text: spanText(start, end) });
          ts.mains.push(id);
          visit(node.childForFieldName('consequence'), { ...ctx, fn: id, qual: '<main>', locals: new Map(ctx.locals), types: new Map(), consts: new Map(ctx.consts), guards: [] });
          return;
        }
        visit(node.childForFieldName('condition'), ctx);
        const g0 = ctx.guards || [];
        visit(node.childForFieldName('consequence'), { ...ctx, guards: [...g0, { text: c, neg: false }] });
        const alt = node.childForFieldName('alternative');
        if (alt) visit(alt, { ...ctx, guards: [...g0, { text: c, neg: true }] });
        return;
      }
      case 'catch_clause':
        for (const c of node.namedChildren) visit(c, { ...ctx, onFailure: 'catch' + (node.childForFieldName('parameter') ? ` (${node.childForFieldName('parameter').text})` : '') });
        return;
      case 'return_statement': noteReturn(node.namedChildren[0], ctx); break;
      case 'call_expression': call(node, ctx); return;
      case 'new_expression': {
        const ctor = node.childForFieldName('constructor');
        const argsN = node.childForFieldName('arguments');
        ts.rawCalls.push({ from: ctx.fn || MOD, module, file: rel, expr: ctor.text, line: node.startPosition.row + 1, attr: null, obj: null, isNew: true,
          locals: ctx.locals, types: ctx.types, consts: ctx.consts, cls: ctx.cls, guards: ctx.guards, onFailure: ctx.onFailure, top: !ctx.fn,
          args: (argsN?.namedChildren || []).filter(a => a.type !== 'comment').map(argInfo) });
        if (ctor.type !== 'identifier' && ctor.type !== 'member_expression') visit(ctor, ctx);   // `new (class extends X {…})()`
        if (argsN) visit(argsN, ctx);
        return;
      }
      case 'jsx_element': case 'jsx_self_closing_element': jsx(node, ctx); break;
      case 'array':
        if ((M.importsRouter) && isRouteTable(node) && !node.parent?.type?.startsWith('pair')) { routeObjects(node, '', 'react-router.object'); }
        break;
      case 'member_expression': case 'subscript_expression': {
        const m = ENV.exec(node.text) || ENV_SUB.exec(node.text);
        if (m) {
          const p = node.parent;
          const dflt = p?.type === 'binary_expression' && /^(\?\?|\|\|)$/.test(p.childForFieldName('operator')?.text) && p.childForFieldName('left')?.id === node.id ? strOf(p.childForFieldName('right')) : null;
          // a read that tests the env names it a guard key
          ts.envReads.push({ key: m[1], file: rel, line: node.startPosition.row + 1, group, ...(dflt != null ? { default: dflt } : {}), via: node.text.startsWith('import.meta') ? 'import.meta.env' : 'process.env' });
          return;
        }
        break;
      }
    }
    for (const c of node.namedChildren) visit(c, ctx);
  }
  function assignment(e, ctx) {
    const l = e.childForFieldName('left'), r = e.childForFieldName('right');
    const lt = l.text;
    if (/^module\.exports$/.test(lt)) {
      M.cjsExports = true;
      if (r.type === 'identifier') M.defaultExport = { local: r.text, cjs: true };
      else if (r.type === 'object') { const mem = defineObject(r, 'module.exports', { ...ctx, fn: null }); for (const [k, v] of mem) M.exports.set(k, typeof v === 'string' ? { id: v } : v); M.defaultExport = { cjsObject: true }; }
      else if (FUNC.has(r.type)) M.defaultExport = { id: defineFn(r, r.childForFieldName('name')?.text || 'module.exports', ctx, {}), cjs: true };
      else if (r.type === 'class') M.defaultExport = { id: defineClass(r, r.childForFieldName('name')?.text || 'module.exports', ctx, false), cjs: true };
      else { const req = requireOf(r); if (req) M.starExports.push(req.source); else visit(r, ctx); }
      return;
    }
    const ex = /^(?:module\.)?exports\.(\w+)$/.exec(lt);
    if (ex) {
      M.cjsExports = true;
      if (r.type === 'identifier') M.exports.set(ex[1], { local: r.text });
      else if (FUNC.has(r.type)) M.exports.set(ex[1], { id: defineFn(r, ex[1], ctx, { extra: { noBind: false } }) });
      else if (r.type === 'class') M.exports.set(ex[1], { id: defineClass(r, r.childForFieldName('name')?.text || ex[1], ctx, false) });
      else { const req = requireOf(r); if (req) M.exports.set(ex[1], req); else visit(r, ctx); }
      return;
    }
    if (l.type === 'member_expression' && l.childForFieldName('object').type === 'this' && ctx.cls) {
      const nm = l.childForFieldName('property').text;
      const spec = valueSpec(r) || (r.type === 'identifier' && ctx.types.get(r.text)) || null;
      addAttr(ctx.cls, nm, spec, ctx);
    }
    if (l.type === 'identifier' && ctx.fn) { const s = valueSpec(r); if (s) { ctx.types.set(l.text, s); if (ctx.outerTypes && !ctx.declared?.has(l.text)) ctx.outerTypes.set(l.text, s); if (s.t !== 'annot') (ts.fnAssigns.get(ctx.fn) || ts.fnAssigns.set(ctx.fn, new Map()).get(ctx.fn)).set(l.text, { ...s, guards: ctx.guards, module, locals: ctx.locals, types: ctx.types }); } }
    if (FUNC.has(r.type)) { defineFn(r, lt.replace(/^this\./, ''), ctx, { extra: { noBind: true } }); visit(l, ctx); return; }
    visit(l, ctx); visit(r, ctx);
  }

  visitBlock(root, { fn: null, qual: null, cls: null, inClass: false, locals: new Map(), types: new Map(), consts: new Map(), guards: [], onFailure: null, describe: null });
  ts.defScopes += quals.size;
}

/* ---------------- module resolution (graphify's order, extractors/resolution.py) ---------------- */

const stripJsonc = t => t.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, m => m.startsWith('"') ? m : '').replace(/,(\s*[}\]])/g, '$1');
const parseJsonc = t => { try { return JSON.parse(stripJsonc(t)); } catch { return null; } };

export function tsModuleResolver({ files, readText }) {
  const fileSet = new Set(files);
  const dirs = new Set(); for (const f of fileSet) { let d = posix.dirname(f); while (d !== '.' && !dirs.has(d)) { dirs.add(d); d = posix.dirname(d); } }
  const norm = p => { const n = posix.normalize(p); return n === '.' ? '' : n.replace(/^\.\//, ''); };
  const probe = cand => {
    cand = norm(cand);
    if (cand.startsWith('..')) return null;
    if (fileSet.has(cand)) return cand;
    const ext = posix.extname(cand);
    if (/^\.(js|jsx|mjs|cjs)$/.test(ext)) for (const t of { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }[ext])
      if (fileSet.has(cand.slice(0, -ext.length) + t)) return cand.slice(0, -ext.length) + t;
    for (const e of EXTS) if (fileSet.has(cand + e)) return cand + e;
    if (dirs.has(cand) || cand === '') for (const i of INDEX) { const p = cand ? `${cand}/${i}` : i; if (fileSet.has(p)) return p; }
    return null;
  };
  const read = rel => { try { return readText(rel); } catch { return null; } };
  // the nearest tsconfig.json / jsconfig.json up from a dir, with `extends` followed (relative ones only)
  const configMemo = new Map();
  function configFor(dir) {
    if (configMemo.has(dir)) return configMemo.get(dir);
    let found = null;
    for (let d = dir; ; d = posix.dirname(d)) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) { const p = d === '.' || d === '' ? name : `${d}/${name}`; const t = read(p); if (t != null) { found = loadConfig(p, new Set()); break; } }
      if (found || d === '.' || d === '') break;
    }
    configMemo.set(dir, found);
    return found;
  }
  function loadConfig(p, seen) {
    if (seen.has(p)) return null; seen.add(p);
    const j = parseJsonc(read(p) || ''); if (!j) return null;
    const dir = posix.dirname(p) === '.' ? '' : posix.dirname(p);
    let out = { paths: {}, baseUrl: null };
    const ext = typeof j.extends === 'string' && j.extends.startsWith('.') ? norm(posix.join(dir, j.extends.endsWith('.json') ? j.extends : `${j.extends}.json`)) : null;
    if (ext) { const b = loadConfig(ext, seen); if (b) out = { paths: { ...b.paths }, baseUrl: b.baseUrl }; }
    const co = j.compilerOptions || {};
    if (typeof co.baseUrl === 'string') out.baseUrl = norm(posix.join(dir, co.baseUrl));
    if (co.paths && typeof co.paths === 'object') { const base = out.baseUrl ?? dir; for (const [k, v] of Object.entries(co.paths)) if (Array.isArray(v)) out.paths[k] = v.map(t => norm(posix.join(base, t))); }
    return out;
  }
  // workspace packages: a package.json with a name, mapped to its directory and entry fields
  const packages = new Map();
  for (const f of files.length ? [...new Set([...fileSet].map(f => posix.dirname(f)))].concat(['.']) : ['.']) {
    let d = f; while (true) { const p = d === '.' ? 'package.json' : `${d}/package.json`; if (!packages.has(p)) { const j = parseJsonc(read(p) || ''); packages.set(p, j); } if (d === '.') break; d = posix.dirname(d); }
  }
  const byName = new Map(); for (const [p, j] of packages) if (j?.name) byName.set(j.name, { dir: posix.dirname(p) === '.' ? '' : posix.dirname(p), j });
  const hasConfigAnywhere = dir => !!configFor(dir);
  const memo = new Map();
  function resolveModule(spec, fromRel) {
    const key = spec + '\0' + fromRel;
    if (memo.has(key)) return memo.get(key);
    let r = null;
    const dir = posix.dirname(fromRel) === '.' ? '' : posix.dirname(fromRel);
    if (spec.startsWith('.')) r = probe(posix.join(dir, spec));
    else if (spec.startsWith('/')) r = null;
    else {
      const cfg = configFor(dir);
      if (cfg) {
        let best = null;
        for (const [pat, targets] of Object.entries(cfg.paths)) {
          let spec2 = null, score = null;
          if (pat.includes('*')) { const [pre, suf] = pat.split('*'); if (spec.startsWith(pre) && spec.endsWith(suf) && spec.length >= pre.length + suf.length) { spec2 = spec.slice(pre.length, spec.length - suf.length); score = [1, -pre.length]; } }
          else if (spec === pat) { spec2 = ''; score = [0, -pat.length]; }
          if (score && (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1]))) best = { score, spec2, targets };
        }
        if (best) for (const t of best.targets) { const hit = probe(t.replace('*', best.spec2)); if (hit) { r = hit; break; } }
        if (!r && !best && cfg.baseUrl != null) r = probe(posix.join(cfg.baseUrl, spec));
      }
      if (!r) {   // a workspace package
        const parts = spec.split('/'), name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0], sub = spec.slice(name.length + 1);
        const pkg = byName.get(name);
        if (pkg) {
          const at = p => probe(pkg.dir ? `${pkg.dir}/${p}` : p);
          if (sub) r = at(sub) || at(`src/${sub}`);
          else for (const f of [pkg.j.source, pkg.j.module, pkg.j.main, pkg.j.types, 'src/index', 'index']) if (typeof f === 'string' && (r = at(f.replace(/^\.\//, '')))) break;
        }
      }
      if (!r && spec.startsWith('@/') && !hasConfigAnywhere(dir)) {   // the unmapped `@/` -> src/ convention
        let anchor = dir; while (anchor && !packages.get(`${anchor}/package.json`)) anchor = posix.dirname(anchor) === '.' ? '' : posix.dirname(anchor);
        r = probe(posix.join(anchor, 'src', spec.slice(2))) || probe(posix.join(anchor, spec.slice(2)));
      }
    }
    memo.set(key, r);
    return r;
  }
  return { resolveModule, packages: byName };
}

/* ---------------- name, member and receiver resolution ---------------- */

export function tsResolverFor(ts, mods) {
  const { modules, classes, symbols } = ts;
  const { resolveModule } = mods;
  const isCls = id => typeof id === 'string' && classes.has(id);
  function noteUnresolvedImport(spec, from) { if (!spec.startsWith('.')) return; const k = `${from}\0${spec}`; ts.unresolvedImports.set(k, { from, spec }); }
  // what a module exports under a name: { id } | { module } | { obj } | { var } | { ext } | null
  function exportOf(rel, name, depth = 0) {
    const M = modules.get(rel);
    if (!M || depth > 8) return null;
    if (name === '*') return M.defaultExport?.cjs && !M.exports.size ? local(M, M.defaultExport, depth) : { module: rel };
    if (name === 'default') {
      if (M.defaultExport && !M.defaultExport.cjsObject) return local(M, M.defaultExport, depth);
      return M.cjsExports ? { module: rel } : null;
    }
    const e = M.exports.get(name);
    if (e) return local(M, e, depth);
    for (const s of M.starExports) { const t = resolveModule(s, rel); const r = t && exportOf(t, name, depth + 1); if (r) return r; }
    if (M.defaultExport?.cjs) { const d = local(M, M.defaultExport, depth); if (d?.id && isCls(d.id)) { const sm = lookup(d.id, name); if (sm) return { id: sm }; } }
    return null;
  }
  function local(M, e, depth) {
    if (e.id) return { id: e.id };
    if (e.source) { const t = resolveModule(e.source, M.file); if (!t) { noteUnresolvedImport(e.source, M.file); return { ext: e.source + (e.name && e.name !== '*' && e.name !== 'default' ? '.' + e.name : '') }; } return exportOf(t, e.name, depth + 1); }
    if (e.local) return resolveName(e.local, { module: M.file, locals: null }, depth + 1);
    return null;
  }
  function resolveName(name, c, depth = 0) {
    if (depth > 10) return null;
    if (c.locals && c.locals.has(name)) return { id: c.locals.get(name) };
    const M = modules.get(c.module);
    if (!M) return null;
    if (M.defs.has(name)) return { id: M.defs.get(name) };
    if (M.objects.has(name)) return { obj: M.objects.get(name), in: c.module, name };
    if (M.imports.has(name)) {
      const t = M.imports.get(name), target = resolveModule(t.source, c.module);
      if (!target) { noteUnresolvedImport(t.source, c.module); return { ext: t.source + (t.name !== '*' && t.name !== 'default' ? '.' + t.name : '') }; }
      return exportOf(target, t.name, depth + 1) || { missing: `${target}:${t.name}` };
    }
    if (M.vars.has(name)) return { var: M.vars.get(name), in: c.module, name };
    return null;
  }
  const resolveExpr = (expr, c) => {   // `K`, `ns.K`, `obj.member`
    if (!expr) return null;
    const parts = expr.split('.');
    let r = resolveName(parts[0], c);
    for (const p of parts.slice(1)) {
      if (!r) return null;
      if (r.module) r = exportOf(r.module, p);
      else if (r.obj) { const m = r.obj.get(p); r = m ? (typeof m === 'string' ? { id: m } : resolveName(m.local, { module: r.in, locals: null })) : null; }
      else if (r.ext) r = { ext: `${r.ext}.${p}` };
      else if (r.id && isCls(r.id)) { const m = lookup(r.id, p); r = m ? { id: m } : null; }
      else return null;
    }
    return r;
  };
  for (const k of classes.values()) {
    k.bases = k.baseExprs.map(b => resolveExpr(b, k.scope)?.id).filter(isCls);
    k.implementsIds = k.implementsExprs.map(b => resolveExpr(b, k.scope)?.id).filter(isCls);
  }
  const subclasses = new Map();
  for (const k of classes.values()) for (const b of [...k.bases, ...k.implementsIds]) (subclasses.get(b) || subclasses.set(b, []).get(b)).push(k.id);
  const mro = (id, seen = new Set()) => seen.has(id) ? [] : (seen.add(id), [id, ...(classes.get(id)?.bases || []).flatMap(b => mro(b, seen))]);
  function lookup(clsId, m) { for (const c of mro(clsId)) { const x = classes.get(c)?.methods.get(m); if (x) return x; } return null; }
  const overrides = (clsId, m, out = [], seen = new Set()) => { for (const s of subclasses.get(clsId) || []) { if (seen.has(s)) continue; seen.add(s);
    const x = classes.get(s).methods.get(m); if (x) out.push(x); overrides(s, m, out, seen); } return out; };

  const retMemo = new Map(), returnsOf = new Map();
  for (const r of ts.returns) (returnsOf.get(r.fn) || returnsOf.set(r.fn, []).get(r.fn)).push(r);
  function factoryReturns(fnId, depth = 0) {
    if (retMemo.has(fnId)) return retMemo.get(fnId);
    if (depth > 3) return [];
    retMemo.set(fnId, []);
    const out = [];
    const via = (spec, sc, guards, line) => {
      const r = resolveExpr(spec.expr, sc);
      if (spec.t === 'new') { if (r?.id && isCls(r.id)) out.push({ cls: r.id, guards, line }); else if (r?.ext) out.push({ ext: r.ext, guards, line }); return; }
      if (r?.id && symbols.get(r.id)?.kind !== 'class') for (const x of factoryReturns(r.id, depth + 1)) out.push({ ...x, guards: [...guards, ...x.guards], via: r.id });
    };
    for (const ret of returnsOf.get(fnId) || []) {
      if (ret.kind === 'new' || ret.kind === 'call') via({ t: ret.kind, expr: ret.expr }, ret, ret.guards, ret.line);
      else { const a = ts.fnAssigns.get(fnId)?.get(ret.name); if (a) via(a, a, [...a.guards, ...ret.guards], ret.line); }
    }
    retMemo.set(fnId, out);
    return out;
  }
  const byReturns = fnId => { const fr = factoryReturns(fnId).filter(x => x.cls); const cs = [...new Set(fr.map(x => x.cls))];
    return cs.length ? { mode: cs.length === 1 ? 'ctor' : 'factory', factory: fnId, cls: cs, returns: fr } : null; };
  function receiverOf(spec, sc) {
    if (!spec) return null;
    const r = resolveExpr(spec.expr, sc);
    if (spec.t === 'new') return r?.id && isCls(r.id) ? { mode: 'ctor', cls: [r.id] } : null;
    if (spec.t === 'annot') return r?.id && isCls(r.id) ? { mode: 'annot', cls: [r.id] } : null;
    if (spec.t === 'call' && r?.id && symbols.get(r.id)?.kind !== 'class') return byReturns(r.id);
    return null;
  }
  function attrReceiver(clsId, attr) {
    for (const c of mro(clsId)) { const specs = classes.get(c)?.attrTypes.get(attr); if (!specs) continue;
      const cls = [], facts = [];
      for (const s of specs) { const rc = receiverOf(s, s); if (rc) { cls.push(...rc.cls); facts.push({ mode: rc.mode, cls: rc.cls, factory: rc.factory }); } }
      if (cls.length) { const narrowed = facts.filter(f => f.mode !== 'annot');
        return { mode: narrowed.length && narrowed.length === facts.length ? (new Set(cls).size === 1 ? 'ctor' : 'factory') : narrowed.length ? 'mixed' : 'annot', cls: [...new Set(cls)], facts }; }
    }
    return null;
  }
  return { resolveModule, exportOf, resolveName, resolveExpr, mro, lookup, overrides, subclasses, factoryReturns, receiverOf, attrReceiver };
}

export function addTsEdge(ts, from, to, kind, line, extra = {}) {
  if (!from || !to || from === to) return;
  const e = { from, to, kind, line, ...extra };
  const gf = ts.groupOf(from), gt = ts.groupOf(to);
  if (gf && gt && gf !== gt) e.groups = [gf, gt];
  ts.edges.push(e);
}

const BUILTINS = new Set(['console', 'Math', 'JSON', 'Object', 'Array', 'Promise', 'String', 'Number', 'Boolean', 'Date', 'RegExp', 'Error', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Symbol', 'BigInt', 'Reflect', 'Proxy', 'Intl', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask', 'structuredClone', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'fetch', 'require', 'process', 'window', 'document', 'globalThis', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController',
  'Response', 'Request', 'Headers', 'FormData', 'Blob', 'alert', 'confirm', 'localStorage', 'sessionStorage', 'navigator', 'location', 'history',
  'super', 'import', 'Function', 'eval', 'atob', 'btoa', 'TypeError', 'RangeError', 'expect', 'describe', 'it', 'test', 'jest', 'vi', 'module', 'exports']);
// callees that look at a function rather than run it: assertions, mock helpers, logging
const NOT_RUN = /^(expect|assert(\.\w+)?|(jest|vi)\.\w+|console\.\w+|JSON\.stringify|Object\.\w+|typeof)$|^expect\(/;
const CFG_GUARD = /process\.env|import\.meta\.env|\bconfig\.|\bsettings\.|\benv\.|isProd|isDev|NODE_ENV/;

/* resolve every recorded call into edges. `skipHanded`: calls whose function arguments a rule pack has claimed
   (an Express route registration hands its handlers to the router, not to the caller) */
export function resolveTsCalls(ts, R, { skipHanded = new Set() } = {}) {
  const { classes, symbols } = ts;
  const noteMiss = (c, head) => {
    const r = head && !/[(<]/.test(head) ? R.resolveName(head, c) : null;
    // a variable counts where its value comes from: an external library's object is an external call
    const v = r?.var || (c.types?.get(head)) || null;
    const vr = v && R.resolveExpr(v.expr, v.module ? v : c);
    if (v && vr?.ext) ts.unresolved.external++;
    else if (v && !vr) ts.unresolved.local++;
    else if (r && (r.id || r.module || r.missing || r.obj || r.var)) ts.unresolved.inRepo++;
    else if (r?.ext) ts.unresolved.external++;
    else if (BUILTINS.has(head)) ts.unresolved.builtin++;
    else ts.unresolved.local++;
  };
  const targetOf = r => r?.id ? r.id : null;
  for (const c of ts.rawCalls) {
    const cg = (c.guards || []).filter(g => CFG_GUARD.test(g.text));
    const extra = { ...(cg.length ? { cfg: cg.map(g => (g.neg ? 'not ' : '') + g.text.replace(/\s+/g, ' ')) } : {}), ...(c.onFailure ? { onFailure: c.onFailure } : {}) };
    const add = (to, kind, more = {}) => addTsEdge(ts, c.from, to, kind, c.line, { ...more, ...extra });
    const ctorOf = (clsId, more = {}) => { add(clsId, 'ctor', more); const init = R.lookup(clsId, 'constructor'); if (init) add(init, 'ctor', more); };
    if (c.jsx || c.isNew) {
      const r = R.resolveExpr(c.expr, c);
      const id = targetOf(r);
      if (id && classes.has(id)) { ctorOf(id, c.jsx ? { jsx: true } : {}); if (c.jsx) { const render = R.lookup(id, 'render'); if (render) add(render, 'static', { jsx: true, recvClass: id }); } ts.callStats.resolved++; }
      else if (id && symbols.get(id) && c.jsx) { add(id, 'static', { jsx: true }); ts.callStats.resolved++; }
      else { ts.callStats.unresolvedName++; noteMiss(c, c.expr.split('.')[0]); }
      continue;
    }
    if (!c.attr) {
      const r = c.expr.includes('(') ? null : R.resolveExpr(c.expr, c);
      const id = targetOf(r);
      if (id && !classes.has(id)) { add(id, 'static'); ts.callStats.resolved++; }
      else { ts.callStats.unresolvedName++; noteMiss(c, c.expr.split('.')[0]); }
      continue;
    }
    let clsId = null, recv = null;
    if (c.obj === 'super' && c.cls) {
      let target = null; for (const k of R.mro(c.cls).slice(1)) { target = classes.get(k)?.methods.get(c.attr); if (target) break; }
      if (target) { add(target, 'static', { passCtx: true, super: true }); ts.callStats.resolved++; } else ts.callStats.unresolvedAttr++;
      continue;
    }
    if (c.obj === 'this' && c.cls) { clsId = c.cls; recv = { mode: 'self' }; }
    else if (c.objNew) { const r = R.resolveExpr(c.objNew, c); if (r?.id && classes.has(r.id)) { clsId = r.id; recv = { mode: 'ctor', cls: [r.id] }; } }
    else if (c.types && c.types.has(c.obj)) { const rc = R.receiverOf(c.types.get(c.obj), c); if (rc) { recv = rc; clsId = rc.cls[0]; } }
    else if (c.objCall) { const rc = R.receiverOf({ t: 'call', expr: c.objCall.expr }, c); if (rc) { recv = rc; clsId = rc.cls[0]; } }
    else if (/^this\.[\w$]+$/.test(c.obj) && c.cls) { const ar = R.attrReceiver(c.cls, c.obj.slice(5)); if (ar) { recv = ar; clsId = ar.cls[0]; } }
    else if (/^[\w$]+$/.test(c.obj)) { const r = R.resolveName(c.obj, c); if (r?.var) { const rc = R.receiverOf(r.var, r.var); if (rc) { recv = rc; clsId = rc.cls[0]; } } }
    if (clsId) {
      const site = `${c.from}@${c.line}:${c.attr}`;
      if (recv.mode === 'self') {
        const target = R.lookup(clsId, c.attr);
        if (target) add(target, 'static', { self: c.attr, site });
        for (const o of R.overrides(clsId, c.attr)) add(o, 'virtual', { self: c.attr, site, evidence: `override of ${c.attr} in subclass` });
        if (target || R.overrides(clsId, c.attr).length) { ts.callStats.resolved++; continue; }
      } else if (recv.mode === 'ctor') {
        const target = R.lookup(clsId, c.attr);
        if (target) { add(target, 'static', { recvClass: clsId, site }); ts.callStats.resolved++; continue; }
      } else if (recv.mode === 'annot') {
        const target = R.lookup(clsId, c.attr), ov = R.overrides(clsId, c.attr);
        if (target) add(target, 'static');
        for (const o of ov) add(o, 'virtual', { evidence: `override of ${c.attr} in subclass`, site });
        if (target || ov.length) { ts.callStats.resolved++; continue; }
      } else {
        const narrowed = [...new Set(recv.cls.map(k => R.lookup(k, c.attr)).filter(Boolean))];
        if (narrowed.length) { for (const t of narrowed) add(t, narrowed.length === 1 ? 'static' : 'dispatch', { site, narrowedBy: recv.factory || 'class-attr', recvClass: narrowed.length === 1 ? recv.cls[0] : undefined });
          ts.callStats.resolved++; continue; }
      }
    }
    const r = /^[\w$.]+$/.test(c.obj) ? R.resolveExpr(`${c.obj}.${c.attr}`, c) : null;
    if (r?.id && !classes.has(r.id)) { add(r.id, 'static'); ts.callStats.resolved++; continue; }
    ts.callStats.unresolvedAttr++;
    noteMiss(c, /^[\w$]+/.exec(c.obj || '')?.[0]);
  }
  /* a function handed to a call or a JSX event prop runs from there: the caller links to it */
  for (const h of ts.handed) {
    if (h.call != null && skipHanded.has(h.call)) continue;
    if (h.to) { addTsEdge(ts, h.from, h.to, 'static', h.line, { rule: 'js.callback', evidence: `${h.file}:${h.line} hands ${symbols.get(h.to)?.name} to ${h.how}` }); continue; }
    if (NOT_RUN.test(h.callee)) continue;
    const r = h.name.startsWith('this.') && h.cls ? { id: R.lookup(h.cls, h.name.slice(5)) } : R.resolveExpr(h.name, h);
    const s = r?.id && symbols.get(r.id);
    if (!s || (s.kind !== 'function' && s.kind !== 'method')) continue;
    addTsEdge(ts, h.from, r.id, 'static', h.line, { rule: 'js.callback', evidence: `${h.file}:${h.line} hands ${h.name} to ${h.callee}` });
  }
}

/* language conventions that make an entry: `if (require.main === module)` and its ESM spellings */
export function tsEntries(ts) {
  return ts.mains.map(m => ({ kind: 'main', id: m, file: ts.symbols.get(m).file, line: ts.symbols.get(m).start, rule: 'js.main' }));
}

/* const folding (B15): a URL-ish expression to a string, `{}` for what cannot be known. Identifiers are followed to a
   local or module-level const, through imports; `process.env.X ?? '/api'` folds to its default, naming the key */
export function foldString(ts, R, node, scope, depth = 0, acc = { folded: [], env: [] }) {
  const unknown = { s: '{}', acc };
  if (!node || depth > 12) return unknown;
  const go = (n, sc) => foldString(ts, R, n, sc, depth + 1, acc).s;
  switch (node.k) {
    case 'str': return { s: node.v, acc };
    case 'tpl': return { s: node.parts.map(p => go(p, scope)).join(''), acc };
    case 'cat': return { s: go(node.l, scope) + go(node.r, scope), acc };
    case 'or': { const l = go(node.l, scope); return { s: l.includes('{}') ? go(node.r, scope) : l, acc }; }
    case 'env': acc.env.push(node.key); return unknown;
    case 'id': {
      const local = scope.consts?.get(node.name);
      if (local) { acc.folded.push(node.name); return { s: go(local, scope), acc }; }
      const found = constOf(ts, R, node.name, scope.module);
      if (found) { acc.folded.push(node.name); return { s: go(found.ir, { module: found.module, consts: null }), acc }; }
      return unknown;
    }
    case 'member': {
      if (node.obj.k !== 'id') return unknown;
      const base = scope.consts?.get(node.obj.name) ? { ir: scope.consts.get(node.obj.name), module: scope.module } : constOf(ts, R, node.obj.name, scope.module);
      const v = base?.ir?.k === 'obj' ? base.ir.pairs[node.prop] : null;
      if (v) { acc.folded.push(`${node.obj.name}.${node.prop}`); return { s: go(v, { module: base.module, consts: null }), acc }; }
      return unknown;
    }
    default: return unknown;
  }
}
// a module-level const by name as seen from a module: its own, or an imported one followed to where it is defined
export function constOf(ts, R, name, module, depth = 0) {
  const M = ts.modules.get(module);
  if (!M || depth > 6) return null;
  if (M.consts.has(name)) return { ir: M.consts.get(name), module };
  const t = M.imports.get(name);
  if (!t) return null;
  const target = R.resolveModule(t.source, module);
  if (!target) return null;
  const T = ts.modules.get(target);
  const e = t.name === 'default' ? T?.defaultExport : T?.exports.get(t.name);
  if (e?.local) return constOf(ts, R, e.local, target, depth + 1);
  if (e?.source) { const t2 = R.resolveModule(e.source, target); return t2 ? constOf(ts, R, e.name, t2, depth + 1) : null; }
  if (!e) for (const s of T?.starExports || []) { const t2 = R.resolveModule(s, target); const r = t2 && constOf(ts, R, name, t2, depth + 1); if (r) return r; }
  return null;
}
