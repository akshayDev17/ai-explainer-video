/* The C and C++ adapter: one visitor for both grammars (a C file is read by tree-sitter-c, a C++ file and a header
   that holds C++ by tree-sitter-cpp), then name, member and function-pointer resolution into the same typed edges the
   other adapters write. Rule packs (../rules/c-handlers.mjs, gtest.mjs) read the same facts and add links on top.

   Ids: a module is the file's repo-relative path (`src/cart.c`); a symbol is `<file>:<name>` with namespaces and
   classes joined by `.` (`<file>:shop.Cart.add`), in the file that defines it (an out-of-line `Cart::add` is in its
   .cpp file); a class or struct is `<file>:<ns>.<Name>` where its body is. A gtest `TEST(Suite, Name)` is
   `<file>:Suite.Name`, a Catch2 `TEST_CASE("title")` `<file>:title`.

   Resolution rules (design rev3 §3.14, C and C++ rows):
   - C linkage is global: a bare call names a function defined in the same file (a `static` one included), else the
     one non-static definition of that name in the repo, preferring the files the caller's includes name (a header and
     the source file beside it); a `static` one elsewhere is seen only from the files whose includes reach it; a quoted `#include` resolves beside the including file (as graphify does), else to
     the one repo file whose path ends with it (an `-I` directory); a system include is external;
   - C++ names: the enclosing class's members (an implicit `this->`), then the enclosing namespaces outward, `using
     namespace` directives, then the global namespace; `ns::f()` and `K::m()` are qualified;
   - members: `obj.m()` / `obj->m()` where obj is typed by a declaration (`K obj(…)`, `K* p`, `auto x = new K` /
     `std::make_unique<K>` / `K(…)` / a call's declared return type), a parameter, a field of the enclosing class
     (`store_->get()`), or `this`; `std::unique_ptr<K>` / `shared_ptr<K>` / references unwrap to K; a value built
     here is its concrete class (`static`), a declared one is read through the class hierarchy: a `static` edge to
     the method plus a `virtual` edge to each override in a subclass (a pure virtual `= 0` method is abstract);
   - constructors: `new K`, `K obj(…)`, `K obj{…}`, `K(…)` and make_unique / make_shared give `ctor` edges to the class
     and to its constructor;
   - function pointers: a struct field or variable that holds functions (`.run = cmd_run`, `ops->open = f`) dispatches
     a call through it (`c->run(…)`) to every function assigned to that field anywhere (`dispatch`, c.fn-pointer);
   - a function named as an argument (`qsort(…, cmp)`, `pthread_create(…, worker, …)`) runs from there (c.callback);
     `signal(SIGINT, h)` / `sa.sa_handler = h` make h an entry, not a callback;
   - a call under `#ifdef X` / `#if X` carries that build guard, one under an `if (getenv(…))` its config guard; a
     call in a `catch` is labelled "on failure"; an ALL_CAPS call is a macro, counted as a builtin. */
import { posix } from 'node:path';

export const C_LANGS = new Set(['c', 'cpp']);
// a .h header holds C++ when it says so; otherwise it is read as C
export const headerLang = text => /^\s*(class|namespace|template\s*<)\b|^\s*(public|private|protected)\s*:|\bstd::|^\s*#\s*include\s*<(iostream|string|vector|memory|map|unordered_map|functional)>/m.test(text) ? 'cpp' : 'c';

export function newCModel() {
  return {
    symbols: new Map(), classes: new Map(), modules: new Map(),
    rawCalls: [], handed: [], returns: [], mains: [], tables: [], fnFields: [], signals: [], envReads: [], refs: new Map(),
    edges: [], callStats: { resolved: 0, unresolvedName: 0, unresolvedAttr: 0 },
    unresolved: { inRepo: 0, external: 0, builtin: 0, local: 0 }, externalImports: new Map(), unresolvedIncludes: [],
    defNodes: 0, defsVisited: 0, defScopes: 0,
    groupOf: null,   // id -> group across every language; set by mine.mjs before edges are added
  };
}

/* ---------------- plain-data IR ---------------- */

const SMART = /^(std::)?(unique_ptr|shared_ptr|weak_ptr|optional|reference_wrapper)$/;
// a type node -> { k: 'name', name: 'ns::K' } (pointers, references, const and smart pointers unwrapped) | { k: 'other' }
export function cType(t) {
  if (!t) return { k: 'other' };
  switch (t.type) {
    case 'type_identifier': return { k: 'name', name: t.text };
    case 'struct_specifier': case 'class_specifier': case 'union_specifier': { const n = t.childForFieldName('name'); return n ? { k: 'name', name: n.text } : { k: 'other' }; }
    case 'qualified_identifier': {
      const inner = t.childForFieldName('name');
      if (inner?.type === 'template_type') { const r = templateType(inner, t.text.split('<')[0]); if (r) return r; }
      return { k: 'name', name: t.text.replace(/<.*$/s, '') };
    }
    case 'template_type': return templateType(t, t.childForFieldName('name').text) || { k: 'name', name: t.childForFieldName('name').text };
    case 'type_descriptor': return cType(t.childForFieldName('type'));
    case 'primitive_type': case 'sized_type_specifier': return { k: 'other', prim: t.text };
    default: return { k: 'other' };
  }
}
function templateType(t, name) {
  if (!SMART.test(name.replace(/^::/, ''))) return null;
  const arg = t.childForFieldName('arguments')?.namedChildren[0];
  return arg ? cType(arg) : null;
}
const unquote = n => n.namedChildren.filter(c => c.type === 'string_content' || c.type === 'escape_sequence').map(c => c.text).join('');
export const cStr = n => n?.type === 'string_literal' ? unquote(n) : n?.type === 'concatenated_string' ? n.namedChildren.map(cStr).join('') : null;
export function cIr(n, depth = 0) {
  if (!n || depth > 10) return { k: 'unknown' };
  switch (n.type) {
    case 'identifier': return { k: 'id', name: n.text };
    case 'qualified_identifier': return { k: 'id', name: n.text.replace(/<[^<>]*>/g, '') };
    case 'this': return { k: 'this' };
    case 'field_expression': return { k: 'sel', obj: cIr(n.childForFieldName('argument'), depth + 1), field: n.childForFieldName('field').text, arrow: n.childForFieldName('operator')?.text === '->' };
    case 'call_expression': {
      const f = n.childForFieldName('function');
      const tf = f?.type === 'qualified_identifier' ? f.childForFieldName('name') : f;
      if (tf?.type === 'template_function' && /^(make_unique|make_shared)$/.test(tf.childForFieldName('name').text))
        return { k: 'new', type: cType(tf.childForFieldName('arguments')?.namedChildren[0]) };
      return { k: 'call', fn: cIr(f, depth + 1) };
    }
    case 'template_function': return { k: 'id', name: n.childForFieldName('name').text };
    case 'new_expression': return { k: 'new', type: cType(n.childForFieldName('type')) };
    case 'pointer_expression': return cIr(n.childForFieldName('argument'), depth + 1);
    case 'parenthesized_expression': return cIr(n.namedChildren[0], depth + 1);
    case 'subscript_expression': return { k: 'idx', obj: cIr(n.childForFieldName('argument'), depth + 1) };
    case 'cast_expression': return { k: 'new', type: cType(n.childForFieldName('type')), cast: true };
    case 'string_literal': case 'concatenated_string': return { k: 'str', v: cStr(n) };
    case 'lambda_expression': return { k: 'fn' };
    default: return { k: 'unknown' };
  }
}

