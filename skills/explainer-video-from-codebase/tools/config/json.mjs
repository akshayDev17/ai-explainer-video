/* Config facts from JSON, line by line: `"key": value` pairs (leaf scalars; objects and arrays are skipped).
   package.json, lockfiles and tsconfig are tooling, not configuration of the code. */
export const matches = rel => /\.json$/.test(rel) && !/(^|\/)(package(-lock)?\.json|tsconfig[\w.-]*\.json)$/.test(rel);

export function readFacts(text) {
  const out = [];
  text.split('\n').forEach((ln, i) => {
    const m = ln.match(/^\s*"([A-Za-z][A-Za-z0-9_.-]*)"\s*:\s*(.*?)\s*,?\s*$/);
    if (!m || /^[[{]/.test(m[2])) return;
    const value = m[2].replace(/^"|"$/g, '').trim();
    if (value !== '') out.push({ key: m[1], value, line: i + 1 });
  });
  return out;
}
