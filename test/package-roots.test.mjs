// An absolute import resolves at the repo root, beside a file in a non-package dir, or through a package root: the
// top of a contiguous run of __init__.py dirs. Of several claims the one under the importer's root wins, a claim
// under another root never captures a declared dependency, a standard-library name is never captured, and the
// self-check reports cross-root, ambiguous and namespace-package calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpSync, writeFileSync } from 'node:fs';
import { FIXTURES, mine, edgesFrom, short, scratch, cleanup } from './helpers.mjs';

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

test('a module in a namespace subpackage of a package resolves by either import form, and as a patch target', () => {
  assert.deepEqual(edgesFrom(m, 'backend.app.main:route').map(e => e.to), ['backend.app.api.routes:h', 'backend.app.api.routes:h']);
  assert.deepEqual(m.mocks.find(x => x.raw === 'app.api.routes.h')?.target, 'backend.app.api.routes:h');
});

test('a call through a package root that does not hold the importing file is reported with its count', () => {
  assert.deepEqual(m.selfCheck.crossRootImports, [{ name: 'jobs.run', root: 'worker/src', calls: 1 }]);
  assert.deepEqual(m.selfCheck.ambiguousImports, []);
  assert.match(r.md, /1 calls resolve through a package root that does not hold the importing file .*`jobs\.run` → `worker\/src\/` 1/);
});

test('a patch target is looked up through the package roots too', () => {
  assert.deepEqual(m.mocks.map(x => [x.raw, x.target]).sort(), [['app.api.routes.h', 'backend.app.api.routes:h'], ['app.services.send', 'backend.app.services:send']]);
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

test('a name two package roots claim: each importer reaches the claim under its own root; one under neither is reported lost', () => {
  const a = mine(join(FIXTURES, 'package-roots-ambiguous'));
  assert.equal(a.status, 0, a.stderr);
  assert.deepEqual(a.codemap.selfCheck.packageRoots, ['services/a', 'services/b']);
  assert.deepEqual(edgesFrom(a.codemap, 'services.a.app.main:handle').map(e => e.to), ['services.a.app.util:f']);
  assert.deepEqual(edgesFrom(a.codemap, 'services.b.app.main:handle').map(e => e.to), ['services.b.app.util:f']);
  assert.deepEqual(edgesFrom(a.codemap, 'services.a.run:go').map(e => e.to), ['services.a.app.util:f']);
  assert.deepEqual(edgesFrom(a.codemap, 'services.run_all:go'), []);
  assert.deepEqual(a.codemap.selfCheck.ambiguousImports, [{ name: 'app.util', roots: ['services/a', 'services/b'], calls: 1 }]);
  assert.deepEqual(a.codemap.selfCheck.crossRootImports, []);
  assert.match(a.md, /\*\*1 calls are not linked: their import names a module several package roots claim and none holds the importing file\*\*: `app\.util` 1 \(`services\/a\/`, `services\/b\/`\)/);
});

test('a package under another root never captures a declared dependency (integrations/stripe, clients/httpx); an undeclared one resolves and is reported', () => {
  const d = mine(join(FIXTURES, 'package-roots-declared'));
  assert.equal(d.status, 0, d.stderr);
  assert.deepEqual(d.codemap.selfCheck.packageRoots, ['clients', 'integrations', 'plugins', 'vendor']);
  assert.deepEqual(edgesFrom(d.codemap, 'app.billing:charge'), [], '`Stripe` in requirements.txt declares `import stripe`');
  assert.deepEqual(edgesFrom(d.codemap, 'app.fetch:fetch'), [], '`httpx` in pyproject [project] dependencies, after an extras entry `uvicorn[standard]`');
  assert.deepEqual(edgesFrom(d.codemap, 'app.notify:ping').map(e => e.to), ['plugins.acme:ping']);
  assert.deepEqual(d.codemap.selfCheck.crossRootImports, [{ name: 'acme', root: 'plugins', calls: 1 }]);
  assert.deepEqual(d.codemap.selfCheck.ambiguousImports, [], 'integrations/stripe and vendor/stripe both claim the declared `stripe`: a library import, not a lost call');
  assert.doesNotMatch(d.md, /calls are not linked/);
});

test('a pyproject.toml that is not valid TOML still declares its dependencies and is named in the self-check', () => {
  const dir = scratch(), repo = join(dir, 'repo');
  cpSync(join(FIXTURES, 'package-roots-declared'), repo, { recursive: true });
  writeFileSync(join(repo, 'pyproject.toml'), '[project]\nname = "shop"\nname = "shop"\ndependencies = [\n  "uvicorn[standard]>=0.2",\n  "httpx>=0.27",\n]\n');
  const d = mine(repo);
  cleanup(dir);
  assert.equal(d.status, 0, d.stderr);
  assert.deepEqual(edgesFrom(d.codemap, 'app.fetch:fetch'), [], '`httpx` is still declared, so clients/httpx does not capture it');
  assert.deepEqual(d.codemap.selfCheck.dependencyFilesNotParsed, ['pyproject.toml']);
  assert.match(d.md, /dependency files that are not valid TOML, their names read line by line\*\*: `pyproject\.toml`/);
  assert.deepEqual(mine(join(FIXTURES, 'package-roots-declared')).codemap.selfCheck.dependencyFilesNotParsed, []);
});

test('a call reached through a re-export in another root\'s package __init__.py is reported as cross-root', () => {
  const x = mine(join(FIXTURES, 'package-roots-reexport'));
  assert.equal(x.status, 0, x.stderr);
  assert.deepEqual(edgesFrom(x.codemap, 'app.notify:notify').map(e => e.to), ['plugins.acme.core:ping']);
  assert.deepEqual(x.codemap.selfCheck.crossRootImports, [{ name: 'acme', root: 'plugins', calls: 1 }]);
});

test('calls into a namespace package (no __init__.py) named like an in-repo dir are reported, with their rate', () => {
  const n = mine(join(FIXTURES, 'package-roots-namespace'));
  assert.equal(n.status, 0, n.stderr);
  assert.deepEqual(n.codemap.selfCheck.packageRoots, []);
  assert.deepEqual(n.codemap.selfCheck.externalLikeRepoDirs.names, [{ name: 'app', calls: 2, dirs: ['backend/app'] }]);
  assert.equal(n.codemap.selfCheck.externalLikeRepoDirs.rate, 1);
  assert.match(n.md, /2 calls \(100\.0%\) go to imports resolved as external although an in-repo directory with no `__init__\.py` has their name\*\*: `app` 2 \(`backend\/app\/`\)/);
});