/* ---------------- extraction ---------------- */

const TEST_MACRO = /^(TEST|TEST_F|TEST_P|TYPED_TEST|TYPED_TEST_P)$/;
const CATCH_MACRO = /^(TEST_CASE|SCENARIO|TEST_CASE_METHOD|TEMPLATE_TEST_CASE)$/;
const declName = d => {   // the identifier a (possibly pointer / reference / array / function) declarator names
  for (let x = d; x; x = x.childForFieldName('declarator') || (/^(reference_declarator|parenthesized_declarator)$/.test(x.type) ? x.namedChildren.at(-1) : null)) {
    if (/^(identifier|field_identifier|type_identifier)$/.test(x.type)) return x.text;
    if (x.type === 'qualified_identifier' || x.type === 'destructor_name' || x.type === 'operator_name') return x.text;
  }
  return null;
};
// a definition's name, or (macro-heavy code tree-sitter cannot read cleanly, a template specialisation) its declarator's text
const nameOf = d => declName(d) ?? (d ? d.text.replace(/<[^<>]*>/g, '').replace(/[^\w~]+/g, '_').replace(/^_+|_+$/g, '') || 'anonymous' : 'anonymous');
const fnDeclarator = d => { for (let x = d; x; x = x.childForFieldName('declarator') || (x.type === 'parenthesized_declarator' ? x.namedChildren[0] : null)) if (x.type === 'function_declarator') return x; return null; };
const isPtrDecl = d => { for (let x = d; x; x = x.childForFieldName('declarator')) if (/^(pointer_declarator|reference_declarator)$/.test(x.type)) return true; return false; };

