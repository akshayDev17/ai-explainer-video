// An absolute import resolves at the repo root, beside a file in a non-package dir, or through a package root: the
// top of a contiguous run of __init__.py dirs. A name two files claim stays external, a standard-library name is never
// captured by an in-repo loose module, namespace dir or nested package, and calls into a namespace package (no
// __init__.py) named like an in-repo dir are reported by the self-check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FIXTURES, mine, edgesFrom, short } from './helpers.mjs';

const r = mine(join(FIXTURES, 'package-roots'));
const m = r.codemap;

test('package roots: backend/ holds the package app/, worker/src/ the package jobs/', () => {
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(m.selfCheck.packageRoots, ['backend', 'worker/src']);
});

test('backend/app imported as app.* resolves, from inside the package and from tests beside it', () => {
  assert.deepEqual(edgesFrom(m, 'backend.app.main:handle').map(e => e.to).sort(), ['backend.app.services:send', 'backend.app.services:send']);
  assert.deepEqual(m.tests.find(t => short(t.id) === 'test_send').direct.map(d => d.to), ['backend.app.services:send']);
  assert.deepEqual(m.tests.find(t => short(t.id) === 'test_go').direct.map(d => d.to), ['worker.src.jobs.run:go']);
});

test('a patch target is looked up through the package roots too', () => {
  assert.deepEqual(m.mocks.map(x => [x.raw, x.target]), [['app.services.send', 'backend.app.services:send']]);
  assert.deepEqual(m.tests.find(t => short(t.id) === 'test_handle').direct.map(d => d.to), ['backend.app.main:handle']);
  assert.equal(m.selfCheck.externalLikeRepoDirs.calls, 0);
});

test('the Flask layout: names the package __init__.py assigns (`app`, `db`, `__version__`) need no proof', () => {
  const f = mine(join(FIXTURES, 'package-roots-flask'));
  assert.equal(f.status, 0, f.stderr);
  assert.deepEqual(f.codemap.selfCheck.packageRoots, ['backend']);
  assert.ok(edgesFrom(f.codemap, 'backend.app.api.routes:handler').some(e => e.to === 'backend.app.models:save'));
});

test('an in-repo package named like a library (myapp/integrations/redis) is myapp.integrations.redis and never captures `import redis`', () => {
  const w = mine(join(FIXTURES, 'package-roots-wrapper'));
  assert.equal(w.status, 0, w.stderr);
  assert.deepEqual(w.codemap.selfCheck.packageRoots, []);
  assert.equal(edgesFrom(w.codemap, 'myapp.integrations.cache:make').some(e => e.to.startsWith('myapp.integrations.redis')), false);
  assert.equal(edgesFrom(w.codemap, 'myapp.integrations.redis:connect').some(e => e.to.startsWith('myapp.integrations.redis')), false);
  assert.deepEqual(w.codemap.entries.map(e => `${e.kind} ${e.id}`), ['queue-consumer myapp.integrations.tasks:job']);
});

test('app/logging, app/http, app/email, a loose logging.py and a package email/ never capture the standard library', () => {
  const s = mine(join(FIXTURES, 'package-roots-stdlib'));
  assert.equal(s.status, 0, s.stderr);
  const run = edgesFrom(s.codemap, 'backend.app.main:run').map(e => e.to);
  assert.deepEqual(run.sort(), ['backend.app.logging.handlers:JsonHandler'], 'only `from app.logging import JsonHandler` is in-repo');
  assert.deepEqual(edgesFrom(s.codemap, 'backend.scripts.run:main'), []);
  assert.equal(s.codemap.selfCheck.unresolvedByOrigin.inRepo, 0);
  assert.equal(s.codemap.selfCheck.externalLikeRepoDirs.calls, 0);
});

test('a dotted name two package roots claim stays external; a file beside one of them still reaches its own', () => {
  const a = mine(join(FIXTURES, 'package-roots-ambiguous'));
  assert.equal(a.status, 0, a.stderr);
  assert.deepEqual(a.codemap.selfCheck.packageRoots, ['services/a', 'services/b']);
  assert.deepEqual(edgesFrom(a.codemap, 'services.run_all:go'), []);
  assert.equal(a.codemap.selfCheck.unresolvedByOrigin.external, 1);
  assert.deepEqual(edgesFrom(a.codemap, 'services.a.run:go').map(e => e.to), ['services.a.app.util:f']);
});

test('calls into a namespace package (no __init__.py) named like an in-repo dir are reported, with their rate', () => {
  const n = mine(join(FIXTURES, 'package-roots-namespace'));
  assert.equal(n.status, 0, n.stderr);
  assert.deepEqual(n.codemap.selfCheck.packageRoots, []);
  assert.deepEqual(n.codemap.selfCheck.externalLikeRepoDirs.names, [{ name: 'app', calls: 2, dirs: ['backend/app'] }]);
  assert.equal(n.codemap.selfCheck.externalLikeRepoDirs.rate, 1);
  assert.match(n.md, /2 calls \(100\.0%\) go to imports resolved as external although an in-repo directory with no `__init__\.py` has their name\*\*: `app` 2 \(`backend\/app\/`\)/);
});
