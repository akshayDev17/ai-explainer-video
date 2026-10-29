/* Config facts from TOML, line by line: `key = value` leaves (tables are not tracked; keys are leaf names). */
export const matches = rel => /\.toml$/.test(rel);

export function readFacts(text) {
  const out = [];
  text.split('\n').forEach((ln, i) => {
    const m = ln.match(/^\s*["']?([A-Za-z][A-Za-z0-9_.-]*)["']?\s*=\s*(.*)$/);
    if (!m) return;
    const value = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
    if (value !== '') out.push({ key: m[1], value, line: i + 1 });
  });
  return out;
}
