// Each rule pack's fixture, mined and diffed against its golden links, plus the facts each pack exists for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FIXTURES, mine, ruleView, assertGolden, edgesFrom, short } from './helpers.mjs';

const pack = name => {
  const r = mine(join(FIXTURES, 'rules', name));
  assert.equal(r.status, 0, r.stderr);
  return r.codemap;
};

test('fastapi: routes carry include_router + APIRouter prefixes; Depends links and narrows', () => {
  const m = pack('fastapi');
  assertGolden('fastapi', ruleView(m));
  const read = edgesFrom(m, 'app.routers.items:read_item').find(e => e.to === 'app.deps:MemoryStore.load');
  assert.ok(read, 'store: Annotated[Store, Depends(get_store)] resolves store.load() to what get_store returns');
  assert.equal(read.narrowedBy, 'app.deps:get_store');
});

test('fastapi: a route needs a router receiver, so `@mock.patch(...)` on a test is no route', () => {
  const m = pack('fastapi-layouts');
  assert.equal(m.entries.filter(e => e.group === 'test').length, 0);
  assert.equal(m.entries.some(e => e.id === 'tests.test_users:test_get_user'), false);
});

test('fastapi: prefixes compose along nested include_router calls, an imported alias, a package re-export and an app factory; an APIRouter subclass routes', () => {
  const m = pack('fastapi-layouts');
  assert.deepEqual(m.entries.filter(e => e.kind === 'http').map(e => `${e.method} ${e.path} ${short(e.id)}`).sort(), [
    'GET /admin/stats stats',
    'GET /api/v1/users/{user_id} get_user',
    'GET /health create_app.<locals>.health',
    'POST /shop/items create_item',
  ]);
  assert.ok(m.edges.some(e => e.rule === 'py.http-client' && e.from === 'tests.test_users:test_over_http' && e.to === 'app.routers.users:get_user'));
});

test('celery-taskiq: literal keys, .kiq/.delay and send_task link to consumers; unknown keys do not', () => {
  const m = pack('celery-taskiq');
  assertGolden('celery-taskiq', ruleView(m));
  assert.equal(edgesFrom(m, 'worker.producer:unknown_key').filter(e => e.kind === 'queue').length, 0);
  assert.equal(m.entries.find(e => e.id === 'worker.tasks:nightly').kind, 'scheduled');
});

test('registry: only constructors that reach the dispatcher produce; a test producer is labelled test', () => {
  const m = pack('registry');
  assertGolden('registry', ruleView(m));
  const key = m.rules.registry.find(k => k.key === 'jobs.cleanup');
  assert.deepEqual([key.candidates, key.kept], [1, 0], 'describe() builds a CleanupJob but never enqueues it');
  const fromTest = m.edges.find(e => e.rule === 'registry' && e.from.startsWith('tests.'));
  assert.equal(fromTest.group, 'test');
  assert.deepEqual(fromTest.groups, ['test', 'prod']);
});

test('haystack: run() calls each component in connect order; a factory-built one dispatches on its guards', () => {
  const m = pack('haystack');
  assertGolden('haystack', ruleView(m));
  const order = edgesFrom(m, 'pipe.build:index').filter(e => e.rule === 'haystack.pipeline').map(e => [e.to.split(/[:.]/).slice(-2).join('.'), e.order]);
  assert.deepEqual(order, [['Cleaner.run', 0], ['DocumentSplitter.run', 1], ['RemoteEmbedder.run', 2], ['LocalEmbedder.run', 2]]);
  const remote = m.edges.find(e => e.to === 'pipe.components:RemoteEmbedder.run');
  assert.deepEqual([remote.kind, remote.selectors], ['dispatch', ['settings.remote_embedder']]);
});

test('haystack fixture config: the default and an in-repo .env each decide the embedder', () => {
  const site = pack('haystack').config.sites.find(s => s.factory === 'pipe.factory:create_embedder');
  assert.equal(site.classification, 'config-narrowed');
  assert.deepEqual(site.decidedByProfile, { 'code defaults': 'pipe.components:LocalEmbedder', 'deploy/prod.env': 'pipe.components:RemoteEmbedder' });
});

test('click-typer: one entry per command, however many options decorate it', () => {
  const m = pack('click-typer');
  assertGolden('click-typer', ruleView(m));
  assert.deepEqual(m.entries.map(e => e.id), ['cli:greet', 'cli:serve']);
});

test('py-http-client: literal, f-string and local URLs match routes; scheme://host and {base} are dropped', () => {
  const m = pack('py-http-client');
  assertGolden('py-http-client', ruleView(m));
  const unlinked = m.rules.pyHttp.filter(h => !h.handler).map(h => `${h.method} ${h.url}`).sort();
  assert.deepEqual(unlinked, ['DELETE /v1/users/{}', 'GET /v1/nope']);
});

test('process-spawn: uvicorn, taskiq worker/scheduler and python -m start their entries; pipeline.run is not a spawn', () => {
  const m = pack('process-spawn');
  assertGolden('process-spawn', ruleView(m));
  assert.equal(edgesFrom(m, 'harness.start:not_a_spawn').filter(e => e.kind === 'spawn').length, 0);
});

test('pytest: golden fixture links', () => assertGolden('pytest', ruleView(pack('pytest'))));

test('process-spawn: `uvicorn server:app` and `python -m tool` resolve from the spawning file\'s directory first', () => {
  const m = pack('process-spawn-nested');
  const spawns = m.edges.filter(e => e.kind === 'spawn').map(e => `${e.from} -> ${e.to}`).sort();
  assert.deepEqual(spawns, [
    'evals.indexing.run:start_server -> evals.indexing.server:lifespan',
    'evals.indexing.run:start_tool -> evals.tool.__main__:<main>',
  ]);
});