export function extractCFile(cm, rel, root, group, text, lang) {
  const module = rel;
  const M = { file: rel, group, lang, includes: [], defs: new Map(), vars: new Map(), usingNs: [] };
  cm.modules.set(module, M);
  const lines = text.split('\n');
  const spanText = (a, b) => lines.slice(a - 1, b).join('\n');
  const MOD = `${module}:<module>`;
  const quals = new Set();
  const uniqueId = q => { let id = `${module}:${q}`, i = 2; while (cm.symbols.has(id)) id = `${module}:${q}#${i++}`; return id; };
  const join = (...xs) => xs.filter(Boolean).join('.');

  // definitions the self-check expects: function bodies and named (or typedef-named) class / struct / union bodies
  const isTypeBody = n => n.childForFieldName('body') && (n.childForFieldName('name') || n.parent?.type === 'type_definition');
  const counted = root.descendantsOfType(['function_definition', 'struct_specifier', 'class_specifier', 'union_specifier'])
    .filter(n => n.type === 'function_definition' ? !!fnDeclarator(n.childForFieldName('declarator')) : isTypeBody(n));
  cm.defNodes += counted.length;

  for (const inc of root.descendantsOfType('preproc_include')) {
    const p = inc.childForFieldName('path'), line = inc.startPosition.row + 1;
    if (p?.type === 'system_lib_string') { const h = p.text.slice(1, -1); M.includes.push({ path: h, system: true, line }); if (!cm.externalImports.has(h)) cm.externalImports.set(h, rel); }
    else if (p?.type === 'string_literal') M.includes.push({ path: unquote(p), system: false, line });
  }

  const params = list => (list?.namedChildren || []).filter(p => /parameter_declaration$/.test(p.type))
    .map(p => ({ name: declName(p.childForFieldName('declarator')), type: cType(p.childForFieldName('type')) }));

  function defineFn(node, name, ctx, { cls = null, clsQual = null, kind, counts = true, extra = {} } = {}) {
    if (counts) cm.defsVisited++;
    const q = ctx.fn ? `${ctx.qual}.<locals>.${name}` : join(...ctx.ns, clsQual, name);
    const id = uniqueId(q);
    quals.add(q);
    const start = node.startPosition.row + 1, end = node.endPosition.row + 1;
    const fd = fnDeclarator(node.childForFieldName('declarator'));
    const ps = params(fd?.childForFieldName('parameters'));
    const isStatic = node.namedChildren.some(c => c.type === 'storage_class_specifier' && c.text === 'static');
    const sym = { id, group, kind: kind || (clsQual ? 'method' : 'function'), file: rel, start, end, name: join(clsQual, name), module, lang, cls,
      decos: [...(isStatic ? ['static'] : []), ...(extra.decos || [])], params: ps.map(p => p.name).filter(Boolean), paramTypes: ps.map(p => p.type),
      result: cType(node.childForFieldName('type')), ns: ctx.ns, clsQual, text: spanText(start, end), ...(extra.sym || {}) };
    cm.symbols.set(id, sym);
    if (!clsQual && !ctx.fn) M.defs.set(join(...ctx.ns, name), id);
    // a TEST_F body runs as a member of its fixture class
    const inner = { ...ctx, fn: id, qual: q, clsQual: extra.bodyCls || clsQual || ctx.clsQual, cls: extra.bodyCls ? null : cls || ctx.cls, types: new Map(), guards: ctx.guards || [], onFailure: null, refs: new Set() };
    ps.forEach(p => { if (p.name) inner.types.set(p.name, { t: 'annot', type: p.type }); });
    for (const fi of node.descendantsOfType('field_initializer').filter(x => x.parent?.parent?.id === node.id)) for (const a of fi.namedChildren) if (a.type === 'argument_list') visit(a, inner);
    const body = node.childForFieldName('body');
    if (body) visit(body, inner);
    cm.refs.set(id, inner.refs);
    return id;
  }

  function defineClass(node, ctx, nameOverride) {
    cm.defsVisited++;
    const name = nameOverride || node.childForFieldName('name').text.replace(/<.*$/s, '');
    const q = join(...ctx.ns, ctx.clsQual, name);
    const id = uniqueId(q); quals.add(q);
    const start = node.startPosition.row + 1, end = node.endPosition.row + 1;
    const bases = (node.namedChildren.find(c => c.type === 'base_class_clause')?.namedChildren || []).filter(c => c.type !== 'access_specifier').map(c => cType(c)).filter(t => t.k === 'name');
    const k = { id, module, name, qual: q, ns: ctx.ns, file: rel, line: start, baseExprs: bases.map(b => b.name), baseTypes: bases, methods: new Map(), fields: new Map(),
      fnPtrFields: new Set(), fieldOrder: [], virtuals: new Set(), pure: new Set(), decos: [], lang };
    cm.classes.set(id, k);
    cm.symbols.set(id, { id, group, kind: 'class', file: rel, start, end, name: join(ctx.clsQual, name), module, lang, decos: [], text: spanText(start, end) });
    const cctx = { ...ctx, clsQual: join(ctx.clsQual, name), cls: id };
    for (const m of node.childForFieldName('body').namedChildren) {
      if (m.type === 'function_definition' || (m.type === 'template_declaration' && m.namedChildren.some(c => c.type === 'function_definition'))) {
        const fdef = m.type === 'function_definition' ? m : m.namedChildren.find(c => c.type === 'function_definition');
        const fd = fnDeclarator(fdef.childForFieldName('declarator')); if (!fd) continue;
        const nm = nameOf(fd.childForFieldName('declarator'));
        if (fdef.children.some(c => c.type === 'virtual') || fd.namedChildren.some(c => c.type === 'virtual_specifier')) k.virtuals.add(nm);
        k.methods.set(nm, defineFn(fdef, nm, cctx, { cls: id, clsQual: cctx.clsQual }));
      } else if (m.type === 'field_declaration') {
        const fd = fnDeclarator(m.childForFieldName('declarator'));
        if (fd) {   // a method declared here; a pure virtual one (`= 0`) is abstract, and gets a symbol of its own
          const nm = declName(fd.childForFieldName('declarator'));
          if (!nm) continue;
          const isVirtual = m.children.some(c => c.type === 'virtual') || fd.namedChildren.some(c => c.type === 'virtual_specifier');
          if (isVirtual) k.virtuals.add(nm);
          if (m.childForFieldName('default_value')?.text === '0') {
            k.pure.add(nm);
            const mid = uniqueId(join(...ctx.ns, cctx.clsQual, nm)), ms = m.startPosition.row + 1;
            cm.symbols.set(mid, { id: mid, group, kind: 'method', file: rel, start: ms, end: m.endPosition.row + 1, name: join(cctx.clsQual, nm), module, lang, cls: id,
              decos: ['abstractmethod'], params: [], paramTypes: [], result: cType(m.childForFieldName('type')), ns: ctx.ns, clsQual: cctx.clsQual, text: spanText(ms, m.endPosition.row + 1) });
            k.methods.set(nm, mid);
          }
          // a C function-pointer field: `int (*run)(int, char **)`
          if (fd.childForFieldName('declarator')?.type === 'parenthesized_declarator') { k.fnPtrFields.add(nm); k.fieldOrder.push(nm); k.fields.set(nm, { k: 'other', fnPtr: true }); }
          continue;
        }
        for (const d of m.childrenForFieldName('declarator')) { const nm = declName(d); if (!nm) continue; k.fieldOrder.push(nm); k.fields.set(nm, cType(m.childForFieldName('type')));
          if (/std::function|function</.test(m.childForFieldName('type')?.text || '')) k.fnPtrFields.add(nm); }
        const inner = m.childForFieldName('type');
        if (inner && /^(struct|class|union)_specifier$/.test(inner.type) && inner.childForFieldName('body') && inner.childForFieldName('name')) defineClass(inner, cctx);
      } else if (m.type === 'declaration' && /^MOCK_(CONST_)?METHOD\d*$/.test(fnDeclarator(m.childForFieldName('declarator'))?.childForFieldName('declarator')?.text || '')) {
        // gmock: MOCK_METHOD(ret, name, (args), (override)) — the mock overrides `name`
        const fd = fnDeclarator(m.childForFieldName('declarator'));
        const ps = fd.childForFieldName('parameters').namedChildren;
        const macro = fd.childForFieldName('declarator').text;
        const nm = (macro === 'MOCK_METHOD' ? ps[1] : ps[0])?.text.trim().replace(/^\w+\s+/, '');
        if (!nm || !/^\w+$/.test(nm)) continue;
        const mid = uniqueId(join(...ctx.ns, cctx.clsQual, nm)), ms = m.startPosition.row + 1;
        cm.symbols.set(mid, { id: mid, group, kind: 'method', file: rel, start: ms, end: m.endPosition.row + 1, name: join(cctx.clsQual, nm), module, lang, cls: id,
          decos: ['mock'], params: [], paramTypes: [], result: { k: 'other' }, ns: ctx.ns, clsQual: cctx.clsQual, text: spanText(ms, m.endPosition.row + 1) });
        k.methods.set(nm, mid); k.virtuals.add(nm); k.mocked = true;
      } else if (/^(struct|class|union)_specifier$/.test(m.type) && m.childForFieldName('body') && m.childForFieldName('name')) defineClass(m, cctx);
      else visitClassMembers(m, cctx, k);   // templates, friends, preprocessor blocks, what a parse error left
    }
    return id;
  }
  function visitClassMembers(node, cctx, k) {
    for (const c of node.namedChildren) {
      if (/^(struct|class|union)_specifier$/.test(c.type) && c.childForFieldName('body') && c.childForFieldName('name')) defineClass(c, cctx);
      else if (c.type === 'function_definition') { const fd = fnDeclarator(c.childForFieldName('declarator')); if (fd) { const nm = nameOf(fd.childForFieldName('declarator')); k.methods.set(nm, defineFn(c, nm, cctx, { cls: k.id, clsQual: cctx.clsQual })); } }
      else if (c.type === 'type_definition' && /^(struct|class|union)_specifier$/.test(c.childForFieldName('type')?.type) && c.childForFieldName('type').childForFieldName('body'))
        defineClass(c.childForFieldName('type'), cctx, c.childForFieldName('type').childForFieldName('name')?.text || nameOf(c.childForFieldName('declarator')));
      else visitClassMembers(c, cctx, k);
    }
  }

  // a table row: string keys and function names, positionally or by designated field
  const rowOf = il => il.namedChildren.map((e, i) => {
    if (e.type === 'initializer_pair') { const v = e.childForFieldName('value'); return { field: e.childForFieldName('designator')?.text.replace(/^\./, '').replace(/^\[|\]$/g, ''), ...cell(v), i }; }
    return { ...cell(e), i };
  });
  const cell = v => { const s = cStr(v); if (s != null) return { str: s };
    const x = v?.type === 'pointer_expression' ? v.childForFieldName('argument') : v;
    if (x?.type === 'identifier' || x?.type === 'qualified_identifier') return { ref: x.text };
    if (x?.type === 'lambda_expression') return { lambda: x };
    return { other: true }; };

  function declaration(node, ctx) {
    const type = node.childForFieldName('type'), tIr = cType(type);
    if (type && /^(struct|class|union)_specifier$/.test(type.type) && type.childForFieldName('body') && type.childForFieldName('name')) defineClass(type, ctx);
    for (const d of node.childrenForFieldName('declarator')) {
      if (d.type === 'function_declarator') continue;   // a prototype
      const init = d.type === 'init_declarator' ? d : null;
      const dn = init ? init.childForFieldName('declarator') : d;
      const name = declName(dn), value = init?.childForFieldName('value'), line = node.startPosition.row + 1;
      if (!name) { if (value) visit(value, ctx); continue; }
      const isArray = dn?.type === 'array_declarator' || dn?.childForFieldName?.('declarator')?.type === 'array_declarator';
      const auto = type?.type === 'placeholder_type_specifier';
      let spec = null;
      if (!auto && tIr.k === 'name') spec = { t: value?.type === 'argument_list' || value?.type === 'initializer_list' || (!value && !isPtrDecl(dn)) ? 'new' : 'annot', type: tIr };
      else if (value && value.type !== 'initializer_list' && value.type !== 'argument_list') { const ir = cIr(value); spec = ir.k === 'new' ? { t: 'new', type: ir.type } : { t: 'expr', ir }; }
      // `K obj(…)`, `K obj{…}`, `K obj;` construct a C++ object; a C struct declaration runs nothing
      if (lang === 'cpp' && spec?.t === 'new' && !isPtrDecl(dn) && tIr.k === 'name' && !auto && (ctx.fn || value)) cm.rawCalls.push(ctorCall(tIr.name, ctx, line, value));
      if (ctx.fn) { if (spec) ctx.types.set(name, spec); }
      else if (spec) M.vars.set(name, { ...spec, module, line, ns: ctx.ns });
      // a table: an array of rows, or a map initialised with { {"key", fn}, … }
      if (value?.type === 'initializer_list' && (isArray || /map\b|map</.test(type?.text || ''))) {
        const rows = value.namedChildren.filter(r => r.type === 'initializer_list').map(r => ({ line: r.startPosition.row + 1, cells: rowOf(r) }));
        if (rows.some(r => r.cells.some(x => x.str != null) && r.cells.some(x => x.ref || x.lambda))) {
          for (const r of rows) for (const x of r.cells) if (x.lambda) { const key = r.cells.find(y => y.str != null)?.str; x.fnId = defineFn(x.lambda, `${name}[${JSON.stringify(key ?? r.line).replace(/:/g, "-")}]`, ctx, { counts: false }); delete x.lambda; }
          cm.tables.push({ name, var: ctx.fn ? `${ctx.fn}#${name}` : `${module}#${name}`, module, file: rel, line, elemType: type?.type === 'struct_specifier' ? type.childForFieldName('name')?.text : tIr.name, map: !isArray, rows, ns: ctx.ns });
          continue;
        }
      }
      if (value?.type === 'initializer_list') noteFnFields(value, tIr, ctx);
      if (value) visit(value, ctx);
    }
  }
  // `struct ops o = { .open = f }`, and `{ f, g }` by field position: the functions each field holds
  function noteFnFields(il, tIr, ctx) {
    il.namedChildren.forEach((e, i) => {
      if (e.type === 'initializer_list') { noteFnFields(e, tIr, ctx); return; }
      const v = e.type === 'initializer_pair' ? e.childForFieldName('value') : e;
      const c = cell(v);
      if (c.ref) cm.fnFields.push({ field: e.type === 'initializer_pair' ? e.childForFieldName('designator')?.text.replace(/^\./, '') : null, index: i, type: tIr.name, ref: c.ref, module, line: e.startPosition.row + 1, ns: ctx.ns });
    });
  }
  const ctorCall = (typeName, ctx, line, value) => ({ from: ctx.fn || MOD, module, file: rel, line, isNew: true, type: typeName, types: ctx.types, cls: ctx.cls, clsQual: ctx.clsQual, ns: ctx.ns,
    guards: ctx.guards, onFailure: ctx.onFailure, args: [], value: value?.type || null });

  const argInfo = a => ({ type: a.type, ir: cIr(a), text: a.text.length > 200 ? a.text.slice(0, 200) : a.text, str: cStr(a) });
  function call(node, ctx) {
    const fnNode = node.childForFieldName('function');
    const args = (node.childForFieldName('arguments')?.namedChildren || []).filter(a => a.type !== 'comment');
    const from = ctx.fn || MOD, line = node.startPosition.row + 1, expr = fnNode.text;
    const ir = cIr(node);
    if (ir.k === 'new') { cm.rawCalls.push(ctorCall(ir.type.name, ctx, line, null)); args.forEach(a => visit(a, ctx)); return; }
    if (/^(getenv|secure_getenv|std::getenv)$/.test(expr) && cStr(args[0]) != null) cm.envReads.push({ key: cStr(args[0]), file: rel, line, group, via: 'getenv' });
    if (/^(signal|std::signal)$/.test(expr) && args[1]) cm.signals.push({ sig: args[0]?.text, ref: args[1].text.replace(/^&/, ''), module, file: rel, line, ns: ctx.ns });
    const attr = fnNode.type === 'field_expression' ? fnNode.childForFieldName('field').text : null;
    cm.rawCalls.push({ from, module, file: rel, expr, line, attr, obj: attr ? cIr(fnNode.childForFieldName('argument')) : null, fn: attr ? null : cIr(fnNode),
      fnType: fnNode.type, types: ctx.types, cls: ctx.cls, clsQual: ctx.clsQual, ns: ctx.ns, guards: ctx.guards, onFailure: ctx.onFailure, top: !ctx.fn, args: args.map(argInfo) });
    if (/^(signal|std::signal)$/.test(expr)) { args.forEach(a => visit(a, ctx)); return; }
    if (/^(EXPECT_CALL|ON_CALL)$/.test(expr)) { if (args[0]) visit(args[0], ctx); return; }   // gmock: the second argument is a matcher, not a call
    const index = cm.rawCalls.length - 1;
    for (const [i, a] of args.entries()) {
      const x = a.type === 'pointer_expression' && a.childForFieldName('operator')?.text === '&' ? a.childForFieldName('argument') : a;
      if (x.type === 'identifier' || x.type === 'qualified_identifier') cm.handed.push({ from, ref: x.text, line, file: rel, callee: expr, argIndex: i, call: index, module, types: ctx.types, cls: ctx.cls, clsQual: ctx.clsQual, ns: ctx.ns });
    }
    if (attr) visit(fnNode.childForFieldName('argument'), ctx);
    else if (!/^(identifier|qualified_identifier|template_function)$/.test(fnNode.type)) visit(fnNode, ctx);
    for (const a of args) visit(a, ctx);
  }

  const condText = n => (n.childForFieldName('condition')?.text || '').replace(/^\(|\)$/g, '');
  function visitSeq(children, ctx) {   // statements in order: a Catch2 TEST_CASE is a call followed by its block
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      const ce = c.type === 'expression_statement' ? c.namedChildren[0] : null;
      const head = ce?.type === 'call_expression' ? ce.childForFieldName('function')?.text : null;
      if (head && CATCH_MACRO.test(head) && children[i + 1]?.type === 'compound_statement' && !ctx.fn) {
        const args = ce.childForFieldName('arguments').namedChildren;
        const fixture = head === 'TEST_CASE_METHOD' ? args[0]?.text : null;
        const title = cStr(args.find(a => a.type === 'string_literal')) || head;
        const block = children[i + 1];
        defineTestBlock(c, block, title.replace(/:/g, '-').replace(/\s+/g, ' ').trim(), ctx, { macro: head, fixture, tags: args.filter(a => a.type === 'string_literal').slice(1).map(cStr) });
        i++;
        continue;
      }
      visit(c, ctx);
    }
  }
  // a Catch2 test: its symbol spans the macro line and the block after it
  function defineTestBlock(stmt, block, title, ctx, { macro, fixture, tags }) {
    cm.defsVisited++; cm.defNodes++;
    const q = title, id = uniqueId(q); quals.add(q);
    const start = stmt.startPosition.row + 1, end = block.endPosition.row + 1;
    cm.symbols.set(id, { id, group, kind: 'function', file: rel, start, end, name: title, module, lang, cls: null, decos: [], params: [], paramTypes: [], result: { k: 'other' },
      ns: ctx.ns, clsQual: fixture, test: true, macro, ...(fixture ? { fixture } : {}), ...(tags.length ? { tags } : {}), text: spanText(start, end) });
    const inner = { ...ctx, fn: id, qual: q, clsQual: fixture || ctx.clsQual, types: new Map(), guards: [], onFailure: null, refs: new Set() };
    visit(block, inner);
    cm.refs.set(id, inner.refs);
  }

  function visit(node, ctx) {
    switch (node.type) {
      case 'comment': return;
      case 'translation_unit': case 'declaration_list': case 'compound_statement': visitSeq(node.namedChildren, ctx); return;
      case 'namespace_definition': {
        const n = node.childForFieldName('name'), parts = n ? n.text.split('::').filter(Boolean) : [];
        visit(node.childForFieldName('body'), { ...ctx, ns: [...ctx.ns, ...parts] });
        return;
      }
      case 'using_declaration': { const m = /^using\s+namespace\s+([\w:]+)\s*;/.exec(node.text); if (m) M.usingNs.push(m[1].replace(/::/g, '.')); return; }
      case 'function_definition': {
        const fd = fnDeclarator(node.childForFieldName('declarator'));
        if (!fd) break;
        const dn = fd.childForFieldName('declarator');
        // gtest: TEST(Suite, Name) / TEST_F(Fixture, Name) { … }
        if (!ctx.fn && dn?.type === 'identifier' && TEST_MACRO.test(dn.text)) {
          const ps = fd.childForFieldName('parameters').namedChildren.map(p => p.text.trim());
          const nm = `${ps[0]}.${ps[1]}`;
          const fixture = dn.text !== 'TEST' ? ps[0] : null;
          defineFn(node, nm, ctx, { kind: 'function', extra: { bodyCls: fixture, sym: { test: true, macro: dn.text, ...(fixture ? { fixture, clsQual: fixture } : {}), suite: ps[0], case: ps[1] } } });
          return;
        }
        const full = nameOf(dn);
        const parts = full.replace(/<[^<>]*>/g, '').split('::').filter(Boolean);
        const name = parts.pop(), owner = parts.length ? parts.join('.') : null;
        // an out-of-line member `K::m` (or `ns::K::m`): its class is resolved later by its qualified name
        const id = defineFn(node, name, ctx, owner ? { clsQual: owner } : {});
        if (!owner && name === 'main' && !ctx.fn) cm.mains.push(id);
        return;
      }
      case 'template_declaration': case 'linkage_specification': for (const c of node.namedChildren) visit(c, ctx); return;
      case 'class_specifier': case 'struct_specifier': case 'union_specifier':
        if (node.childForFieldName('body') && node.childForFieldName('name')) { defineClass(node, ctx); return; }
        break;
      case 'type_definition': {   // typedef struct { … } name;
        const t = node.childForFieldName('type');
        if (t && /^(struct|class|union)_specifier$/.test(t.type) && t.childForFieldName('body')) { defineClass(t, ctx, t.childForFieldName('name')?.text || nameOf(node.childForFieldName('declarator'))); return; }
        return;
      }
      case 'declaration': declaration(node, ctx); return;
      case 'field_declaration': declaration(node, ctx); return;   // outside a class body: what a parse error left
      case 'preproc_ifdef': case 'preproc_if': case 'preproc_elif': {
        const nm = node.childForFieldName('name')?.text, c = node.childForFieldName('condition')?.text;
        const neg = node.type === 'preproc_ifdef' && /^#\s*ifndef/.test(node.text);
        const g = { text: nm ? `#if${neg ? 'n' : ''}def ${nm}` : `#if ${c}`, neg: false, build: true };
        const inner = { ...ctx, guards: [...(ctx.guards || []), g] };
        const kids = node.namedChildren.filter(x => x.type !== 'identifier' || x.id !== node.childForFieldName('name')?.id).filter(x => x.id !== node.childForFieldName('condition')?.id && x.id !== node.childForFieldName('alternative')?.id);
        visitSeq(kids, inner);
        const alt = node.childForFieldName('alternative');
        if (alt) visit(alt, { ...ctx, guards: [...(ctx.guards || []), { ...g, neg: true }] });
        return;
      }
      case 'preproc_else': visitSeq(node.namedChildren, ctx); return;
      case 'if_statement': {
        const c = condText(node);
        visit(node.childForFieldName('condition'), ctx);
        const g0 = ctx.guards || [];
        visit(node.childForFieldName('consequence'), { ...ctx, guards: [...g0, { text: c, neg: false }] });
        const alt = node.childForFieldName('alternative');
        if (alt) visit(alt, { ...ctx, guards: [...g0, { text: c, neg: true }] });
        return;
      }
      case 'catch_clause': for (const c of node.namedChildren) visit(c, { ...ctx, onFailure: 'catch' + (node.childForFieldName('parameters') ? ` ${node.childForFieldName('parameters').text}` : '') }); return;
      case 'return_statement': { const v = node.namedChildren[0]; if (v && ctx.fn) { const ir = cIr(v); if (ir.k === 'new' || ir.k === 'call' || ir.k === 'id') cm.returns.push({ fn: ctx.fn, ir, guards: ctx.guards, line: node.startPosition.row + 1, module, types: ctx.types, cls: ctx.cls, clsQual: ctx.clsQual, ns: ctx.ns }); } break; }
      case 'call_expression': call(node, ctx); return;
      case 'new_expression': { const t = cType(node.childForFieldName('type')); if (t.k === 'name') cm.rawCalls.push(ctorCall(t.name, ctx, node.startPosition.row + 1, null)); break; }
      case 'assignment_expression': {
        const l = node.childForFieldName('left'), r = node.childForFieldName('right');
        const rv = r?.type === 'pointer_expression' ? r.childForFieldName('argument') : r;
        // `ops->open = f`, `sa.sa_handler = h`: a function a field holds; `handlers["x"] = f`: a table row
        if (l?.type === 'field_expression' && (rv?.type === 'identifier' || rv?.type === 'qualified_identifier')) {
          const field = l.childForFieldName('field').text;
          if (field === 'sa_handler' || field === 'sa_sigaction') cm.signals.push({ sig: null, ref: rv.text, module, file: rel, line: node.startPosition.row + 1, ns: ctx.ns });
          else cm.fnFields.push({ field, index: null, type: null, ref: rv.text, module, line: node.startPosition.row + 1, ns: ctx.ns, obj: cIr(l.childForFieldName('argument')), types: ctx.types, cls: ctx.cls, clsQual: ctx.clsQual });
        }
        // the index is `index` in C and a `subscript_argument_list` (`indices`) in C++
        const keyOf = sub => { const i = sub.childForFieldName('index') || sub.childForFieldName('indices'); return cStr(i?.type === 'subscript_argument_list' ? i.namedChildren[0] : i); };
        if (l?.type === 'subscript_expression' && keyOf(l) != null && (rv?.type === 'identifier' || rv?.type === 'qualified_identifier' || rv?.type === 'lambda_expression')) {
          const tname = l.childForFieldName('argument').text, key = keyOf(l);
          const fnId = rv.type === "lambda_expression" ? defineFn(rv, `${tname}[${JSON.stringify(key).replace(/:/g, "-")}]`, ctx, { counts: false }) : null;
          cm.tables.push({ name: tname, var: null, module, file: rel, line: node.startPosition.row + 1, map: true, assigned: true, from: ctx.fn, ns: ctx.ns, types: ctx.types,
            rows: [{ line: node.startPosition.row + 1, cells: [{ str: key, i: 0 }, fnId ? { fnId, i: 1 } : { ref: rv.text, i: 1 }] }] });
          if (fnId) return;
        }
        if (ctx.fn && l?.type === 'identifier' && r) { const ir = cIr(r); if (ir.k !== 'unknown') ctx.types.set(l.text, ir.k === 'new' ? { t: 'new', type: ir.type } : { t: 'expr', ir }); }
        break;
      }
      case 'lambda_expression': { const b = node.childForFieldName('body'); if (b) visit(b, ctx); return; }
      case 'identifier': ctx.refs?.add(node.text); return;
    }
    for (const c of node.namedChildren) visit(c, ctx);
  }

  visit(root, { fn: null, qual: null, ns: [], cls: null, clsQual: null, types: new Map(), guards: [], onFailure: null, refs: null });
  cm.defScopes += quals.size;
}

