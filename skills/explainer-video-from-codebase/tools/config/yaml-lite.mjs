/* Config facts from YAML (incl. Helm values and k8s manifests), line by line: `key: value` leaves, and the
   container-env shape `- name: KEY` followed by `value: v`, which sets KEY. Block scalars (`|`, `>`) are skipped. */
export const matches = rel => /\.ya?ml$/.test(rel);

export function readFacts(text) {
  const out = [];
  let envName = null;
  text.split('\n').forEach((ln, i) => {
    const m = ln.match(/^\s*(?:-\s*)?["']?([A-Za-z][A-Za-z0-9_.-]*)["']?\s*:\s*(.*)$/);
    if (!m) return;
    const value = m[2].replace(/\s+#.*$/, '').replace(/^["']|["'],?$/g, '').trim();
    if (m[1] === 'name' && /^\s*-\s*name\s*:/.test(ln)) envName = value;
    else if (m[1] === 'value' && envName) { if (value !== '') out.push({ key: envName, value, line: i + 1 }); envName = null; return; }
    if (value === '' || value === '|' || value === '>' || /^[|>][-+]?$/.test(value)) return;
    out.push({ key: m[1], value, line: i + 1 });
  });
  return out;
}
