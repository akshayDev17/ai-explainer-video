/* The third-party names a repo declares as dependencies: requirements*.txt, pyproject.toml ([project] dependencies and
   optional-dependencies, Poetry dependency tables), setup.cfg install_requires / extras_require, and Pipfile. Names are
   normalised (case, `-` / `_` / `.`) so `Stripe` declares `import stripe`. Read, never executed. Returns the names and
   the TOML files the reader rejected, whose names come from a line scan instead. */
import { parseToml } from '../lib/toml.mjs';
export const DEPENDENCY_FILES = /(^|\/)(requirements[\w.-]*\.txt|pyproject\.toml|setup\.cfg|Pipfile)$/;
export const normaliseDep = name => name.toLowerCase().replace(/[-_.]+/g, '_');

const reqName = spec => /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec)?.[1] ?? null;
const isTable = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const STRING = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
const quoted = line => [...line.matchAll(STRING)].map(m => m[1] ?? m[2]);
const closesArray = line => /\]/.test(line.replace(STRING, '').replace(/#.*/, ''));

// the names a TOML file the reader rejected still shows, line by line: a `]` ends an array only outside a string
function scanTomlLines(lines, add) {
  let table = '', inArray = false;
  for (const ln of lines) {
    const head = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(ln);
    if (head) { table = head[1].trim(); inArray = false; continue; }
    const keyTable = /^(tool\.poetry(\.group\.[\w-]+)?\.(dev-)?dependencies|packages|dev-packages)$/.test(table);
    if (keyTable) { const k = /^\s*["']?([A-Za-z0-9][\w.-]*)["']?\s*=/.exec(ln); if (k) add(k[1]); continue; }
    if (table !== 'project' && table !== 'project.optional-dependencies') continue;
    const start = /^\s*([\w-]+)\s*=\s*\[(.*)$/.exec(ln);
    if (start && (table === 'project.optional-dependencies' || start[1] === 'dependencies')) {
      for (const s of quoted(start[2])) add(reqName(s));
      inArray = !closesArray(start[2]);
    } else if (inArray) { for (const s of quoted(ln)) add(reqName(s)); if (closesArray(ln)) inArray = false; }
  }
}

export function declaredDependencies(files) {
  const out = new Set(), unparsed = [];
  const add = n => { if (n && !/^python$/i.test(n)) out.add(normaliseDep(n)); };
  for (const { rel, text } of files) {
    const lines = text.split('\n');
    if (/requirements[\w.-]*\.txt$/.test(rel)) { for (const ln of lines) if (!/^\s*(#|-)/.test(ln)) add(reqName(ln.replace(/#.*/, ''))); continue; }
    if (/(^|\/)setup\.cfg$/.test(rel)) {
      let table = '', inReq = false;
      for (const ln of lines) {
        const head = /^\s*\[([^\]]+)\]/.exec(ln);
        if (head) { table = head[1].trim(); inReq = false; continue; }
        const kv = /^([\w.-]+)\s*=\s*(.*)$/.exec(ln);
        if (kv) { inReq = (table === 'options' && kv[1] === 'install_requires') || table === 'options.extras_require'; if (inReq) add(reqName(kv[2])); continue; }
        if (inReq && /^\s+\S/.test(ln)) add(reqName(ln));
      }
      continue;
    }
    // pyproject.toml and Pipfile are TOML: parsed, so a `]` inside a string (`"uvicorn[standard]"`) is no array end
    let doc;
    try { doc = parseToml(text); } catch { unparsed.push(rel); scanTomlLines(lines, add); continue; }
    const keys = t => isTable(t) ? Object.keys(t) : [];
    const specs = a => Array.isArray(a) ? a.filter(s => typeof s === 'string') : [];
    if (/(^|\/)Pipfile$/.test(rel)) { for (const n of [...keys(doc.packages), ...keys(doc['dev-packages'])]) add(n); continue; }
    const project = isTable(doc.project) ? doc.project : {}, poetry = isTable(doc.tool?.poetry) ? doc.tool.poetry : {};
    for (const s of specs(project.dependencies)) add(reqName(s));
    for (const a of Object.values(isTable(project['optional-dependencies']) ? project['optional-dependencies'] : {})) for (const s of specs(a)) add(reqName(s));
    for (const n of [...keys(poetry.dependencies), ...keys(poetry['dev-dependencies']),
      ...Object.values(isTable(poetry.group) ? poetry.group : {}).flatMap(g => keys(g?.dependencies))]) add(n);
  }
  return { names: out, unparsed };
}
