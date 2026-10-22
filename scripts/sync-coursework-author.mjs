#!/usr/bin/env node
/* Generate skills/coursework-author from the pinned coursework-author package.
 *
 * WHY A COPY, not a dependency: the four plugin hosts (Claude, Codex, Gemini, DSH) only
 * load skills from a plugin's OWN skills/ tree. None of them resolves a dependency, and
 * there is no cross-plugin mounting that survives all four. So the pipeline ships the
 * authoring skill as one of its own skills, generated from the package rather than
 * hand-maintained, with a provenance marker and a CI check that the two match.
 *
 * Usage: node scripts/sync-coursework-author.mjs [--from <path-to-package>]
 *   default source: node_modules/coursework-author
 */
import { cpSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashDir } from './lib/skill-hash.mjs';

const SKILL = 'coursework-author';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'skills', SKILL);

const i = process.argv.indexOf('--from');
const SRC = i > -1 ? resolve(process.argv[i + 1]) : join(ROOT, 'node_modules', SKILL);

if (!existsSync(SRC)) {
  console.error(`[sync] no ${SKILL} package at ${SRC}`);
  console.error('[sync] install it first (it is a devDependency), or pass --from <path>');
  process.exit(1);
}
const skillSrc = join(SRC, 'skills', SKILL);
if (!existsSync(join(skillSrc, 'SKILL.md'))) {
  console.error(`[sync] ${skillSrc}/SKILL.md not found — is this the ${SKILL} package?`);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'));

rmSync(DEST, { recursive: true, force: true });
cpSync(skillSrc, DEST, { recursive: true });

const sha = hashDir(DEST);
// No timestamp: the marker is a committed file, so a stamp would make every resync
// produce a diff even when the content is identical — and "sync is a no-op" would never
// hold. Provenance is package + version + content hash; the commit date supplies the rest.
writeFileSync(join(DEST, '.synced-from'),
  JSON.stringify({ package: SKILL, version, sha256: sha }, null, 2) + '\n');

const files = hashDir(DEST);
console.log(`[sync] ${SKILL}@${version} → skills/${SKILL}`);
console.log(`[sync] content sha256 ${files}`);
