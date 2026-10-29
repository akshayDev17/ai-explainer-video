/* Config-aware dispatch for Python (design rev3 §3.6). For every factory that can return two or more classes,
   evaluate each alternative's branch guards with three-valued logic under the settings defaults in code and under
   each in-repo config file that sets a key the guards read (a "profile"). Every alternative is tagged with what
   selects it. A site is
     config-narrowed        when every profile decides exactly one alternative,
     config-dependent       when a guard reads a function parameter (runtime input) or a value no profile settles.
   Profiles carry their file's group: production and dev sites are decided under code defaults and prod/dev files
   only; an eval or test data file decides only eval or test sites. B14: `getattr(settings, "x", default)` reads a
   declared field x exactly as `settings.x` does (profile value, else the field default); when no settings field
   declares x the default decides, since a settings object ignores undeclared env vars.
   Values are evaluated as read; what the report shows of them goes through shownValue (a secret is shown only as set). */
import { shownValue } from '../config/redact.mjs';

const UNK = { unk: true };
const isU = v => v && v.unk;
const truthy = v => isU(v) ? UNK : !(v === null || v === false || v === '' || v === 0 || v === undefined);
const not3 = v => isU(v) ? UNK : !v;
const and3 = (a, b) => (a === false || b === false) ? false : (isU(a) || isU(b)) ? UNK : true;
const or3 = (a, b) => (a === true || b === true) ? true : (isU(a) || isU(b)) ? UNK : false;
const DATA = /(Response|Result|Payload|Model|Schema|Error|Exception)$/;
// a guard that only tests a private module global (`_instance is None`, `key in _cache`) is a cache check, not a selector
const isCacheGuard = text => { const ids = text.match(/[A-Za-z_]\w*/g) || [];
  const free = ids.filter(i => !/^(is|not|None|in|and|or|self|cache_key|key)$/.test(i));
  return free.length > 0 && free.every(i => i.startsWith('_')); };
const PROFILE_GROUPS = { prod: ['prod', 'dev'], dev: ['prod', 'dev'], eval: ['prod', 'dev', 'eval'], test: ['prod', 'dev', 'test'] };

