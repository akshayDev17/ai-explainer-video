import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL = join(ROOT, 'skills', 'explainer-video-from-codebase');
export const FIXTURES = join(SKILL, 'fixtures');
const MINE = join(SKILL, 'tools', 'mine.mjs');

export const scratch = () => mkdtempSync(join(tmpdir(), 'mine-test-'));
export const cleanup = dir => rmSync(dir, { recursive: true, force: true });

// run mine.mjs as the skill does: a child process, from an unrelated cwd, output outside the repo
export function mine(repo, ...flags) {
  const out = join(scratch(), 'out');
  const r = spawnSync(process.execPath, [MINE, repo, '--out', out, ...flags], { cwd: tmpdir(), encoding: 'utf8' });
  const codemap = existsSync(join(out, 'codemap.json')) ? JSON.parse(readFileSync(join(out, 'codemap.json'), 'utf8')) : null;
  const md = existsSync(join(out, 'codemap.md')) ? readFileSync(join(out, 'codemap.md'), 'utf8') : null;
  cleanup(dirname(out));
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, codemap, md };
}

export const short = id => id.split(':').pop();
export const edgesFrom = (m, from) => m.edges.filter(e => e.from === from);

// the rule-produced part of a code map, as sorted lines: what a pack's golden file pins
export function ruleView(m) {
  return {
    entries: m.entries.map(e => `${e.kind} ${e.id}${e.path ? ` ${e.method} ${e.path}` : e.key ? ` ${e.key}` : ''}`).sort(),
    links: m.edges.filter(e => e.rule).map(e => `${e.from} -> ${e.to} ${e.kind} ${e.rule}${e.group ? ` [${e.group}]` : ''}`).sort(),
  };
}

// compare against fixtures/expected/<pack>.json (kept outside the fixture repo, so mining never reads it);
// UPDATE_GOLDENS=1 rewrites it — review the diff before committing
export function assertGolden(pack, view) {
  const file = join(FIXTURES, 'expected', `${pack}.json`);
  if (process.env.UPDATE_GOLDENS) writeFileSync(file, JSON.stringify(view, null, 2) + '\n');
  assert.deepEqual(view, JSON.parse(readFileSync(file, 'utf8')));
}
