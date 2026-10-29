#!/usr/bin/env node
/* Drift gate for the vendored tree-sitter runtime and grammars.
 *
 * Always (offline): every file MANIFEST.json lists is present with its recorded size and
 * sha256, nothing unlisted sits beside them, and each recorded version is the exact pin
 * in devDependencies. With --installed (CI, after `npm ci --ignore-scripts`): each vendored
 * file is also byte-identical to the file it was copied from in node_modules, so a version
 * bump that skipped the resync fails here.
 *
 * Usage: node scripts/check-tree-sitter-vendor.mjs [--installed]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME, GRAMMARS, sha256, pinnedVersion } from './lib/tree-sitter-vendor.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'skills', 'explainer-video-from-codebase', 'vendor', 'tree-sitter');
const INSTALLED = process.argv.includes('--installed');

const problems = [];
let m = null;
try { m = JSON.parse(readFileSync(join(DEST, 'MANIFEST.json'), 'utf8')); }
catch { console.error('[check] vendor/tree-sitter/MANIFEST.json is missing — run: node scripts/sync-tree-sitter.mjs'); process.exit(1); }

const listed = new Set(Object.keys(m.files));
const onDisk = (function walk(dir) {
  return readdirSync(dir).flatMap(n => statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [relative(DEST, join(dir, n))]);
})(DEST).filter(f => f !== 'MANIFEST.json');
for (const f of onDisk) if (!listed.has(f)) problems.push(`${f} is not in MANIFEST.json`);
for (const [f, rec] of Object.entries(m.files)) {
  const p = join(DEST, f);
  if (!existsSync(p)) { problems.push(`${f} is listed but missing`); continue; }
  const bytes = readFileSync(p);
  if (bytes.length !== rec.bytes || sha256(bytes) !== rec.sha256) problems.push(`${f} does not match its recorded sha256`);
  if (INSTALLED) {
    const src = join(ROOT, 'node_modules', rec.from);
    if (!existsSync(src)) problems.push(`${rec.from} is not installed`);
    else if (sha256(readFileSync(src)) !== rec.sha256) problems.push(`${f} differs from the installed ${rec.from}`);
  }
}
const recorded = { [RUNTIME]: m.runtime.version, ...Object.fromEntries(Object.values(m.grammars).map(g => [g.package, g.version])) };
for (const pkg of [RUNTIME, ...new Set(Object.values(GRAMMARS))]) {
  const pin = pinnedVersion(ROOT, pkg);
  if (!pin) problems.push(`devDependencies must pin ${pkg} to an exact version`);
  else if (recorded[pkg] !== pin) problems.push(`${pkg}: vendored ${recorded[pkg] ?? 'nothing'}, pinned ${pin}`);
}
for (const lang of Object.keys(GRAMMARS)) if (!m.grammars[lang]) problems.push(`no vendored grammar for ${lang}`);

if (problems.length) {
  console.error('[check] the vendored tree-sitter copy has drifted:');
  for (const p of problems) console.error('  ✗ ' + p);
  console.error('[check] fix: npm ci --ignore-scripts && node scripts/sync-tree-sitter.mjs && git add skills/explainer-video-from-codebase/vendor');
  process.exit(1);
}
console.log(`[check] vendor/tree-sitter matches MANIFEST.json (${listed.size} files${INSTALLED ? ', and node_modules' : ''})`);