export function classifyDispatch({ py, factories, entries, configKV, parser }) {
  const fields = new Map(py.settingsFields.map(f => [f.name, f]));
  const props = new Map(py.settingsProps.map(p => [p.name, p]));
  const envOf = f => [f.name.toUpperCase(), ...(f.alias ? [f.alias.toUpperCase()] : [])];
  const parseDefault = f => {
    if (f.default === undefined) return UNK;
    if (f.defaultIsString) return f.default;
    if (f.default === 'None') return null; if (f.default === 'True') return true; if (f.default === 'False') return false;
    if (/^-?\d+(\.\d+)?$/.test(f.default)) return Number(f.default);
    return UNK;
  };
  const coerce = (f, v) => { const d = parseDefault(f);
    if (typeof d === 'boolean') return /^(1|true|yes|on)$/i.test(v);
    if (typeof d === 'number') return Number(v);
    return v; };
  const exprOf = text => { const t = parser.parse(`(${text})\n`); const n = t.rootNode.namedChildren[0]?.namedChildren[0]?.namedChildren[0]; return n; };

  function evaluate(text, fn, profile, refs, depth = 0) {
    const alias = py.fnAlias.get(fn) || {}, params = new Set(py.symbols.get(fn)?.params || []);
    const settingsVal = (name, fallback) => {
      refs.settings.add(name);
      if (fields.has(name)) { const f = fields.get(name);
        for (const e of envOf(f)) if (profile.values.has(e)) return coerce(f, profile.values.get(e).value);
        return parseDefault(f); }
      if (props.has(name)) return ev(exprOf(props.get(name).expr), true);
      return fallback === undefined ? UNK : fallback;
    };
    const isSettingsObj = (n, inProp) => n && ((n.type === 'identifier' && (n.text === 'settings' || (inProp && n.text === 'self'))) ||
      (n.type === 'call' && /get_settings$/.test(n.childForFieldName('function').text)) || (n.type === 'attribute' && /^self\._?settings$/.test(n.text)));
    function ev(n, inProp = false) {
      if (!n) return UNK;
      switch (n.type) {
        case 'parenthesized_expression': return ev(n.namedChildren[0], inProp);
        case 'string': return n.namedChildren.filter(c => c.type === 'string_content').map(c => c.text).join('');
        case 'integer': case 'float': return Number(n.text);
        case 'true': return true; case 'false': return false; case 'none': return null;
        case 'not_operator': return not3(truthy(ev(n.childForFieldName('argument'), inProp)));
        case 'boolean_operator': { const op = n.children.find(c => !c.isNamed && /and|or/.test(c.type))?.type;
          const a = truthy(ev(n.childForFieldName('left'), inProp)), b = truthy(ev(n.childForFieldName('right'), inProp));
          return op === 'and' ? and3(a, b) : or3(a, b); }
        case 'comparison_operator': {
          const ops = n.children.filter(c => !c.isNamed).map(c => c.type).join(' ');
          const [l, r] = n.namedChildren.map(x => ev(x, inProp));
          if (/^is not$/.test(ops)) return isU(l) ? UNK : l !== null && l !== undefined;
          if (/^is$/.test(ops)) return isU(l) ? UNK : l === null || l === undefined;
          if (isU(l) || isU(r)) return UNK;
          if (ops === '==') return l === r; if (ops === '!=') return l !== r;
          if (ops === 'in') return typeof r === 'string' && typeof l === 'string' ? r.includes(l) : UNK;
          if (ops === 'not in') return typeof r === 'string' && typeof l === 'string' ? !r.includes(l) : UNK;
          return UNK; }
        case 'call': { const f = n.childForFieldName('function'); const args = n.childForFieldName('arguments').namedChildren;
          if (f.type === 'attribute' && /^(lower|upper|strip)$/.test(f.childForFieldName('attribute').text)) {
            const v = ev(f.childForFieldName('object'), inProp); if (isU(v) || typeof v !== 'string') return v === null ? UNK : (isU(v) ? UNK : v);
            const m = f.childForFieldName('attribute').text; return m === 'lower' ? v.toLowerCase() : m === 'upper' ? v.toUpperCase() : v.trim(); }
          if (f.text === 'getattr' && isSettingsObj(args[0], inProp) && args[1]?.type === 'string')
            return settingsVal(ev(args[1], inProp), args[2] ? ev(args[2], inProp) : undefined);
          if (f.text === 'bool') return truthy(ev(args[0], inProp));
          if (f.text === 'str') { const v = ev(args[0], inProp); return isU(v) ? UNK : String(v); }
          return UNK; }
        case 'attribute': {
          const obj = n.childForFieldName('object');
          if (isSettingsObj(obj, inProp)) return settingsVal(n.childForFieldName('attribute').text);
          return UNK; }
        case 'identifier': {
          if (alias[n.text] && depth < 4) return evaluate(alias[n.text], fn, profile, refs, depth + 1);
          if (params.has(n.text)) { refs.params.add(n.text); return UNK; }
          if (n.text.startsWith('_')) { refs.cache.add(n.text); return UNK; }
          return UNK; }
      }
      return UNK;
    }
    return ev(exprOf(text));
  }

  const isEntry = new Set(entries.map(e => e.id));
  const groupOf = id => py.symbols.get(id)?.group || null;
  const sites = Object.entries(factories).map(([fn, rets]) => ({ fn, rets, classes: [...new Set(rets.map(r => r.cls || 'ext:' + r.ext))] }))
    .filter(s => s.classes.length > 1 && !isEntry.has(s.fn) && !s.classes.every(c => DATA.test(c)));

  // profiles: code defaults, then one per in-repo config file that sets any key a guard reads
  const probe = new Set();
  for (const s of sites) for (const r of s.rets) for (const gd of r.guards) { const refs = { settings: new Set(), params: new Set(), cache: new Set() };
    evaluate(gd.text, r.fn || s.fn, { values: new Map() }, refs); for (const x of refs.settings) probe.add(x); }
  for (const p of props.values()) if (probe.has(p.name)) for (const m of (p.expr || '').matchAll(/self\.(\w+)/g)) probe.add(m[1]);
  const relevantEnv = new Set([...probe].filter(x => fields.has(x)).flatMap(x => envOf(fields.get(x))));
  const byFile = new Map();
  for (const kv of configKV) if (relevantEnv.has(kv.key.toUpperCase()))
    (byFile.get(kv.file) || byFile.set(kv.file, { group: kv.group, values: new Map() }).get(kv.file)).values.set(kv.key.toUpperCase(), kv);
  const profiles = [{ name: 'code defaults', group: 'prod', values: new Map() }, ...[...byFile].map(([file, p]) => ({ name: file, group: p.group, values: p.values }))];

  const report = [];
  for (const s of sites) {
    const group = groupOf(s.fn) || 'prod';
    const ps = profiles.filter((p, i) => i === 0 || (PROFILE_GROUPS[group] || []).includes(p.group));
    const alts = s.rets.map(r => {
      const guards = r.guards.filter(gd => !isCacheGuard(gd.text));
      const refs = { settings: new Set(), params: new Set(), cache: new Set() };
      const sel = ps.map(p => { let v = true; for (const gd of guards) { const x = truthy(evaluate(gd.text, s.fn, p, refs)); v = and3(v, gd.neg ? not3(x) : x); } return isU(v) ? '?' : v ? 'yes' : 'no'; });
      const cls = r.cls || 'ext:' + r.ext;
      return { cls, group: r.cls ? groupOf(r.cls) : 'ext', line: r.line, guards: guards.map(gd => (gd.neg ? 'not ' : '') + gd.text.replace(/\s+/g, ' ')),
        settings: [...refs.settings], params: [...refs.params], sel };
    });
    // merge identical class rows (singleton paths produce duplicates)
    const merged = []; for (const a of alts) if (!merged.some(x => x.cls === a.cls && x.guards.join('&') === a.guards.join('&'))) merged.push(a);
    const settingsRead = [...new Set(merged.flatMap(a => a.settings))];
    const params = [...new Set(merged.flatMap(a => a.params))];
    const inRepoValues = settingsRead.filter(x => fields.has(x)).map(x => ({ setting: x, env: envOf(fields.get(x))[0], default: shownValue(envOf(fields.get(x)).join(' '), fields.get(x).default),
      files: ps.slice(1).filter(p => envOf(fields.get(x)).some(e => p.values.has(e))).map(p => { const kv = envOf(fields.get(x)).map(e => p.values.get(e)).find(Boolean); return `${p.name}:${kv.line}=${shownValue(kv.key, kv.value)}`; }) }));
    const decided = ps.map((p, i) => { const yes = merged.filter(a => a.sel[i] === 'yes'); const maybe = merged.filter(a => a.sel[i] === '?');
      return yes.length === 1 && !maybe.length ? yes[0].cls : maybe.length ? `? (${[...yes, ...maybe].map(a => a.cls.split(/[:.]/).pop()).join('|')})` : 'none'; });
    const classification = params.length ? 'config-dependent (runtime input)' : decided.every(d => !d.startsWith('?')) ? 'config-narrowed' : 'config-dependent (value not in repo)';
    report.push({ factory: s.fn, group, classification,
      alternatives: merged.map(a => ({ cls: a.cls, group: a.group, line: a.line, guards: a.guards, sel: Object.fromEntries(ps.map((p, i) => [p.name, a.sel[i]])) })),
      settingsRead, params, inRepoValues, decidedByProfile: Object.fromEntries(ps.map((p, i) => [p.name, decided[i]])) });
  }
  return { profiles: profiles.map(p => ({ name: p.name, group: p.group, keys: [...p.values.keys()] })), sites: report, guardKeys: relevantEnv };
}
