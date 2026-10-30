/* The Go adapter: facts per .go file, then package, name, method and interface resolution into the same typed edges
   the Python and TypeScript adapters write. Rule packs (../rules/go-http.mjs, grpc.mjs, go-test.mjs) read the same
   facts and add framework links on top.

   Ids: a module is the file's repo-relative path (`cmd/server/main.go`), so no Go id can meet a Python or TS one; a
   symbol is `<file>:<Func>`, `<file>:<Type>` (where the type is declared) or `<file>:<Type>.<Method>` (where the
   method is declared, which may be another file of the package); a function literal bound to a local variable is
   `<file>:<Func>.<locals>.<name>`.

   Resolution rules (design rev3 §3.14, Go row), the way graphify reads Go (extractors/go.py, extract.py):
   - packages: every file in a directory with the same `package` clause shares one namespace; an import path names a
     directory through the nearest go.mod's `module` line (`<module>/<dir>`), so an import that maps to no repo
     directory is external (the standard library or a dependency), never matched by a bare name; the local name is the
     alias, else the package's own `package` name, else the path's last element (a `/vN` major version dropped);
   - a bare call to a predeclared function (`append`, `len`, `make`, `new`, …) is the builtin, never a same-named
     method; a call of a type (`T(x)`) is a conversion, not a call;
   - methods by receiver: `x.M()` where x is typed by a parameter or receiver, a `var x T`, `x := T{}` / `&T{}` /
     `new(T)`, `x := f()` (f's declared result type), a type assertion `x.(T)`, a struct field (`s.store.Get()`), an
     element of a typed slice or map (`range`, `xs[i]`); methods promoted from embedded fields are found through them;
   - interfaces by method set: a type whose methods (its own and promoted) include every method of an interface, by
     name with as many parameters and results and no clashing predeclared type (`int` for `string`), implements it; a
     call through an interface-typed value is a `static` edge to the interface method (abstract) plus a `virtual` edge
     to each implementation; when the value came from a function whose returns construct concrete types, it is
     narrowed to those (`dispatch`, with each return's branch guards);
   - a function or method value handed to a call (`sort.Slice(xs, less)`, `go worker()`) runs from there
     (`go.callback`), unless a rule pack claims the call (a route registration hands its handler to the router);
   - a call under an `if` that reads config (`os.Getenv`, `cfg.`, `config.`, flags) carries its guard; a call in a
     `defer` or `go` statement says so. */
import { posix } from 'node:path';

export function newGoModel() {
  return {
    symbols: new Map(), classes: new Map(), modules: new Map(), packages: new Map(),
    rawCalls: [], handed: [], returns: [], mains: [], fnAssigns: new Map(), literals: [], envReads: [], testCalls: [], serviceNames: [],
    edges: [], callStats: { resolved: 0, unresolvedName: 0, unresolvedAttr: 0 },
    unresolved: { inRepo: 0, external: 0, builtin: 0, local: 0 }, externalImports: new Map(), unresolvedImports: new Map(),
    defNodes: 0, defsVisited: 0, defScopes: 0,
    groupOf: null,   // id -> group across every language; set by mine.mjs before edges are added
  };
}

/* ---------------- plain-data IR: types and expressions, kept after the tree is freed ---------------- */

const strText = n => n.type === 'raw_string_literal' ? n.text.slice(1, -1)
  : n.namedChildren.filter(c => c.type === 'interpreted_string_literal_content' || c.type === 'escape_sequence').map(c => c.text).join('');
export const goStr = n => n && (n.type === 'interpreted_string_literal' || n.type === 'raw_string_literal') ? strText(n) : null;

export function typeIr(t) {
  if (!t) return { k: 'other' };
  switch (t.type) {
    case 'type_identifier': return { k: 'name', name: t.text };
    case 'qualified_type': return { k: 'qual', pkg: t.childForFieldName('package').text, name: t.childForFieldName('name').text };
    case 'pointer_type': return { k: 'ptr', of: typeIr(t.namedChildren[0]) };
    case 'slice_type': case 'array_type': return { k: 'slice', of: typeIr(t.childForFieldName('element')) };
    case 'map_type': return { k: 'map', of: typeIr(t.childForFieldName('value')) };
    case 'channel_type': return { k: 'chan', of: typeIr(t.childForFieldName('value')) };
    case 'generic_type': return typeIr(t.childForFieldName('type'));
    case 'parenthesized_type': return typeIr(t.namedChildren[0]);
    case 'negated_type': return typeIr(t.namedChildren[0]);
    default: return { k: 'other' };
  }
}
export function goIr(n, depth = 0) {
  if (!n || depth > 10) return { k: 'unknown' };
  switch (n.type) {
    case 'identifier': return { k: 'id', name: n.text };
    case 'selector_expression': return { k: 'sel', obj: goIr(n.childForFieldName('operand'), depth + 1), field: n.childForFieldName('field').text };
    case 'call_expression': {
      const f = n.childForFieldName('function'), args = n.childForFieldName('arguments')?.namedChildren || [];
      if (f.type === 'identifier' && f.text === 'new' && args[0]) return { k: 'lit', type: typeIr(args[0]) };
      return { k: 'call', fn: goIr(f, depth + 1), args: args.slice(0, 3).map(a => goIr(a, depth + 1)) };
    }
    case 'composite_literal': return { k: 'lit', type: typeIr(n.childForFieldName('type')) };
    case 'unary_expression': { const op = n.childForFieldName('operator')?.text; return op === '&' || op === '*' ? goIr(n.childForFieldName('operand'), depth + 1) : { k: 'unknown' }; }
    case 'parenthesized_expression': return goIr(n.namedChildren[0], depth + 1);
    case 'index_expression': return { k: 'idx', obj: goIr(n.childForFieldName('operand'), depth + 1) };
    case 'type_assertion_expression': return { k: 'lit', type: typeIr(n.childForFieldName('type')) };
    case 'type_conversion_expression': return { k: 'lit', type: typeIr(n.childForFieldName('type')) };
    case 'interpreted_string_literal': case 'raw_string_literal': return { k: 'str', v: strText(n) };
    case 'binary_expression': return n.childForFieldName('operator')?.text === '+' ? { k: 'cat', l: goIr(n.childForFieldName('left'), depth + 1), r: goIr(n.childForFieldName('right'), depth + 1) } : { k: 'unknown' };
    case 'func_literal': return { k: 'fn' };
    default: return { k: 'unknown' };
  }
}

