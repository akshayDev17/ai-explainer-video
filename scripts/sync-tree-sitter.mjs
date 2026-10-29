#!/usr/bin/env node
/* Vendor the tree-sitter runtime and the prebuilt grammar WASM into the codebase skill.
 *
 * WHY VENDORED, not a dependency: Antigravity installs by git clone and never runs
 * `npm install`, and the mining tool must work offline. So the runtime and the seven
 * grammars ship inside skills/explainer-video-from-codebase/vendor/tree-sitter/, copied
 * from the exact versions pinned in devDependencies, with MANIFEST.json recording where
 * each file came from and its sha256. scripts/check-tree-sitter-vendor.mjs is the gate.
 *
 * The runtime's file names changed between web-tree-sitter 0.25 and 0.27, so they are
 * read from the package's own `exports`, never hard-coded; the loader reads them back
 * from MANIFEST.json.
 *
 * Usage: node scripts/sync-tree-sitter.mjs   (after `npm ci --ignore-scripts`)
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME, GRAMMARS, sha256, pinnedVersion } from './lib/tree-sitter-vendor.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'skills', 'explainer-video-from-codebase', 'vendor', 'tree-sitter');
const pkgDir = name => join(ROOT, 'node_modules', name);

const problems = [];
const pkgJson = name => {
  const p = join(pkgDir(name), 'package.json');
  if (!existsSync(p)) { problems.push(`${name} is not installed — run: npm ci --ignore-scripts`); return null; }
  const j = JSON.parse(readFileSync(p, 'utf8'));
  const want = pinnedVersion(ROOT, name);
  if (j.version !== want) problems.push(`${name}: installed ${j.version}, pinned ${want}`);
  return j;
};
const rt = pkgJson(RUNTIME);
const grammarPkgs = [...new Set(Object.values(GRAMMARS))].map(name => [name, pkgJson(name)]);
if (problems.length) { for (const p of problems) console.error('[sync] ' + p); process.exit(1); }

// web-tree-sitter: the ESM entry from `exports`, and the one .wasm export next to it
const jsRel = rt.exports['.'].import.default.replace(/^\.\//, '');
const wasmRel = Object.keys(rt.exports).find(k => !k.includes('debug') && k.endsWith('.wasm')).replace(/^\.\//, '');

rmSync(DEST, { recursive: true, force: true });
mkdirSync(join(DEST, 'LICENSES'), { recursive: true });
const files = {};
const take = (pkg, rel) => {
  const name = basename(rel);
  copyFileSync(join(pkgDir(pkg), rel), join(DEST, name));
  const bytes = readFileSync(join(DEST, name));
  files[name] = { from: `${pkg}/${rel}`, bytes: bytes.length, sha256: sha256(bytes) };
  return name;
};
const licenses = {};
const license = (pkg, version) => {
  const lic = readdirSync(pkgDir(pkg)).find(f => /^licen[cs]e/i.test(f));
  if (!lic) { console.error(`[sync] ${pkg} ships no LICENSE file`); process.exit(1); }
  const name = `LICENSES/${pkg}.txt`;
  copyFileSync(join(pkgDir(pkg), lic), join(DEST, name));
  const bytes = readFileSync(join(DEST, name));
  files[name] = { from: `${pkg}/${lic}`, bytes: bytes.length, sha256: sha256(bytes) };
  licenses[pkg] = { version, license: JSON.parse(readFileSync(join(pkgDir(pkg), 'package.json'), 'utf8')).license, file: name };
};

const runtime = { package: RUNTIME, version: rt.version, js: take(RUNTIME, jsRel), wasm: take(RUNTIME, wasmRel) };
license(RUNTIME, rt.version);
const grammars = {};
for (const [lang, pkg] of Object.entries(GRAMMARS)) {
  const version = grammarPkgs.find(([n]) => n === pkg)[1].version;
  const wasm = `tree-sitter-${lang}.wasm`;
  if (!existsSync(join(pkgDir(pkg), wasm))) { console.error(`[sync] ${pkg}@${version} has no prebuilt ${wasm}`); process.exit(1); }
  grammars[lang] = { package: pkg, version, file: take(pkg, wasm) };
}
for (const [pkg, j] of grammarPkgs) license(pkg, j.version);

// prove every grammar loads in the vendored runtime before recording it
const { Parser, Language } = await import(join(DEST, runtime.js));
await Parser.init();
for (const g of Object.values(grammars)) g.abi = (await Language.load(join(DEST, g.file))).abiVersion;

const sortKeys = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
writeFileSync(join(DEST, 'MANIFEST.json'), JSON.stringify({
  generatedBy: 'scripts/sync-tree-sitter.mjs', runtime, grammars, licenses: sortKeys(licenses), files: sortKeys(files),
}, null, 2) + '\n');
const total = Object.values(files).reduce((a, f) => a + f.bytes, 0);
console.log(`[sync] ${RUNTIME}@${rt.version} + ${Object.keys(grammars).length} grammars → ${DEST.slice(ROOT.length + 1)} (${(total / 1e6).toFixed(1)} MB)`);
