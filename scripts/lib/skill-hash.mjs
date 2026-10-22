/* Deterministic hash of a skill directory: sorted relative paths + file bytes.
   Ignores .synced-from, which is generated provenance rather than skill content. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const IGNORE = new Set(['.synced-from', '.DS_Store']);

export function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    if (IGNORE.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out.sort();
}

export function hashDir(dir) {
  const h = createHash('sha256');
  for (const rel of walk(dir)) {
    h.update(rel);
    h.update('\0');
    h.update(readFileSync(join(dir, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}