/* ---------------- extraction ---------------- */

const PREDECLARED = new Set(['append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'max', 'min', 'new', 'panic',
  'print', 'println', 'real', 'recover']);
const BASIC = new Set(['bool', 'byte', 'complex64', 'complex128', 'error', 'float32', 'float64', 'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'any', 'comparable']);
// a call that registers a route handler, whose function-literal argument is named for its route (`GET /items/{id}`)
const ROUTE_REG = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Handle|HandleFunc|Get|Post|Put|Patch|Delete|Head|Options|Connect|Trace|Method|MethodFunc|Add|Match)$/;
const VERB = { GET: 'GET', POST: 'POST', PUT: 'PUT', PATCH: 'PATCH', DELETE: 'DELETE', HEAD: 'HEAD', OPTIONS: 'OPTIONS', Get: 'GET', Post: 'POST', Put: 'PUT',
  Patch: 'PATCH', Delete: 'DELETE', Head: 'HEAD', Options: 'OPTIONS', Connect: 'CONNECT', Trace: 'TRACE' };
const routeName = (attr, args) => {
  const strs = args.map(goStr);
  if (/^(Method|MethodFunc|Add|Handle)$/.test(attr) && strs[0] && /^[A-Z]+$/.test(strs[0]) && strs[1]?.startsWith('/')) return `${strs[0]} ${strs[1]}`;   // chi Method, echo Add, gin Handle
  const p = strs[0];
  if (p == null) return null;
  const m = /^([A-Z]+)\s+(\S+)$/.exec(p);   // Go 1.22 ServeMux patterns: "GET /items/{id}"
  if (m) return `${m[1]} ${m[2]}`;
  return p.startsWith('/') || /^[\w.-]+\//.test(p) ? `${VERB[attr] || '*'} ${p}` : null;
};

export function extractGoFile(go, rel, root, group, text) {
  const module = rel;
  const dir = posix.dirname(rel) === '.' ? '' : posix.dirname(rel);
  const pkgName = root.namedChildren.find(c => c.type === 'package_clause')?.namedChildren[0]?.text || 'main';
  const M = { file: rel, group, dir, pkg: pkgName, imports: [], dotImports: [], consts: new Map(), lang: 'go' };
  go.modules.set(module, M);
  const pkgKey = `${dir}\0${pkgName}`;
  const P = go.packages.get(pkgKey) || go.packages.set(pkgKey, { key: pkgKey, dir, name: pkgName, files: [], funcs: new Map(), types: new Map(), vars: new Map(), consts: new Map(), aliases: new Map() }).get(pkgKey);
  P.files.push(rel);
  const lines = text.split('\n');
  const spanText = (a, b) => lines.slice(a - 1, b).join('\n');
  const MOD = `${module}:<module>`;
  const quals = new Set();
  const uniqueId = q => { let id = `${module}:${q}`, i = 2; while (go.symbols.has(id)) id = `${module}:${q}#${i++}`; return id; };

  // definitions the self-check expects: functions, methods, named types, a named interface's methods (an anonymous
  // one, `x.(interface{ M() })`, defines nothing)
  const counted = root.descendantsOfType(['function_declaration', 'method_declaration', 'type_spec', 'type_alias', 'method_elem'])
    .filter(n => n.type !== 'method_elem' || (n.parent?.type === 'interface_type' && n.parent.parent?.type === 'type_spec'));
  go.defNodes += counted.length;

  for (const spec of root.descendantsOfType('import_spec')) {
    const path = goStr(spec.childForFieldName('path')); if (path == null) continue;
    const nameN = spec.childForFieldName('name');
    const imp = { path, alias: nameN?.type === 'package_identifier' ? nameN.text : null, dot: nameN?.type === 'dot', blank: nameN?.type === 'blank_identifier', line: spec.startPosition.row + 1 };
    if (imp.dot) M.dotImports.push(imp); else if (!imp.blank) M.imports.push(imp);
    if (!go.externalImports.has(path)) go.externalImports.set(path, rel);
  }

  const params = list => (list?.namedChildren || []).flatMap(p => {
    if (p.type !== 'parameter_declaration' && p.type !== 'variadic_parameter_declaration') return [];
    const t = typeIr(p.childForFieldName('type'));
    const names = p.namedChildren.filter(c => c.type === 'identifier');
    return names.length ? names.map(n => ({ name: n.text, type: p.type === 'variadic_parameter_declaration' ? { k: 'slice', of: t } : t })) : [{ name: null, type: t }];
  });
  const resultsOf = node => { const r = node.childForFieldName('result'); if (!r) return [];
    return r.type === 'parameter_list' ? params(r).map(p => p.type) : [typeIr(r)]; };

  function defineFn(node, name, ctx, { kind = 'function', cls = null, recvType = null, recv = null, counts = true, bind = true } = {}) {
    if (counts) go.defsVisited++;
    const q = ctx.fn ? `${ctx.qual}.<locals>.${name}` : recvType ? `${recvType}.${name}` : name;
    const id = uniqueId(q);
    quals.add(q);
    const start = node.startPosition.row + 1, end = node.endPosition.row + 1;
    const ps = params(node.childForFieldName('parameters'));
    const sym = { id, group, kind, file: rel, start, end, name: recvType && !ctx.fn ? `${recvType}.${name}` : name, module, lang: 'go', cls, decos: [], params: ps.map(p => p.name).filter(Boolean),
      paramTypes: ps.map(p => p.type), results: resultsOf(node), pkg: pkgKey, text: spanText(start, end), ...(recvType && !ctx.fn ? { recvType } : {}) };
    go.symbols.set(id, sym);
    if (!ctx.fn && !recvType && bind) { if (!P.funcs.has(name) || name !== 'init') P.funcs.set(name, id); }
    else if (ctx.fn && bind) ctx.locals.set(name, id);
    const inner = { fn: id, qual: q, locals: new Map(ctx.locals), types: new Map(ctx.types), consts: new Map(ctx.consts), guards: [], onFailure: null, range: null, closure: null, litCount: ctx.litCount };
    if (recv?.name) inner.types.set(recv.name, { t: 'annot', type: recv.type });
    ps.forEach((p, i) => { if (p.name) inner.types.set(p.name, { t: 'annot', type: p.type, ...(ctx.closureOf != null ? { closureOf: ctx.closureOf, argIndex: ctx.closureArg, param: i } : {}) }); });
    const body = node.childForFieldName('body');
    if (body) visit(body, inner);
    return id;
  }

  function defineType(spec) {
    go.defsVisited++;
    const name = spec.childForFieldName('name').text, start = spec.startPosition.row + 1, end = spec.endPosition.row + 1;
    if (spec.type === 'type_alias') { P.aliases.set(name, typeIr(spec.childForFieldName('type'))); return; }
    const id = uniqueId(name); quals.add(name);
    const tn = spec.childForFieldName('type');
    const k = { id, module, name, pkg: pkgKey, file: rel, line: start, iface: tn?.type === 'interface_type', fields: new Map(), embeds: [], methods: new Map(), baseExprs: [], decos: [] };
    go.classes.set(id, k);
    go.symbols.set(id, { id, group, kind: 'class', file: rel, start, end, name, module, lang: 'go', pkg: pkgKey, decos: [], text: spanText(start, end) });
    P.types.set(name, id);
    if (tn?.type === 'struct_type') for (const f of tn.descendantsOfType('field_declaration')) {
      if (f.parent?.parent?.id !== tn.id) continue;   // a nested anonymous struct's fields are not this type's
      const t = typeIr(f.childForFieldName('type')), names = f.namedChildren.filter(c => c.type === 'field_identifier');
      if (names.length) for (const n of names) k.fields.set(n.text, t);
      else { k.embeds.push(t); const base = t.k === 'ptr' ? t.of : t; if (base.name) k.fields.set(base.name, t); k.baseExprs.push(typeText(t)); }
    }
    if (tn?.type === 'interface_type') for (const m of tn.namedChildren) {
      if (m.type === 'method_elem') {
        go.defsVisited++;
        const mn = m.childForFieldName('name').text, mid = uniqueId(`${name}.${mn}`); quals.add(`${name}.${mn}`);
        const ms = m.startPosition.row + 1, me = m.endPosition.row + 1, ps = params(m.childForFieldName('parameters'));
        go.symbols.set(mid, { id: mid, group, kind: 'method', file: rel, start: ms, end: me, name: `${name}.${mn}`, module, lang: 'go', cls: id, decos: ['abstractmethod'],
          params: ps.map(p => p.name).filter(Boolean), paramTypes: ps.map(p => p.type), results: resultsOf(m), pkg: pkgKey, text: spanText(ms, me) });
        k.methods.set(mn, mid);
      } else if (m.type === 'type_elem' && !m.children.some(c => c.type === '|')) {
        for (const c of m.namedChildren) { const t = typeIr(c); if (t.k === 'name' || t.k === 'qual') { k.embeds.push(t); k.baseExprs.push(typeText(t)); } }
      }
    }
  }

  function valueSpecs(names, values, typeN, ctx, line) {
    const declared = typeN ? typeIr(typeN) : null;
    names.forEach((n, i) => {
      const v = values[values.length === 1 && names.length > 1 ? 0 : i];
      const spec = declared ? { t: 'annot', type: declared } : v ? { t: 'expr', ir: goIr(v), index: values.length === 1 && names.length > 1 ? i : 0 } : null;
      if (!spec || n === '_') return;
      if (ctx.fn) { ctx.types.set(n, spec); if (spec.t === 'expr') (go.fnAssigns.get(ctx.fn) || go.fnAssigns.set(ctx.fn, new Map()).get(ctx.fn)).set(n, { ...spec, guards: ctx.guards, module, types: ctx.types }); }
      else P.vars.set(n, { ...spec, module, line });
      const sv = v && goIr(v);
      if (sv && (sv.k === 'str' || sv.k === 'cat' || sv.k === 'id')) (ctx.fn ? ctx.consts : P.consts).set(n, sv);
    });
  }

  function noteReturn(exprs, ctx) {
    if (!ctx.fn || !exprs.length) return;
    const ir = goIr(exprs[0]), line = exprs[0].startPosition.row + 1;
    if (ir.k === 'lit' || ir.k === 'call' || ir.k === 'id') go.returns.push({ fn: ctx.fn, ir, guards: ctx.guards, line, module, types: ctx.types });
  }

  const cond = n => n.childForFieldName('condition')?.text || '';
  function visitBlock(node, ctx) {   // `if err != nil { return }`: an `if` whose body always exits guards what follows
    let guards = ctx.guards;
    const stmts = node.type === 'block' ? (node.namedChildren.find(c => c.type === 'statement_list')?.namedChildren || node.namedChildren) : node.namedChildren;
    for (const c of stmts) {
      visit(c, { ...ctx, guards });
      if (c.type === 'if_statement' && !c.childForFieldName('alternative')) {
        const body = c.childForFieldName('consequence'), last = body?.namedChildren.find(x => x.type === 'statement_list')?.namedChildren.at(-1);
        if (last && /^(return_statement|goto_statement)$/.test(last.type) || (last?.type === 'expression_statement' && /^(panic|log\.Fatal\w*|os\.Exit)\(/.test(last.text)))
          guards = [...guards, { text: cond(c), neg: true }];
      }
    }
  }

  const argInfo = a => ({ type: a.type, ir: goIr(a), text: a.text.length > 200 ? a.text.slice(0, 200) : a.text });
  function call(node, ctx, how) {
    const fnNode = node.childForFieldName('function');
    const args = (node.childForFieldName('arguments')?.namedChildren || []).filter(a => a.type !== 'comment');
    const from = ctx.fn || MOD, line = node.startPosition.row + 1;
    if (fnNode.type === 'func_literal') {   // `func() { … }()`: its body runs here
      visitFnLit(fnNode, ctx); args.forEach(a => visit(a, ctx)); return;
    }
    if (fnNode.type === 'parenthesized_expression') { args.forEach(a => visit(a, ctx)); return; }   // `(*T)(nil)`: a conversion
    if (fnNode.type === 'identifier' && fnNode.text === 'new' && args[0]) { const t = typeIr(args[0]);   // new(T) constructs a T
      if (t.k === 'name' || t.k === 'qual') go.literals.push({ from: ctx.fn || MOD, module, file: rel, line: node.startPosition.row + 1, type: t, guards: ctx.guards }); }
    const attr = fnNode.type === 'selector_expression' ? fnNode.childForFieldName('field').text : null;
    const objN = attr ? fnNode.childForFieldName('operand') : null;
    const expr = fnNode.text;
    // os.Getenv("X") / os.LookupEnv("X"), and flag.String("name", "default", …)
    if (/^(os|syscall)\.(Getenv|LookupEnv)$/.test(expr) && goStr(args[0]) != null)
      go.envReads.push({ key: goStr(args[0]), file: rel, line, group, via: expr });
    const fl = /^flag\.(String|Int|Int64|Uint|Uint64|Bool|Duration|Float64)(Var)?$/.exec(expr);
    if (fl) { const k = goStr(args[fl[2] ? 1 : 0]), d = args[fl[2] ? 2 : 1]; if (k != null) go.envReads.push({ key: `-${k}`, file: rel, line, group, via: 'flag', ...(d && d.type !== 'identifier' ? { default: goStr(d) ?? d.text } : {}) }); }
    // the call's record goes in first, so the calls inside its function-literal arguments come after it
    const index = go.rawCalls.length;
    const name = attr && ROUTE_REG.test(attr) ? routeName(attr, args) : null;
    const info = args.map(argInfo);
    go.rawCalls.push({ from, module, file: rel, expr, line, attr, obj: objN ? goIr(objN) : null, fn: attr ? null : goIr(fnNode), how,
      types: ctx.types, locals: ctx.locals, consts: ctx.consts, guards: ctx.guards, top: !ctx.fn, args: info, range: ctx.range, closureOf: ctx.closure,
      ...(ctx.argOf != null ? { argOf: ctx.argOf } : {}) });
    args.forEach((a, i) => {
      if (a.type !== 'func_literal' || !name) return;
      info[i].fnId = defineFn(a, name, { ...ctx, closureOf: index, closureArg: i }, { counts: false, bind: false });
      go.handed.push({ from, to: info[i].fnId, line, file: rel, how: expr, call: index });
    });
    for (const [i, a] of args.entries()) if (a.type === 'identifier' || a.type === 'selector_expression')
      go.handed.push({ from, ir: goIr(a), name: a.text, line, file: rel, callee: expr, argIndex: i, call: index, module, types: ctx.types, locals: ctx.locals });
    if (objN && objN.type !== 'identifier') visit(objN, ctx);
    args.forEach((a, i) => { if (a.type === 'func_literal' && !info[i].fnId) visitFnLit(a, { ...ctx, closure: index, closureArg: i, argOf: null });
      else if (a.type !== 'func_literal') visit(a, { ...ctx, argOf: index }); });
  }
  // a function literal's body runs as part of the enclosing function; its parameters are typed in its own scope
  function visitFnLit(fl, ctx) {
    const inner = { ...ctx, types: new Map(ctx.types), locals: new Map(ctx.locals), consts: new Map(ctx.consts), guards: ctx.guards };
    params(fl.childForFieldName('parameters')).forEach((p, i) => { if (p.name) inner.types.set(p.name, { t: 'annot', type: p.type, ...(ctx.closure != null ? { closureOf: ctx.closure, argIndex: ctx.closureArg, param: i } : {}) }); });
    const body = fl.childForFieldName('body'); if (body) visit(body, inner);
  }

  function visit(node, ctx) {
    switch (node.type) {
      case 'comment': return;
      case 'block': visitBlock(node, ctx); return;
      case 'function_declaration': {
        const name = node.childForFieldName('name').text;
        const id = defineFn(node, name, ctx);
        if (name === 'main' && pkgName === 'main') go.mains.push(id);
        return;
      }
      case 'method_declaration': {
        const rp = params(node.childForFieldName('receiver'))[0];
        const base = rp?.type?.k === 'ptr' ? rp.type.of : rp?.type;
        defineFn(node, node.childForFieldName('name').text, ctx, { kind: 'method', recvType: base?.name || '?', recv: rp });
        return;
      }
      case 'type_declaration': for (const s of node.namedChildren) if (s.type === 'type_spec' || s.type === 'type_alias') defineType(s); return;
      case 'var_declaration': case 'const_declaration':
        for (const s of node.descendantsOfType(['var_spec', 'const_spec'])) {
          const names = s.childrenForFieldName('name').map(c => c.text);
          const vals = s.childForFieldName('value')?.namedChildren || [];
          valueSpecs(names, vals, s.childForFieldName('type'), ctx, s.startPosition.row + 1);
          for (const v of vals) visit(v, ctx);
        }
        return;
      case 'short_var_declaration': {
        const names = node.childForFieldName('left').namedChildren.map(c => c.text), vals = node.childForFieldName('right').namedChildren;
        if (ctx.fn && names.length === 1 && vals[0]?.type === 'func_literal') { defineFn(vals[0], names[0], ctx, { counts: false }); return; }
        valueSpecs(names, vals, null, ctx, node.startPosition.row + 1);
        for (const v of vals) visit(v, ctx);
        return;
      }
      case 'assignment_statement': {
        const l = node.childForFieldName('left').namedChildren, r = node.childForFieldName('right').namedChildren;
        if (ctx.fn) l.forEach((x, i) => { if (x.type === 'identifier' && r[i]) { const spec = { t: 'expr', ir: goIr(r[i]), index: 0 };
          if (!ctx.types.has(x.text) || ctx.types.get(x.text).t === 'expr') ctx.types.set(x.text, spec); } });
        for (const x of [...l, ...r]) visit(x, ctx);
        return;
      }
      case 'for_statement': {
        const rc = node.namedChildren.find(c => c.type === 'range_clause');
        let inner = ctx;
        if (rc) {
          const right = rc.childForFieldName('right'), left = rc.childForFieldName('left')?.namedChildren || [];
          inner = { ...ctx, types: new Map(ctx.types) };
          if (left[1]?.type === 'identifier') inner.types.set(left[1].text, { t: 'range', ir: goIr(right) });
          inner.range = { over: right.text, line: rc.startPosition.row + 1, cases: rangeCases(right, ctx) };
          visit(right, ctx);
        }
        for (const c of node.namedChildren) if (c.type !== 'range_clause') visit(c, inner);
        return;
      }
      case 'if_statement': {
        const init = node.childForFieldName('initializer');
        const sub = { ...ctx, types: new Map(ctx.types) };
        if (init) visit(init, sub);
        const c = cond(node);
        visit(node.childForFieldName('condition'), sub);
        const g0 = ctx.guards || [];
        visit(node.childForFieldName('consequence'), { ...sub, guards: [...g0, { text: c, neg: false }] });
        const alt = node.childForFieldName('alternative');
        if (alt) visit(alt, { ...sub, guards: [...g0, { text: c, neg: true }] });
        return;
      }
      case 'go_statement': case 'defer_statement': {
        const ce = node.namedChildren.find(c => c.type === 'call_expression');
        if (ce) { call(ce, ctx, node.type === 'go_statement' ? 'go' : 'defer'); return; }
        break;
      }
      case 'return_statement': noteReturn(node.namedChildren.find(c => c.type === 'expression_list')?.namedChildren || node.namedChildren, ctx); break;
      case 'call_expression': call(node, ctx, null); return;
      case 'func_literal': visitFnLit(node, ctx); return;
      case 'composite_literal': {
        const t = typeIr(node.childForFieldName('type'));
        if (t.k === 'name' || t.k === 'qual') go.literals.push({ from: ctx.fn || MOD, module, file: rel, line: node.startPosition.row + 1, type: t, guards: ctx.guards });
        // a gRPC service descriptor names the service it registers: grpc.ServiceDesc{ServiceName: "pkg.Svc", HandlerType: (*SvcServer)(nil)}
        if (t.k === 'qual' && t.name === 'ServiceDesc') {
          const kv = node.childForFieldName('body')?.namedChildren.filter(e => e.type === 'keyed_element') || [];
          const get = k => kv.find(e => e.namedChildren[0]?.text === k)?.namedChildren[1];
          const sn = get('ServiceName'), ht = get('HandlerType');
          const s = sn && goStr(sn.namedChildren[0] || sn);
          const iface = ht?.text.match(/\(\s*\*\s*([\w.]+)\s*\)\s*\(\s*nil\s*\)/)?.[1];
          if (s) go.serviceNames.push({ name: s, iface: iface?.split('.').pop() || null, file: rel, line: node.startPosition.row + 1 });
        }
        break;
      }
    }
    for (const c of node.namedChildren) visit(c, ctx);
  }
  // `for _, tc := range cases` where `cases` (or the range expression itself) is a composite literal: its element count
  function rangeCases(right, ctx) {
    const lit = right.type === 'composite_literal' ? right : null;
    const count = l => l.childForFieldName('body')?.namedChildren.filter(e => e.type === 'literal_element' || e.type === 'keyed_element').length ?? null;
    if (lit) return count(lit);
    if (right.type === 'identifier') return ctx.litCount?.get(right.text) ?? null;
    return null;
  }

  // the composite literals a function binds to names, for table tests: `cases := []struct{…}{{…}, {…}}`
  const litCounts = fn => { const m = new Map(); for (const d of fn.descendantsOfType('short_var_declaration')) {
    const l = d.childForFieldName('left').namedChildren, r = d.childForFieldName('right').namedChildren;
    if (l.length === 1 && r[0]?.type === 'composite_literal') m.set(l[0].text, r[0].childForFieldName('body')?.namedChildren.filter(e => e.type === 'literal_element' || e.type === 'keyed_element').length ?? 0); }
    return m; };
  const top = { fn: null, qual: null, locals: new Map(), types: new Map(), consts: P.consts, guards: [], onFailure: null, range: null, closure: null };
  for (const c of root.namedChildren) {
    if (c.type === 'function_declaration' || c.type === 'method_declaration') visit(c, { ...top, litCount: litCounts(c) });
    else visit(c, top);
  }
  go.defScopes += quals.size;
}

/* ---------------- packages, imports and types ---------------- */

const typeText = t => t.k === 'name' ? t.name : t.k === 'qual' ? `${t.pkg}.${t.name}` : t.k === 'ptr' ? `*${typeText(t.of)}` : t.k === 'slice' ? `[]${typeText(t.of)}` : t.k === 'map' ? `map[…]${typeText(t.of)}` : '?';

// go.mod files -> { dir, module }; an import path -> the repo directory it names (the longest module prefix wins)
export function goModules(goMods) {
  return goMods.map(({ rel, text }) => ({ dir: posix.dirname(rel) === '.' ? '' : posix.dirname(rel), module: /^\s*module\s+(\S+)/m.exec(text)?.[1] }))
    .filter(m => m.module).sort((a, b) => b.module.length - a.module.length);
}

export function goResolverFor(go, mods) {
  const { classes, symbols, packages } = go;
  const pkgsByDir = new Map(); for (const P of packages.values()) (pkgsByDir.get(P.dir) || pkgsByDir.set(P.dir, []).get(P.dir)).push(P);
  const dirOfImport = path => { for (const m of mods) if (path === m.module || path.startsWith(m.module + '/')) {
    const sub = path.slice(m.module.length + 1), d = [m.dir, sub].filter(Boolean).join('/'); return pkgsByDir.has(d) ? d : null; } return null; };
  // the package an import path names: the directory's non-test package
  const pkgOfImport = path => { const d = dirOfImport(path); if (d == null) return null; const ps = pkgsByDir.get(d);
    return ps.find(p => !p.name.endsWith('_test')) || ps[0]; };
  const lastElem = path => { const parts = path.split('/'); let l = parts.at(-1); if (/^v\d+$/.test(l) && parts.length > 1) l = parts.at(-2); return l.replace(/^go-/, '').replace(/\.v\d+$/, '').replace(/[^\w]/g, '_'); };
  // a module's imports by local name: { pkg } in the repo or { ext: path }
  const importsMemo = new Map();
  function importsOf(module) {
    if (importsMemo.has(module)) return importsMemo.get(module);
    const M = go.modules.get(module), out = new Map();
    for (const imp of M?.imports || []) { const P = pkgOfImport(imp.path); out.set(imp.alias || P?.name || lastElem(imp.path), P ? { pkg: P, path: imp.path } : { ext: imp.path }); }
    importsMemo.set(module, out);
    return out;
  }
  const pkgOf = module => packages.get(go.modules.get(module) && `${go.modules.get(module).dir}\0${go.modules.get(module).pkg}`);
  // the same package's namespace, plus a dot import's
  const scopes = module => { const M = go.modules.get(module), own = pkgOf(module); return [own, ...(M?.dotImports || []).map(i => pkgOfImport(i.path)).filter(Boolean)].filter(Boolean); };

  // a type IR, seen from a module, to a class id ({ cls }) or an external type ({ ext }) or null
  function classOf(t, module, depth = 0) {
    if (!t || depth > 6) return null;
    if (t.k === 'ptr') return classOf(t.of, module, depth + 1);
    if (t.k === 'name') {
      if (BASIC.has(t.name)) return null;
      for (const P of scopes(module)) { if (P.types.has(t.name)) return { cls: P.types.get(t.name) }; if (P.aliases.has(t.name)) return classOf(P.aliases.get(t.name), P.files[0], depth + 1); }
      return null;
    }
    if (t.k === 'qual') {
      const imp = importsOf(module).get(t.pkg);
      if (!imp) return null;
      if (imp.ext) return { ext: `${imp.ext}.${t.name}` };
      if (imp.pkg.types.has(t.name)) return { cls: imp.pkg.types.get(t.name) };
      if (imp.pkg.aliases.has(t.name)) return classOf(imp.pkg.aliases.get(t.name), imp.pkg.files[0], depth + 1);
      return null;
    }
    return null;
  }
  for (const k of classes.values()) {
    k.embedIds = k.embeds.map(t => classOf(t, k.module)?.cls).filter(Boolean);
  }
  // methods declared on a type in any file of its package
  for (const s of symbols.values()) if (s.recvType) {
    const P = packages.get(s.pkg), cls = P?.types.get(s.recvType);
    if (cls) { s.cls = cls; classes.get(cls).methods.set(s.name.split('.').pop(), s.id); }
  }
  const embedChain = (id, seen = new Set()) => seen.has(id) ? [] : (seen.add(id), [id, ...(classes.get(id)?.embedIds || []).flatMap(b => embedChain(b, seen))]);
  function lookup(clsId, m) { for (const c of embedChain(clsId)) { const x = classes.get(c)?.methods.get(m); if (x) return x; } return null; }
  function fieldType(clsId, f) { for (const c of embedChain(clsId)) { const k = classes.get(c); if (k?.fields.has(f)) return { t: k.fields.get(f), module: k.module }; } return null; }
  const methodSet = id => { const out = new Map(); for (const c of embedChain(id)) for (const [n, mid] of classes.get(c)?.methods || []) if (!out.has(n)) out.set(n, mid); return out; };
  // two parameter or result types that cannot be one type: different predeclared types, or differently built ones
  const comp = t => t?.k === 'ptr' || t?.k === 'slice' || t?.k === 'map' || t?.k === 'chan', basic = t => t?.k === 'name' && BASIC.has(t.name);
  const canon = n => n === 'byte' ? 'uint8' : n === 'rune' ? 'int32' : n;
  const clash = (a, b) => basic(a) && basic(b) ? canon(a.name) !== canon(b.name) : comp(a) && comp(b) ? a.k !== b.k || clash(a.of, b.of) : (basic(a) && comp(b)) || (comp(a) && basic(b));
  const fits = (impl, want) => { const a = symbols.get(impl), b = symbols.get(want), ap = a?.paramTypes || [], bp = b?.paramTypes || [], ar = a?.results || [], br = b?.results || [];
    return ap.length === bp.length && ar.length === br.length && ap.every((t, i) => !clash(t, bp[i])) && ar.every((t, i) => !clash(t, br[i])); };
  // implicit interface satisfaction, by method set: every concrete type that has each of the interface's methods, by
  // name with as many parameters and results, none of them a clashing type
  const ifaces = [...classes.values()].filter(k => k.iface).map(k => ({ id: k.id, methods: methodSet(k.id) })).filter(i => i.methods.size);
  for (const k of classes.values()) if (!k.iface) {
    const have = methodSet(k.id);
    k.implementsIds = ifaces.filter(i => [...i.methods].every(([n, mid]) => have.has(n) && fits(have.get(n), mid))).map(i => i.id);
    k.bases = [...k.embedIds, ...k.implementsIds];
  } else { k.implementsIds = []; k.bases = [...k.embedIds]; }
  const implementers = new Map(); for (const k of classes.values()) for (const i of k.implementsIds) (implementers.get(i) || implementers.set(i, []).get(i)).push(k.id);
  const isIface = id => !!classes.get(id)?.iface;

  // what a name means in a scope ({ module, types, locals }): { local: spec } | { id } | { var } | { pkg } | { ext } | { type } | null
  function resolveName(name, sc) {
    if (sc.types?.has(name)) return { local: sc.types.get(name) };
    if (sc.locals?.has(name)) return { id: sc.locals.get(name) };
    for (const P of scopes(sc.module)) {
      if (P.funcs.has(name)) return { id: P.funcs.get(name) };
      if (P.types.has(name)) return { type: P.types.get(name) };
      if (P.vars.has(name)) return { var: P.vars.get(name) };
      if (P.aliases.has(name)) return { type: classOf({ k: 'name', name }, sc.module)?.cls || null };
    }
    const imp = importsOf(sc.module).get(name);
    if (imp) return imp.pkg ? { pkg: imp.pkg, path: imp.path } : { ext: imp.ext };
    return null;
  }

  // the type IR of an expression IR, with the module that IR is read in; `narrow` when it came from a factory
  function typeOf(ir, sc, depth = 0) {
    if (!ir || depth > 8) return null;
    switch (ir.k) {
      case 'lit': return { t: ir.type, module: sc.module };
      case 'id': {
        const r = resolveName(ir.name, sc);
        if (r?.local) return typeOfSpec(r.local, sc, depth + 1);
        if (r?.var) return typeOfSpec(r.var, { module: r.var.module }, depth + 1);
        return null;
      }
      case 'sel': {
        if (ir.obj.k === 'id') {   // pkg.Var
          const r = resolveName(ir.obj.name, sc);
          if (r?.pkg) { const v = r.pkg.vars.get(ir.field); return v ? typeOfSpec(v, { module: v.module }, depth + 1) : null; }
          if (r?.ext) return null;
        }
        const o = typeOf(ir.obj, sc, depth + 1), k = o && classOf(o.t, o.module)?.cls;
        const f = k && fieldType(k, ir.field);
        return f ? { t: f.t, module: f.module } : null;
      }
      case 'idx': { const o = typeOf(ir.obj, sc, depth + 1); return o && (o.t.k === 'slice' || o.t.k === 'map') ? { t: o.t.of, module: o.module } : null; }
      case 'call': return callResult(ir, sc, 0, depth + 1);
      default: return null;
    }
  }
  function typeOfSpec(spec, sc, depth) {
    if (spec.t === 'annot') return { t: spec.type, module: spec.module || sc.module };
    if (spec.t === 'range') { const o = typeOf(spec.ir, { ...sc, ...(spec.types ? { types: spec.types } : {}) }, depth + 1); return o && (o.t.k === 'slice' || o.t.k === 'map' || o.t.k === 'chan') ? { t: o.t.of, module: o.module } : null; }
    if (spec.t === 'expr') return spec.ir.k === 'call' ? callResult(spec.ir, { ...sc, ...(spec.types ? { types: spec.types } : {}) }, spec.index || 0, depth + 1) : typeOf(spec.ir, sc, depth + 1);
    return null;
  }
  // the declared result type of the function a call names; a factory with an interface result narrows to what it returns
  function callResult(ir, sc, index, depth) {
    const target = calleeOf(ir.fn, sc, depth);
    if (target?.type) return { t: { k: 'name', name: symbols.get(target.type)?.name }, module: symbols.get(target.type)?.file };
    const s = target?.id && symbols.get(target.id);
    if (!s?.results?.[index]) return null;
    const out = { t: s.results[index], module: s.file };
    const rc = classOf(out.t, out.module)?.cls;
    if (rc && isIface(rc)) { const fr = factoryReturns(s.id).filter(x => x.cls); if (fr.length) out.narrow = { factory: s.id, cls: [...new Set(fr.map(x => x.cls))], returns: fr }; }
    return out;
  }
  // what a call's function IR names: { id } (a function or method), { type } (a conversion), { ext }, or null
  function calleeOf(fn, sc, depth = 0) {
    if (!fn) return null;
    if (fn.k === 'id') { const r = resolveName(fn.name, sc); return r?.id ? { id: r.id } : r?.type ? { type: r.type } : null; }
    if (fn.k === 'sel') {
      if (fn.obj.k === 'id') {
        const r = resolveName(fn.obj.name, sc);
        if (r?.pkg) return r.pkg.funcs.has(fn.field) ? { id: r.pkg.funcs.get(fn.field) } : r.pkg.types.has(fn.field) ? { type: r.pkg.types.get(fn.field) } : null;
        if (r?.ext) return { ext: `${r.ext}.${fn.field}` };
        if (r?.type) { const m = lookup(r.type, fn.field); return m ? { id: m } : null; }   // a method expression T.M
      }
      const o = typeOf(fn.obj, sc, depth + 1), k = o && classOf(o.t, o.module)?.cls;
      const m = k && lookup(k, fn.field);
      return m ? { id: m } : null;
    }
    return null;
  }

  const retMemo = new Map(), returnsOf = new Map();
  for (const r of go.returns) (returnsOf.get(r.fn) || returnsOf.set(r.fn, []).get(r.fn)).push(r);
  function factoryReturns(fnId, depth = 0) {
    if (retMemo.has(fnId)) return retMemo.get(fnId);
    if (depth > 3) return [];
    retMemo.set(fnId, []);
    const out = [];
    for (const ret of returnsOf.get(fnId) || []) {
      let ir = ret.ir, guards = ret.guards;
      if (ir.k === 'id') { const a = go.fnAssigns.get(fnId)?.get(ir.name); if (!a) continue; ir = a.ir; guards = [...a.guards, ...ret.guards]; }
      if (ir.k === 'lit') { const c = classOf(ir.type, ret.module)?.cls; if (c && !isIface(c)) out.push({ cls: c, guards, line: ret.line }); }
      else if (ir.k === 'call') { const t = calleeOf(ir.fn, ret, 0); const s = t?.id && symbols.get(t.id);
        if (s) { const rc = s.results?.[0] && classOf(s.results[0], s.file)?.cls;
          if (rc && !isIface(rc)) out.push({ cls: rc, guards, line: ret.line, via: s.id });
          else for (const x of factoryReturns(s.id, depth + 1)) out.push({ ...x, guards: [...guards, ...x.guards], via: s.id }); } }
    }
    retMemo.set(fnId, out);
    return out;
  }

  return { pkgOfImport, importsOf, packageOf: pkgOf, classOf, resolveName, typeOf, calleeOf, lookup, fieldType, implementers, isIface, factoryReturns, embedChain, typeText };
}

export function addGoEdge(go, from, to, kind, line, extra = {}) {
  if (!from || !to || from === to) return;
  const e = { from, to, kind, line, ...extra };
  const gf = go.groupOf(from), gt = go.groupOf(to);
  if (gf && gt && gf !== gt) e.groups = [gf, gt];
  go.edges.push(e);
}

const CFG_GUARD = /\bos\.(Getenv|LookupEnv)\b|\b(cfg|config|conf|settings|opts|options|env)\.|\bflag\.|\b(isProd|IsProd|isDev|IsDev|debug|Debug)\b/;
// callees that look at a function rather than run it
const NOT_RUN = /^(fmt\.\w+|log\.\w+|errors\.\w+|reflect\.\w+|t\.(Log|Logf|Error|Errorf|Fatal|Fatalf|Helper|Run)|assert\.\w+|require\.\w+)$/;

/* resolve every recorded call into edges; each resolved call records its `target` for the rule packs */
export function resolveGoCalls(go, R) {
  const { symbols } = go;
  // a variable whose type, or the call that made it, is a dependency's
  const external = (spec, c) => spec.t === 'annot' ? !!R.classOf(spec.type, c.module)?.ext : spec.t === 'expr' && spec.ir.k === 'call' && !!R.calleeOf(spec.ir.fn, c)?.ext;
  const noteMiss = (c, head) => {
    const r = head ? R.resolveName(head, c) : null;
    if (r?.ext) go.unresolved.external++;
    else if (r && (r.id || r.pkg || r.type || r.var)) go.unresolved.inRepo++;
    else if (r?.local) external(r.local, c) ? go.unresolved.external++ : go.unresolved.local++;
    else if (PREDECLARED.has(head) || BASIC.has(head)) go.unresolved.builtin++;
    else go.unresolved.local++;
  };
  const cfgOf = guards => { const cg = (guards || []).filter(g => CFG_GUARD.test(g.text)); return cg.length ? { cfg: cg.map(g => (g.neg ? 'not ' : '') + g.text.replace(/\s+/g, ' ')) } : {}; };
  go.rawCalls.forEach((c, i) => {
    const extra = { ...cfgOf(c.guards), ...(c.how ? { [c.how === 'go' ? 'goroutine' : 'deferred']: true } : {}) };
    const add = (to, kind, more = {}) => addGoEdge(go, c.from, to, kind, c.line, { ...more, ...extra });
    if (!c.attr) {
      const f = c.fn;
      if (f.k === 'id' && PREDECLARED.has(f.name) && !R.resolveName(f.name, c)) { go.unresolved.builtin++; go.callStats.unresolvedName++; return; }
      const t = R.calleeOf(f, c);
      if (t?.id) { add(t.id, 'static'); c.target = t.id; go.callStats.resolved++; }
      else if (t?.type || (f.k === 'id' && BASIC.has(f.name))) { /* a conversion, not a call */ }
      else { go.callStats.unresolvedName++; noteMiss(c, f.k === 'id' ? f.name : null); }
      return;
    }
    const site = `${c.from}@${c.line}:${c.attr}`;
    // pkg.F(), T.M (a method expression)
    if (c.obj.k === 'id') {
      const r = R.resolveName(c.obj.name, c);
      if (r?.pkg || r?.ext || r?.type) {
        const t = R.calleeOf({ k: 'sel', obj: c.obj, field: c.attr }, c);
        if (t?.id) { add(t.id, 'static'); c.target = t.id; go.callStats.resolved++; }
        else if (t?.type) { /* conversion */ }
        else { go.callStats.unresolvedAttr++; if (r.ext) go.unresolved.external++; else go.unresolved.inRepo++; }
        return;
      }
    }
    const o = R.typeOf(c.obj, c), k = o && R.classOf(o.t, o.module);
    if (k?.cls) {
      if (o.narrow) {
        const targets = [...new Set(o.narrow.cls.map(x => R.lookup(x, c.attr)).filter(Boolean))];
        if (targets.length) { for (const t of targets) add(t, targets.length === 1 ? 'static' : 'dispatch', { site, narrowedBy: o.narrow.factory, ...(targets.length === 1 ? { recvClass: o.narrow.cls[0] } : {}) });
          c.target = targets[0]; go.callStats.resolved++; return; }
      }
      const target = R.lookup(k.cls, c.attr);
      if (R.isIface(k.cls)) {
        const impls = (R.implementers.get(k.cls) || []).map(x => R.lookup(x, c.attr)).filter(Boolean);
        if (target) add(target, 'static', { site });
        for (const t of [...new Set(impls)]) add(t, 'virtual', { site, evidence: `${symbols.get(t)?.name} implements ${symbols.get(k.cls)?.name}` });
        if (target || impls.length) { c.target = target; go.callStats.resolved++; return; }
      } else if (target) { add(target, 'static', { recvClass: k.cls, site }); c.target = target; go.callStats.resolved++; return; }
    }
    go.callStats.unresolvedAttr++;
    if (k?.ext) go.unresolved.external++;
    else { let h = c.obj; while (h.k === 'sel' || h.k === 'idx') h = h.obj; noteMiss(c, h.k === 'id' ? h.name : null); }
  });
  // composite literals of in-repo types: what a function constructs
  for (const l of go.literals) { const k = R.classOf(l.type, l.module)?.cls; if (k) { l.cls = k; addGoEdge(go, l.from, k, 'ctor', l.line, cfgOf(l.guards)); } }
}

/* a function or method value handed to a call runs from there: the caller links to it. `skipHanded`: calls whose
   function arguments a rule pack has claimed (a route registration hands its handler to the router) */
export function linkGoCallbacks(go, R, { skipHanded = new Set() } = {}) {
  const { symbols } = go;
  const claimed = i => { for (let j = i; j != null; j = go.rawCalls[j]?.argOf) if (skipHanded.has(j)) return true; return false; };
  for (const h of go.handed) {
    if (h.call != null && claimed(h.call)) continue;
    if (h.to) { addGoEdge(go, h.from, h.to, 'static', h.line, { rule: 'go.callback', evidence: `${h.file}:${h.line} hands ${symbols.get(h.to)?.name} to ${h.how}` }); continue; }
    if (NOT_RUN.test(h.callee)) continue;
    const t = R.calleeOf(h.ir, h);
    const s = t?.id && symbols.get(t.id);
    if (!s || (s.kind !== 'function' && s.kind !== 'method') || (s.decos || []).includes('abstractmethod')) continue;
    addGoEdge(go, h.from, t.id, 'static', h.line, { rule: 'go.callback', evidence: `${h.file}:${h.line} hands ${h.name} to ${h.callee}` });
  }
}

/* `func main()` in a `package main` */
export function goEntries(go) {
  return go.mains.map(m => ({ kind: 'main', id: m, file: go.symbols.get(m).file, line: go.symbols.get(m).start, rule: 'go.main' }));
}

/* const folding for route paths: string literals, `+`, and identifiers naming a const of the function, its package
   or an imported package (`api.Prefix`); what cannot be known is `{}` */
export function foldGo(R, ir, sc, depth = 0) {
  if (!ir || depth > 10) return '{}';
  if (ir.k === 'str') return ir.v;
  if (ir.k === 'cat') return foldGo(R, ir.l, sc, depth + 1) + foldGo(R, ir.r, sc, depth + 1);
  if (ir.k === 'id') {
    const local = sc.consts?.get(ir.name);
    if (local && local !== ir) return foldGo(R, local, sc, depth + 1);
    const v = R.packageOf(sc.module)?.consts.get(ir.name);
    return v ? foldGo(R, v, { module: sc.module }, depth + 1) : '{}';
  }
  if (ir.k === 'sel' && ir.obj.k === 'id') {
    const r = R.resolveName(ir.obj.name, { module: sc.module });
    const v = r?.pkg?.consts.get(ir.field);
    if (v) return foldGo(R, v, { module: r.pkg.files[0] }, depth + 1);
  }
  return '{}';
}