/* ---------------- resolution ---------------- */

export function cResolverFor(cm, { files }) {
  const { classes, symbols, modules } = cm;
  const fileSet = new Set(files);
  // a quoted include: beside the including file (graphify's rule), else the one repo file whose path ends with it
  const bySuffix = new Map();
  const resolveInclude = (spec, from) => {
    const beside = posix.normalize(posix.join(posix.dirname(from), spec));
    if (fileSet.has(beside)) return beside;
    if (!bySuffix.has(spec)) { const hits = files.filter(f => f === spec || f.endsWith('/' + spec)); bySuffix.set(spec, hits.length === 1 ? hits[0] : null); }
    return bySuffix.get(spec);
  };
  // the files a module's includes name, and the sources beside them (`cart.h` -> `cart.c` / `cart.cpp`)
  const near = new Map(), included = new Map();
  for (const M of modules.values()) {
    const set = new Set([M.file]), inc1 = [];
    included.set(M.file, inc1);
    for (const inc of M.includes) if (!inc.system) {
      const f = resolveInclude(inc.path, M.file);
      if (!f) { cm.unresolvedIncludes.push({ from: M.file, include: inc.path, line: inc.line }); continue; }
      inc1.push(f); set.add(f); const stem = f.replace(/\.(h|hh|hpp|hxx)$/, ''); for (const e of ['.c', '.cc', '.cpp', '.cxx']) if (fileSet.has(stem + e)) set.add(stem + e);
    }
    near.set(M.file, set);
  }
  // classes by qualified and short name
  const classByQual = new Map(), classByName = new Map();
  for (const k of classes.values()) { (classByQual.get(k.qual) || classByQual.set(k.qual, []).get(k.qual)).push(k.id); (classByName.get(k.name) || classByName.set(k.name, []).get(k.name)).push(k.id); }
  // the files a module reaches by #include, directly or through another included file
  const reached = new Map();
  const reachOf = f => { if (!reached.has(f)) { const out = new Set([f]), todo = [f];
    while (todo.length) for (const g of included.get(todo.pop()) || []) if (!out.has(g)) { out.add(g); todo.push(g); }
    reached.set(f, out); } return reached.get(f); };
  // the definition of a C function / class nearest the caller: its own file, then what it includes, then the only one;
  // a `static` one only from its own file or a file the caller's includes reach
  const visible = (id, module) => { const s = symbols.get(id);
    return !s || !(s.decos || []).includes('static') || reachOf(module).has(s.file); };
  const pick = (all, module) => { const ids = (all || []).filter(id => visible(id, module)); if (!ids.length) return null; if (ids.length === 1) return ids[0];
    const own = ids.filter(id => symbols.get(id).file === module); if (own.length) return own[0];
    const pub = ids.filter(id => !(symbols.get(id).decos || []).includes('static'));
    const n = pub.filter(id => near.get(module)?.has(symbols.get(id).file)); if (n.length === 1) return n[0];
    return pub.length === 1 ? pub[0] : null; };
  const nsChain = ns => { const out = []; for (let i = ns.length; i >= 0; i--) out.push(ns.slice(0, i)); return out; };
  function classNamed(name, sc) {
    const q = name.replace(/^::/, '').replace(/::/g, '.').replace(/<.*$/s, '');
    for (const ns of nsChain(sc.ns || [])) { const hit = pick(classByQual.get([...ns, q].join('.')), sc.module); if (hit) return hit; }
    for (const u of modules.get(sc.module)?.usingNs || []) { const hit = pick(classByQual.get(`${u}.${q}`), sc.module); if (hit) return hit; }
    return q.includes('.') ? null : pick(classByName.get(q), sc.module);
  }
  // out-of-line methods join their class; a qualifier that names no class names namespaces (`ns::f() { … }`); a class's
  // bases resolve
  for (const s of symbols.values()) if (s.clsQual && !s.cls && s.kind !== 'class') {
    const k = classNamed(s.clsQual, { ns: s.ns, module: s.module });
    if (k) { s.cls = k; s.kind = s.test ? 'function' : 'method'; if (!s.test) classes.get(k).methods.set(s.name.split('.').pop(), s.id); }
    else if (!s.test) { s.ns = [...(s.ns || []), ...s.clsQual.split('.')]; s.name = s.name.split('.').pop(); s.kind = 'function'; s.clsQual = null; }
  }
  // functions by qualified name (C linkage: non-static ones are global)
  const funcs = new Map();
  for (const s of symbols.values()) if (s.kind === 'function' && !s.test && !s.id.includes('<locals>')) {
    const q = [...(s.ns || []), s.name].join('.');
    (funcs.get(q) || funcs.set(q, []).get(q)).push(s.id);
  }
  for (const k of classes.values()) k.bases = k.baseTypes.map(t => classNamed(t.name, { ns: k.ns, module: k.module })).filter(Boolean);
  const subclasses = new Map(); for (const k of classes.values()) for (const b of k.bases) (subclasses.get(b) || subclasses.set(b, []).get(b)).push(k.id);
  const mro = (id, seen = new Set()) => seen.has(id) ? [] : (seen.add(id), [id, ...(classes.get(id)?.bases || []).flatMap(b => mro(b, seen))]);
  const lookup = (clsId, m) => { for (const c of mro(clsId)) { const x = classes.get(c)?.methods.get(m); if (x) return x; } return null; };
  const isVirtual = (clsId, m) => mro(clsId).some(c => classes.get(c)?.virtuals.has(m));
  const overrides = (clsId, m, out = [], seen = new Set()) => { for (const s of subclasses.get(clsId) || []) { if (seen.has(s)) continue; seen.add(s);
    const x = classes.get(s).methods.get(m); if (x) out.push(x); overrides(s, m, out, seen); } return out; };
  const fieldType = (clsId, f) => { for (const c of mro(clsId)) { const t = classes.get(c)?.fields.get(f); if (t) return { t, module: classes.get(c).module, ns: classes.get(c).ns }; } return null; };
  const ctorOf = clsId => { const k = classes.get(clsId); return k ? k.methods.get(k.name) || null : null; };

  // a function by name from a scope: the enclosing namespaces outward, using-directives, then C linkage
  function funcNamed(name, sc) {
    const q = name.replace(/^::/, '').replace(/::/g, '.');
    for (const ns of nsChain(sc.ns || [])) { const hit = pick(funcs.get([...ns, q].join('.')), sc.module); if (hit) return hit; }
    for (const u of modules.get(sc.module)?.usingNs || []) { const hit = pick(funcs.get(`${u}.${q}`), sc.module); if (hit) return hit; }
    return null;
  }
  const scopeCls = sc => sc.cls || (sc.clsQual ? classNamed(sc.clsQual, sc) : null);
  // the type of an expression IR -> { cls, how: 'new' | 'annot' } | { ext } | null
  function typeOf(ir, sc, depth = 0) {
    if (!ir || depth > 8) return null;
    switch (ir.k) {
      case 'new': { const c = ir.type?.k === 'name' ? classNamed(ir.type.name, sc) : null; return c ? { cls: c, how: ir.cast ? 'annot' : 'new' } : ir.type?.name ? { ext: ir.type.name } : null; }
      case 'this': { const c = scopeCls(sc); return c ? { cls: c, how: 'self' } : null; }
      case 'id': {
        const spec = sc.types?.get(ir.name);
        if (spec) return typeOfSpec(spec, sc, depth + 1);
        const own = scopeCls(sc), f = own && fieldType(own, ir.name);   // an implicit this->field
        if (f) return typeOfType(f.t, { ...sc, ns: f.ns, module: f.module });
        for (const M of [modules.get(sc.module)]) { const v = M?.vars.get(ir.name); if (v) return typeOfSpec(v, { ...sc, module: v.module, ns: v.ns }, depth + 1); }
        const g = [...modules.values()].map(M => M.vars.get(ir.name)).find(v => v && v.module !== sc.module);   // an extern global
        return g ? typeOfSpec(g, { ...sc, module: g.module, ns: g.ns }, depth + 1) : null;
      }
      case 'sel': { const o = typeOf(ir.obj, sc, depth + 1); const f = o?.cls && fieldType(o.cls, ir.field); return f ? typeOfType(f.t, { ...sc, ns: f.ns, module: f.module }) : null; }
      case 'call': { const t = calleeOf(ir.fn, sc, depth + 1); const s = t && symbols.get(t);
        if (s?.result?.k === 'name') { const c = classNamed(s.result.name, { ns: s.ns, module: s.module }); if (c) { const fr = factoryReturns(s.id); return fr.length ? { cls: fr[0], how: fr.length === 1 ? 'new' : 'annot', narrow: fr, factory: s.id } : { cls: c, how: 'annot' }; } }
        return null; }
      default: return null;
    }
  }
  const typeOfType = (t, sc) => { if (t?.k !== 'name') return null; const c = classNamed(t.name, sc); return c ? { cls: c, how: 'annot' } : { ext: t.name }; };
  function typeOfSpec(spec, sc, depth) {
    if (spec.t === 'new') { const c = classNamed(spec.type.name, sc); return c ? { cls: c, how: 'new' } : { ext: spec.type.name }; }
    if (spec.t === 'annot') return typeOfType(spec.type, sc);
    if (spec.t === 'expr') return typeOf(spec.ir, sc, depth + 1);
    return null;
  }
  // what a call's function IR names (a function or method id)
  function calleeOf(fn, sc, depth = 0) {
    if (!fn || depth > 8) return null;
    if (fn.k === 'id') {
      const name = fn.name;
      if (name.includes('::')) {   // ns::f, K::m (a static member, or an explicit base call)
        const parts = name.replace(/^::/, '').split('::'), last = parts.pop(), k = classNamed(parts.join('::'), sc);
        if (k) return lookup(k, last);
        return funcNamed(name, sc);
      }
      const own = scopeCls(sc), m = own && lookup(own, name);
      if (m) return m;
      return funcNamed(name, sc);
    }
    if (fn.k === 'sel') { const o = typeOf(fn.obj, sc, depth + 1); return o?.cls ? lookup(o.cls, fn.field) : null; }
    return null;
  }
  const retMemo = new Map(), returnsOf = new Map();
  for (const r of cm.returns) (returnsOf.get(r.fn) || returnsOf.set(r.fn, []).get(r.fn)).push(r);
  // the concrete classes a function returns (`return new Sqlite(…)`, `return std::make_unique<Mem>()`), when there are any
  function factoryReturns(fnId, depth = 0) {
    if (retMemo.has(fnId)) return retMemo.get(fnId);
    if (depth > 3) return [];
    retMemo.set(fnId, []);
    const out = new Set();
    for (const r of returnsOf.get(fnId) || []) {
      if (r.ir.k === 'new' && r.ir.type?.k === 'name' && !r.ir.cast) { const c = classNamed(r.ir.type.name, r); if (c) out.add(c); }
      else if (r.ir.k === 'call') { const t = calleeOf(r.ir.fn, r); if (t) for (const c of factoryReturns(t, depth + 1)) out.add(c); }
    }
    const res = [...out]; retMemo.set(fnId, res); return res;
  }
  // functions assigned to a field anywhere: by designated name, by position in a struct's field order, or by assignment
  const fnByField = new Map();
  for (const f of cm.fnFields) {
    const target = funcNamed(f.ref, f) || null;
    if (!target) continue;
    let field = f.field;
    if (!field && f.type != null && f.index != null) { const k = classNamed(f.type, f); field = k ? classes.get(k).fieldOrder[f.index] : null; }
    if (!field) continue;
    (fnByField.get(field) || fnByField.set(field, new Map()).get(field)).set(target, f);
  }
  return { resolveInclude, near, funcNamed, classNamed, typeOf, calleeOf, lookup, mro, overrides, isVirtual, ctorOf, fieldType, factoryReturns, fnByField, subclasses, scopeCls };
}

