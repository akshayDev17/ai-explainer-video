/* Load the vendored tree-sitter runtime and grammars. File names come from MANIFEST.json
   (written by scripts/sync-tree-sitter.mjs), never from node_modules, so the tools run
   from a git clone with no `npm install` and from any cwd. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VENDOR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'tree-sitter');

export async function loadGrammars(langs) {
  const manifest = JSON.parse(readFileSync(join(VENDOR, 'MANIFEST.json'), 'utf8'));
  const { Parser, Language } = await import(pathToFileURL(join(VENDOR, manifest.runtime.js)).href);
  await Parser.init();
  const grammars = {};
  for (const lang of langs) grammars[lang] = await Language.load(join(VENDOR, manifest.grammars[lang].file));
  const versions = { [manifest.runtime.package]: manifest.runtime.version,
    ...Object.fromEntries(langs.map(l => [manifest.grammars[l].package, manifest.grammars[l].version])) };
  return { Parser, grammars, versions };
}
