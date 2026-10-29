/* A TOML reader for dependency manifests (pyproject.toml, Pipfile): tables, arrays of tables, dotted and quoted keys,
   the four string forms with their escapes, arrays and inline tables, comments anywhere a comment may stand. Numbers,
   booleans and dates are kept as their source text, since a dependency name is only ever a string or a key. A `]`
   inside a string (`"uvicorn[standard]"`) is string content, never the end of an array. Throws on a malformed
   document, the way tomllib does. */
const BARE = /[A-Za-z0-9_-]+/y;
const SCALAR = /\d{4}-\d{2}-\d{2}[ T]\d{2}:[^\s,\]}#]*|[^\s,\]}#]+/y;
const ESC = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
const isTable = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const table = () => Object.create(null);

export function parseToml(src) {
  let i = 0;
  const err = msg => { throw new Error(`TOML: ${msg} at line ${src.slice(0, i).split('\n').length}`); };
  const ws = () => { while (src[i] === ' ' || src[i] === '\t') i++; };
  const comment = () => { if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++; };
  const gap = () => { for (;;) { ws(); comment(); if (src[i] === '\n' || src[i] === '\r') i++; else return; } };   // blank lines and comments
  const eol = () => { ws(); comment(); if (src[i] === '\r') i++; if (i < src.length && src[i] !== '\n') err('expected the end of the line'); i++; };

  function str() {
    const q = src[i], multi = src.startsWith(q.repeat(3), i);
    i += multi ? 3 : 1;
    if (multi && src[i] === '\n') i++; else if (multi && src.startsWith('\r\n', i)) i += 2;   // a newline right after """ is dropped
    let out = '';
    for (;;) {
      if (i >= src.length) err('unterminated string');
      const c = src[i];
      if (!multi && c === q) { i++; return out; }
      if (multi && src.startsWith(q.repeat(3), i)) { let n = 3; while (n < 5 && src[i + n] === q) n++; out += q.repeat(n - 3); i += n; return out; }
      if (!multi && c === '\n') err('newline in a single-line string');
      if (q === '"' && c === '\\') {
        const e = src[i + 1];
        if (multi && /[ \t\r\n]/.test(e)) {   // a line-ending backslash swallows the newline and the whitespace after it
          let j = i + 1; while (src[j] === ' ' || src[j] === '\t') j++;
          if (src[j] === '\r') j++;
          if (src[j] !== '\n') err('invalid escape');
          while (/[ \t\r\n]/.test(src[j] ?? '')) j++;
          i = j; continue;
        }
        const hex = { x: 2, u: 4, U: 8 }[e];
        if (hex) { const h = src.slice(i + 2, i + 2 + hex); if (!new RegExp(`^[0-9a-fA-F]{${hex}}$`).test(h)) err('invalid escape'); out += String.fromCodePoint(parseInt(h, 16)); i += 2 + hex; continue; }
        if (!(e in ESC)) err('invalid escape');
        out += ESC[e]; i += 2; continue;
      }
      out += c; i++;
    }
  }

  function key() {
    const parts = [];
    for (;;) {
      ws();
      if (src[i] === '"' || src[i] === "'") { if (src.startsWith(src[i].repeat(3), i)) err('a key cannot be a multi-line string'); parts.push(str()); }
      else { BARE.lastIndex = i; const m = BARE.exec(src); if (!m) err('expected a key'); parts.push(m[0]); i += m[0].length; }
      ws();
      if (src[i] !== '.') return parts;
      i++;
    }
  }

  // the table a path names, created on the way; an array of tables is entered at its last element
  const tableAt = (obj, path) => {
    for (const k of path) {
      if (!(k in obj)) obj[k] = table();
      const v = Array.isArray(obj[k]) ? obj[k][obj[k].length - 1] : obj[k];
      if (!isTable(v)) err(`\`${k}\` is not a table`);
      obj = v;
    }
    return obj;
  };
  const assign = (obj, path, v) => {
    const t = tableAt(obj, path.slice(0, -1)), k = path[path.length - 1];
    if (k in t) err(`duplicate key \`${k}\``);
    t[k] = v;
  };

  function value() {
    const c = src[i];
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      i++; const out = [];
      for (;;) {
        gap();
        if (src[i] === ']') { i++; return out; }
        out.push(value()); gap();
        if (src[i] === ',') i++; else if (src[i] === ']') { i++; return out; } else err('expected `,` or `]`');
      }
    }
    if (c === '{') {
      i++; const out = table();
      for (;;) {
        gap();
        if (src[i] === '}') { i++; return out; }
        const k = key();
        if (src[i] !== '=') err('expected `=`');
        i++; ws(); assign(out, k, value()); gap();
        if (src[i] === ',') i++; else if (src[i] === '}') { i++; return out; } else err('expected `,` or `}`');
      }
    }
    SCALAR.lastIndex = i; const m = SCALAR.exec(src);
    if (!m) err('expected a value');
    i += m[0].length; return m[0];
  }

  const root = table();
  let cur = root;
  for (;;) {
    gap();
    if (i >= src.length) return root;
    if (src[i] === '[') {
      const many = src[i + 1] === '['; i += many ? 2 : 1;
      const path = key();
      if (src[i] !== ']' || (many && src[i + 1] !== ']')) err('expected `]`');
      i += many ? 2 : 1;
      if (!many) cur = tableAt(root, path);
      else {
        const parent = tableAt(root, path.slice(0, -1)), k = path[path.length - 1];
        if (!(k in parent)) parent[k] = [];
        if (!Array.isArray(parent[k])) err(`\`${k}\` is not an array of tables`);
        parent[k].push(cur = table());
      }
    } else {
      const path = key();
      if (src[i] !== '=') err('expected `=`');
      i++; ws(); assign(cur, path, value());
    }
    eol();
  }
}
