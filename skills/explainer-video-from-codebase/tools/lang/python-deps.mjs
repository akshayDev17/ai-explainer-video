/* The third-party names a repo declares as dependencies: requirements*.txt, pyproject.toml ([project] dependencies and
   optional-dependencies, Poetry dependency tables), setup.cfg install_requires / extras_require, and Pipfile. Names are
   normalised (case, `-` / `_` / `.`) so `Stripe` declares `import stripe`. Read line by line, never executed. */
export const DEPENDENCY_FILES = /(^|\/)(requirements[\w.-]*\.txt|pyproject\.toml|setup\.cfg|Pipfile)$/;
export const normaliseDep = name => name.toLowerCase().replace(/[-_.]+/g, '_');

const reqName = spec => /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec)?.[1] ?? null;
const quoted = line => [...line.matchAll(/["']([^"']+)["']/g)].map(m => m[1]);

export function declaredDependencies(files) {
  const out = new Set();
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
    // TOML-shaped: pyproject.toml and Pipfile
    let table = '', inArray = false;
    for (const ln of lines) {
      const head = /^\s*\[([^\]]+)\]\s*$/.exec(ln);
      if (head) { table = head[1].trim(); inArray = false; continue; }
      const keyTable = /^(tool\.poetry(\.group\.[\w-]+)?\.(dev-)?dependencies|packages|dev-packages)$/.test(table);
      if (keyTable) { const k = /^\s*["']?([A-Za-z0-9][\w.-]*)["']?\s*=/.exec(ln); if (k) add(k[1]); continue; }
      const arrayTable = table === 'project' || table === 'project.optional-dependencies';
      if (!arrayTable) continue;
      const start = /^\s*([\w-]+)\s*=\s*\[(.*)$/.exec(ln);
      if (start && (table === 'project.optional-dependencies' || start[1] === 'dependencies')) {
        for (const s of quoted(start[2])) add(reqName(s));
        inArray = !/\]/.test(start[2]);
      } else if (inArray) { for (const s of quoted(ln)) add(reqName(s)); if (/\]/.test(ln)) inArray = false; }
    }
  }
  return out;
}