export function addCEdge(cm, from, to, kind, line, extra = {}) {
  if (!from || !to || from === to) return;
  const e = { from, to, kind, line, ...extra };
  const gf = cm.groupOf(from), gt = cm.groupOf(to);
  if (gf && gt && gf !== gt) e.groups = [gf, gt];
  cm.edges.push(e);
}

const MACRO = /^[A-Z][A-Z0-9_]*$/;
const CFG_GUARD = /\bgetenv\b|\b(cfg|config|conf|settings|opts|options)\s*(->|\.)|\b(debug|verbose)\b/i;
const NOT_RUN = /^(printf|fprintf|sprintf|snprintf|puts|strcmp|strncmp|strlen|memcpy|memset|free|malloc|calloc|realloc|sizeof|assert|std::\w+)$/;

/* resolve every recorded call into edges; `skipCalls`: calls a rule pack has claimed (a dispatch through a table) */
export function resolveCCalls(cm, R, { skipCalls = new Set() } = {}) {
  const { classes, symbols } = cm;
  const definedNames = new Set([...symbols.values()].map(s => s.name.split('.').pop()));
  const miss = (name, external) => { if (name && MACRO.test(name)) cm.unresolved.builtin++; else if (external) cm.unresolved.external++;
    else if (name && definedNames.has(name)) cm.unresolved.inRepo++; else cm.unresolved.external++; };
  cm.rawCalls.forEach((c, i) => {
    if (skipCalls.has(i)) return;
    const cg = (c.guards || []).filter(g => g.build || CFG_GUARD.test(g.text));
    const extra = { ...(cg.length ? { cfg: cg.map(g => (g.neg ? 'not ' : '') + g.text.replace(/\s+/g, ' ')) } : {}), ...(c.onFailure ? { onFailure: c.onFailure } : {}) };
    const add = (to, kind, more = {}) => addCEdge(cm, c.from, to, kind, c.line, { ...more, ...extra });
    if (c.isNew) {
      const k = R.classNamed(c.type, c);
      if (k) { add(k, 'ctor'); const init = R.ctorOf(k); if (init) add(init, 'ctor'); c.target = k; cm.callStats.resolved++; }
      return;   // a value of a library type (std::string s) is no call
    }
    if (!c.attr) {
      const f = c.fn;
      if (f.k === 'id' && MACRO.test(f.name.split('::').pop())) { cm.unresolved.builtin++; cm.callStats.unresolvedName++; return; }
      if (f.k === 'new') return;
      const own = R.scopeCls(c), m = f.k === 'id' && !f.name.includes('::') && own ? R.lookup(own, f.name) : null;
      if (m) {   // an implicit this->m(): through the receiver's class, like a self-call
        const site = `${c.from}@${c.line}:${f.name}`;
        add(m, 'static', { self: f.name, site });
        if (R.isVirtual(own, f.name)) for (const o of R.overrides(own, f.name)) add(o, 'virtual', { self: f.name, site, evidence: `override of ${f.name} in subclass` });
        c.target = m; cm.callStats.resolved++; return;
      }
      const t = R.calleeOf(f, c);
      if (t) { add(t, 'static'); c.target = t; cm.callStats.resolved++; return; }
      const k = f.k === 'id' ? R.classNamed(f.name, c) : null;   // K(…): a temporary of an in-repo class
      if (k) { add(k, 'ctor'); const init = R.ctorOf(k); if (init) add(init, 'ctor'); c.target = k; cm.callStats.resolved++; return; }
      cm.callStats.unresolvedName++; miss(f.k === 'id' ? f.name.split('::').pop() : null, f.k === 'id' && /^(std|boost)::/.test(f.name));
      return;
    }
    const site = `${c.from}@${c.line}:${c.attr}`;
    const o = R.typeOf(c.obj, c);
    if (o?.cls) {
      const target = R.lookup(o.cls, c.attr);
      if (o.how === 'self') {
        if (target) add(target, 'static', { self: c.attr, site });
        const ov = R.isVirtual(o.cls, c.attr) ? R.overrides(o.cls, c.attr) : [];
        for (const x of ov) add(x, 'virtual', { self: c.attr, site, evidence: `override of ${c.attr} in subclass` });
        if (target || ov.length) { c.target = target; cm.callStats.resolved++; return; }
      } else if (o.narrow?.length > 1) {
        const ts = [...new Set(o.narrow.map(k => R.lookup(k, c.attr)).filter(Boolean))];
        if (ts.length) { for (const t of ts) add(t, ts.length === 1 ? 'static' : 'dispatch', { site, narrowedBy: o.factory }); c.target = ts[0]; cm.callStats.resolved++; return; }
      } else if (o.how === 'new') {
        if (target) { add(target, 'static', { recvClass: o.cls, site }); c.target = target; cm.callStats.resolved++; return; }
      } else {
        const ov = R.isVirtual(o.cls, c.attr) ? R.overrides(o.cls, c.attr) : [];
        if (target) add(target, 'static', { site });
        for (const x of ov) add(x, 'virtual', { site, evidence: `override of ${c.attr} in subclass` });
        if (target || ov.length) { c.target = target; cm.callStats.resolved++; return; }
      }
    }
    // a call through a function-pointer field: every function assigned to that field
    const held = R.fnByField.get(c.attr);
    if (held?.size && !(o?.cls && R.lookup(o.cls, c.attr))) {
      const ts = [...held.keys()];
      for (const t of ts) add(t, ts.length === 1 ? 'static' : 'dispatch', { site, rule: 'c.fn-pointer', evidence: `${c.file}:${c.line} calls through .${c.attr}, which ${ts.length} function${ts.length > 1 ? 's are' : ' is'} assigned to` });
      c.target = ts[0]; cm.callStats.resolved++; return;
    }
    cm.callStats.unresolvedAttr++;
    miss(null, !!o?.ext || !o);
  });
  // a function named as an argument runs from where it was handed (not a signal handler: that is an entry)
  for (const h of cm.handed) {
    if (h.call != null && skipCalls.has(h.call)) continue;
    if (NOT_RUN.test(h.callee) || MACRO.test(h.callee)) continue;
    const t = R.funcNamed(h.ref, h);
    const s = t && symbols.get(t);
    if (!s || s.kind !== 'function') continue;
    addCEdge(cm, h.from, t, 'static', h.line, { rule: 'c.callback', evidence: `${h.file}:${h.line} hands ${h.ref} to ${h.callee}` });
  }
}

/* `main` (not a test file's: that is the test runner, and tests are no entries), and signal handlers */
export function cEntries(cm, R) {
  const out = cm.mains.filter(m => cm.symbols.get(m).group !== 'test').map(m => ({ kind: 'main', id: m, file: cm.symbols.get(m).file, line: cm.symbols.get(m).start, rule: 'c.main' }));
  for (const s of cm.signals) { const id = R.funcNamed(s.ref, s); if (id) out.push({ kind: 'signal', id, key: s.sig || 'sigaction', file: s.file, line: s.line, rule: 'c.signal' }); }
  return out;
}
