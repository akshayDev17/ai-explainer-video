#!/usr/bin/env node
/* CI gate: the vendored copy must be byte-identical to the installed package.
 *
 * This is the generated-artifact check (protobuf/GraphQL style): generate, commit, and
 * fail the build if the committed copy has drifted from its source. It makes hand-editing
 * skills/coursework-author impossible to merge.
 *
 * Usage: node scripts/check-coursework-author-sync.mjs [--from <path-to-package>]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashDir } from './lib/skill-hash.mjs';

const SKILL = 'coursework-author';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'skills', SKILL);
const i = process.argv.indexOf('--from');
const SRC = i > -1 ? resolve(process.argv[i + 1]) : join(ROOT, 'node_modules', SKILL);

if (!existsSync(SRC)) {
  console.error(`[check] no ${SKILL} package at ${SRC} — cannot verify the vendored copy`);
  process.exit(1);
}
if (!existsSync(DEST)) {
  console.error(`[check] skills/${SKILL} is missing — run: npm run sync:${SKILL}`);
  process.exit(1);
}

const want = hashDir(join(SRC, 'skills', SKILL));
const got = hashDir(DEST);
const { version } = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'));

let marked = null;
try { marked = JSON.parse(readFileSync(join(DEST, '.synced-from'), 'utf8')); } catch {}

const problems = [];
if (want !== got) problems.push(`content differs from ${SKILL}@${version} (source ${want.slice(0, 12)} ≠ vendored ${got.slice(0, 12)})`);
if (marked && marked.version !== version) problems.push(`.synced-from says ${marked.version} but the installed package is ${version}`);
if (!marked) problems.push('.synced-from is missing');

if (problems.length) {
  console.error('[check] the vendored skill is stale:');
  for (const p of problems) console.error('  ✗ ' + p);
  console.error(`[check] fix: npm run sync:${SKILL} && git add skills/${SKILL}`);
  process.exit(1);
}
console.log(`[check] skills/${SKILL} matches ${SKILL}@${version} — sha256 ${got.slice(0, 12)}`);
