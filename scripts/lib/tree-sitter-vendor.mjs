/* What the codebase skill vendors from npm, shared by the sync script and its drift check. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const RUNTIME = 'web-tree-sitter';
// language -> the package that ships its prebuilt tree-sitter-<language>.wasm
export const GRAMMARS = {
  python: 'tree-sitter-python',
  typescript: 'tree-sitter-typescript',
  tsx: 'tree-sitter-typescript',
  javascript: 'tree-sitter-javascript',
  go: 'tree-sitter-go',
  c: 'tree-sitter-c',
  cpp: 'tree-sitter-cpp',
};

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// devDependencies pin every vendored package exactly; a range would let the copy drift
export function pinnedVersion(root, name) {
  const v = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies?.[name];
  return v && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
}
