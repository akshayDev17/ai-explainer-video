// scripts/check-skill-sync.mjs: the dual-file rule between a main SKILL.md and its stage skills, on the real
// skills and on copies drifted one way at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, scratch, cleanup } from './helpers.mjs';

const CHECK = join(ROOT, 'scripts', 'check-skill-sync.mjs');
const check = root => spawnSync(process.execPath, [CHECK, ...(root ? ['--root', root] : [])], { encoding: 'utf8' });
const PIPELINE = /^(explainer-video-from-co(debase|ursework)|craft-codeflow-|craft-video-)/;

// a copy of every pipeline skill's SKILL.md, with `edit(name, text) -> text` applied
function drifted(edit) {
  const root = scratch();
  for (const d of readdirSync(join(ROOT, 'skills')).filter(d => PIPELINE.test(d))) {
    mkdirSync(join(root, 'skills', d), { recursive: true });
    cpSync(join(ROOT, 'skills', d, 'SKILL.md'), join(root, 'skills', d, 'SKILL.md'));
  }
  for (const d of readdirSync(join(root, 'skills'))) {
    const f = join(root, 'skills', d, 'SKILL.md');
    writeFileSync(f, edit(d, readFileSync(f, 'utf8')));
  }
  const r = check(root);
  cleanup(root);
  return r;
}
const only = (name, fn) => (d, text) => (d === name ? fn(text) : text);
const replaceOnce = (text, from, to) => { assert.ok(text.includes(from), `fixture text not found: ${from}`); return text.replace(from, to); };

test('the codebase skill and its four stage skills are in step, and so are the coursework stage skills', () => {
  const r = check();
  assert.equal(r.status, 0, r.stderr);
  for (const child of ['craft-codeflow-mine', 'craft-codeflow-flows', 'craft-codeflow-plan', 'craft-codeflow-scene', 'craft-video-scene'])
    assert.match(r.stdout, new RegExp(`✓ skills/${child}/SKILL.md in step`));
  assert.equal(drifted((d, t) => t).status, 0, 'an unchanged copy passes');
});

test('a reworded gate in a stage skill fails, naming the sync block', () => {
  const r = drifted(only('craft-codeflow-flows', t => replaceOnce(t, 'never assume approval', 'assume approval when unsure')));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /craft-codeflow-flows\/SKILL\.md: sync block "approve" differs/);
});

test('the main skill changed alone fails too: every child carrying the block is named', () => {
  const r = drifted(only('explainer-video-from-codebase', t => replaceOnce(t, 'at most 3', 'at most 4')));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /craft-codeflow-scene\/SKILL\.md: sync block "stage3-addendum" differs/);
});

test('a flag one side invokes and the other does not fails, outside any sync block too', () => {
  const r = drifted(only('craft-codeflow-scene', t => replaceOnce(t, 'stamp.mjs end   --out', 'stamp.mjs end   --force --out')));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /craft-codeflow-scene\/SKILL\.md: runs `explainer-video-from-coursework:stamp --force --out --stage --video`/);
});

test('a Maintenance note naming a missing section, or a section renamed in the main skill, fails', () => {
  const renamed = drifted(only('explainer-video-from-codebase', t => replaceOnce(t, '## Stage 1c — `/plan`', '## Stage 1c — `/planning`')));
  assert.equal(renamed.status, 1);
  assert.match(renamed.stderr, /craft-codeflow-plan\/SKILL\.md: its Maintenance note names "Stage 1c — \/plan", which is no section/);
  const coursework = drifted(only('craft-video-audio', t => replaceOnce(t, '"Stage 4 — /audio"', '"Stage 4 — /tts"')));
  assert.equal(coursework.status, 1, 'the coursework stage skills are held to their sections too');
  assert.match(coursework.stderr, /craft-video-audio\/SKILL\.md: its Maintenance note names "Stage 4 — \/tts"/);
});

test('a sync block only the main skill has, or a broken marker, fails', () => {
  const orphan = drifted(only('explainer-video-from-codebase', t => t + '\n<!-- sync:new-rule -->\nA rule.\n<!-- /sync:new-rule -->\n'));
  assert.equal(orphan.status, 1);
  assert.match(orphan.stderr, /sync block "new-rule" is in no child skill/);
  const open = drifted(only('craft-codeflow-plan', t => replaceOnce(t, '<!-- /sync:plan -->', '')));
  assert.equal(open.status, 1);
  assert.match(open.stderr, /craft-codeflow-plan\/SKILL\.md: sync block "plan" is not closed/);
});

test('a stage skill the main skill never names fails', () => {
  const r = drifted((d, t) => (d === 'explainer-video-from-codebase' ? t.replaceAll('`craft-codeflow-plan`', 'the plan skill') : t));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /never names `craft-codeflow-plan`/);
});

test('a code-flow block in a coursework stage skill is held to the codebase skill', () => {
  const child = drifted(only('craft-video-script', t => replaceOnce(t, 'never for a `"strength": "reachable"` citation', 'or for a reachable one')));
  assert.equal(child.status, 1);
  assert.match(child.stderr, /craft-video-script\/SKILL\.md: sync block "stage3-addendum" differs from skills\/explainer-video-from-codebase\/SKILL\.md/);
  const main = drifted(only('explainer-video-from-codebase', t => replaceOnce(t, 'Never use a module path.', 'A module path is fine.')));
  assert.equal(main.status, 1);
  for (const c of ['publish', 'render', 'assemble'])
    assert.match(main.stderr, new RegExp(`craft-video-${c}/SKILL\\.md: sync block "codeflow-publish-render" differs`));
  const dropped = drifted((d, t) => (/^craft-video-(publish|render|assemble)$/.test(d) ? t.replace(/<!-- sync:codeflow-publish-render -->[\s\S]*?<!-- \/sync:codeflow-publish-render -->\n/, '') : t));
  assert.equal(dropped.status, 1);
  assert.match(dropped.stderr, /explainer-video-from-codebase\/SKILL\.md: sync block "codeflow-publish-render" is in no child skill/);
});
