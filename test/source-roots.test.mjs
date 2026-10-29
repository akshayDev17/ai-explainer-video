// A Python backend under backend/ that imports itself as `app.*`, and a worker whose pyproject.toml names src/:
// absolute imports resolve against the detected source roots, and calls into an import named like an in-repo
// directory that still resolved as external are reported by the self-check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FIXTURES, mine, edgesFrom, short } from './helpers.mjs';

const REPO = join(FIXTURES, 'source-roots');
const r = mine(REPO);
const m = r.codemap;

test('source roots: the parent of a self-imported package, and a pyproject dir with its `where`', () => {
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(m.selfCheck.sourceRoots, ['worker/src', 'backend', 'worker']);
});

test('imports by absolute name resolve inside the source root', () => {
  assert.deepEqual(edgesFrom(m, 'backend.app.main:handle').map(e => e.to).sort(), ['backend.app.services:send', 'backend.app.services:send']);
  assert.deepEqual(m.tests.find(t => short(t.id) === 'test_send').direct.map(d => d.to), ['backend.app.services:send']);
  assert.deepEqual(m.tests.find(t => short(t.id) === 'test_go').direct.map(d => d.to), ['worker.src.jobs.run:go']);
});

test('a patch target is looked up through the source roots too', () => {
  assert.deepEqual(m.mocks.map(x => [x.raw, x.target]), [['app.services.send', 'backend.app.services:send']]);
  assert.deepEqual(m.tests.find(t => short(t.id) === 'test_handle').direct.map(d => d.to), ['backend.app.main:handle']);
});

test('nothing is external under a name an in-repo directory has', () => {
  assert.equal(m.selfCheck.externalLikeRepoDirs.calls, 0);
});

test('calls into an in-repo-named import that resolved as external are reported, with their rate', () => {
  const x = mine(REPO, '--exclude', 'backend/app/services.py');
  assert.equal(x.status, 0, x.stderr);
  assert.deepEqual(x.codemap.selfCheck.externalLikeRepoDirs.names, [{ name: 'app', calls: 3, dirs: ['backend/app'] }]);
  assert.ok(x.codemap.selfCheck.externalLikeRepoDirs.rate > 0.5);
  assert.match(x.md, /3 calls \(\d+\.\d%\) go to imports resolved as external although an in-repo directory has their name\*\*: `app` 3 \(`backend\/app\/`\)/);
});
