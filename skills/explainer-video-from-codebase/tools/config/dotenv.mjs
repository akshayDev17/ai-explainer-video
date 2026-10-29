/* Config facts from `.env`-style files: `KEY=value`, `export KEY=value`, trailing `# comment` dropped. */
export const matches = rel => /(^|\/)(\.env(\.[\w-]+)?|[\w.-]+\.env(\.example)?|sample\.env)$/.test(rel);

export function readFacts(text) {
  const out = [];
  text.split('\n').forEach((ln, i) => {
    const m = ln.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return;
    const value = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
    if (value !== '') out.push({ key: m[1], value, line: i + 1 });
  });
  return out;
}
