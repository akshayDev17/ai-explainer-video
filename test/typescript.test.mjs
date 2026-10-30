// The TypeScript / JavaScript adapter: module and name resolution (ESM, CommonJS, tsconfig paths through extends,
// barrels, workspace packages), classes and receivers, and each TS/JS rule pack against its golden links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FIXTURES, mine, ruleView, assertGolden, edgesFrom } from './helpers.mjs';

const pack = name => { const r = mine(join(FIXTURES, 'rules', name)); assert.equal(r.status, 0, r.stderr); return r.codemap; };
const has = (m, from, to, kind, pred = () => true) => m.edges.some(e => e.from === from && e.to === to && (!kind || e.kind === kind) && pred(e));

const resolver = mine(join(FIXTURES, 'ts-resolver'));
const R = resolver.codemap;

test('ts-resolver: mines with the self-check clean and every definition extracted', () => {
  assert.equal(resolver.status, 0, resolver.stderr);
  const sc = R.selfCheck.typescript;
  assert.equal(sc.defsExtracted, sc.defNodes);
  assert.deepEqual(sc.unresolvedImports, []);
  assert.equal(sc.unresolvedByOrigin.inRepo, 0);
  assert.deepEqual(R.languages.typescript, { files: 8, parseErrors: 0 });
  assert.deepEqual(R.languages.javascript, { files: 3, parseErrors: 0 });
});

test('ts-resolver: a tsconfig path alias reached through extends, a barrel with export * and renamed re-exports, .js naming a .ts file, a workspace package', () => {
  assert.ok(has(R, 'src/app.ts:boot', 'src/core/factory.ts:makeStore', 'static'), 'export { default as makeStore } from ./factory via @core/index');
  assert.ok(has(R, 'src/app.ts:boot', 'src/core/store.ts:MemoryStore', 'ctor'), 'export * from ./store');
  assert.ok(has(R, 'src/app.ts:App.constructor', 'src/core/log.ts:Logger', 'ctor'), 'export { Logger as Log }: the parameter default new Log()');
  assert.ok(has(R, 'src/app.ts:App.run', 'src/util.ts:format', 'static'), "import * as util from './util.js' names util.ts");
  assert.ok(has(R, 'src/app.ts:boot', 'packages/shared/src/index.ts:shared', 'static'), '@acme/shared is a workspace package');
});

test('ts-resolver: CommonJS require, destructured require, module.exports = fn and exports.x', () => {
  assert.ok(has(R, 'src/legacy/use.js:go', 'src/legacy/index.js:legacy', 'static'), 'module.exports = function legacy');
  assert.ok(has(R, 'src/legacy/use.js:go', 'src/legacy/lib.js:helper', 'static'), 'exports.helper on a required module');
  assert.ok(has(R, 'src/legacy/index.js:legacy', 'src/util.ts:format', 'static'), "const { format } = require('../util')");
  assert.deepEqual(R.entries.map(e => [e.kind, e.id]), [['main', 'src/legacy/use.js:<main>']], 'if (require.main === module)');
});

test('ts-resolver: this.m() through the class chain plus a virtual edge per override; super.m(); an abstract method is an interface', () => {
  assert.ok(has(R, 'src/core/store.ts:Store.save', 'src/core/store.ts:Store.write', 'static', e => e.self === 'write'));
  assert.ok(has(R, 'src/core/store.ts:Store.save', 'src/core/store.ts:MemoryStore.write', 'virtual'));
  assert.ok(has(R, 'src/core/store.ts:MemoryStore.write', 'src/core/store.ts:Store.write', 'static', e => e.super));
  assert.deepEqual(R.symbols.find(s => s.id === 'src/core/store.ts:Store.load').decos, ['abstract']);
});

test('ts-resolver: receivers typed by a constructor parameter property, new K(), a module singleton and a factory\'s guarded returns', () => {
  // this.store: Store (annotated property): CHA over the subclasses
  assert.ok(has(R, 'src/app.ts:App.run', 'src/core/store.ts:Store.save', 'static'));
  assert.deepEqual(edgesFrom(R, 'src/app.ts:App.run').filter(e => e.kind === 'virtual').map(e => e.to).sort(), ['src/core/store.ts:MemoryStore.load', 'src/core/store.ts:RedisStore.load']);
  assert.ok(has(R, 'src/app.ts:boot', 'src/app.ts:App.run', 'static', e => e.recvClass === 'src/app.ts:App'), 'const app = new App(...)');
  assert.ok(has(R, 'src/app.ts:App.run', 'src/core/log.ts:Logger.info', 'static', e => e.recvClass === 'src/core/log.ts:Logger'), 'export const logger = new Logger()');
  const narrowed = edgesFrom(R, 'src/app.ts:boot').filter(e => e.kind === 'dispatch').map(e => [e.to, e.narrowedBy]);
  assert.deepEqual(narrowed.sort(), [['src/core/store.ts:MemoryStore.load', 'src/core/factory.ts:makeStore'], ['src/core/store.ts:RedisStore.load', 'src/core/factory.ts:makeStore']]);
  const guards = edgesFrom(R, 'src/core/factory.ts:makeStore').map(e => [e.to.split(':').pop(), e.cfg]);
  assert.deepEqual(guards, [['RedisStore', ["process.env.STORE === 'redis'"]], ['MemoryStore', ["not process.env.STORE === 'redis'"]]]);
});

test('ts-resolver: object members, a callback handed over, a call in catch, a rendered class component', () => {
  assert.ok(has(R, 'src/app.ts:callApi', 'src/app.ts:api.ping', 'static'));
  assert.ok(has(R, 'src/app.ts:scheduled', 'src/app.ts:boot', 'static', e => e.rule === 'js.callback'), 'util.retry(boot) runs boot');
  assert.ok(has(R, 'src/app.ts:boot', 'src/app.ts:report', 'static', e => e.onFailure === 'catch (e)'));
  assert.ok(has(R, 'src/widget.tsx:Page', 'src/widget.tsx:Widget', 'ctor', e => e.jsx));
  assert.ok(has(R, 'src/widget.tsx:Page', 'src/widget.tsx:Widget.render', 'static', e => e.jsx));
});

test('express: routes, mounted routers (CommonJS and ESM), .route() chains and middleware; a .get on anything else is no route', () => {
  const m = pack('express');
  assertGolden('express', ruleView(m));
  assert.deepEqual(m.entries.filter(e => e.kind === 'http').map(e => `${e.method} ${e.path}`).sort(),
    ['GET /api/users', 'GET /api/users/{id}', 'GET /health', 'GET /v2/orders/{orderId}', 'POST /api/login', 'POST /api/users']);
  assert.ok(has(m, 'server/app.js:login', 'server/middleware.js:requireAuth', 'framework', e => e.rule === 'express.middleware'));
  assert.equal(m.edges.some(e => e.from === 'server/routes/users.js:<module>'), false, 'registering a handler is not calling it');
  assert.ok(has(m, 'api/src/server.ts:<module>', 'api/src/server.ts:GET /decoy', 'static', e => e.rule === 'js.callback'), 'a non-Express .get keeps its callback as a call');
  assert.equal(m.selfCheck.typescript.unresolvedByOrigin.inRepo, 0, 'calls on the Express app count as external');
});

test('nextjs: App Router pages and route handlers, Pages Router pages and API routes; groups and private folders add nothing', () => {
  const m = pack('nextjs');
  assertGolden('nextjs', ruleView(m));
  assert.deepEqual(m.rules.nextRoots, ['']);
  assert.ok(!m.entries.some(e => /_components|_app/.test(e.file)), 'a _folder is private and _app is no page');
  assert.ok(has(m, 'lib/client.ts:loadProduct', 'app/api/products/[id]/route.ts:GET', 'http'));
  assert.ok(has(m, 'lib/client.ts:legacyLookup', 'pages/api/legacy/[slug].ts:handler', 'http'), 'a Pages Router API route takes any method');
});

test('react-router: route objects with nested children, index, Component and lazy; <Route> elements nested under a parent', () => {
  const m = pack('react-router');
  assertGolden('react-router', ruleView(m));
  const byPath = Object.fromEntries(m.entries.map(e => [e.path, e.id.split(':').pop()]));
  assert.equal(byPath['/reports'], 'Reports', "lazy(() => import('./pages/Reports'))");
  assert.equal(byPath['/audit'], 'Audit', "lazy: () => import('./pages/Audit')");
  assert.equal(byPath['/settings/profile'], 'Profile');
  assert.deepEqual(m.entries.find(e => e.id === 'src/pages/Dashboard.tsx:Dashboard').alsoAt, ['/team/:teamId']);
  assert.ok(!m.entries.some(e => e.path === '/not-a-route'), 'a path table in a file that does not import react-router');
});

test('js-http-client: fetch, axios, ky and their instances; const folding through imports, objects and env defaults; tail matches', () => {
  const m = pack('js-http-client');
  assertGolden('js-http-client', ruleView(m));
  const by = Object.fromEntries(m.rules.jsHttp.map(h => [h.from.split(':').pop(), h]));
  assert.equal(by.listItems.handler, 'api.main:list_items', 'axios.create({ baseURL: API_BASE }), API_BASE = env ?? "/api/v1"');
  assert.deepEqual(by.listItems.folded, ['API_BASE']);
  assert.equal(by.removeItem.handler, 'api.main:delete_item', 'ky.create({ prefixUrl }) + a relative path');
  assert.equal(by.searchItems.handler, 'api.main:search_items', 'a literal segment beats a parameter: /items/search, not /items/{item_id}');
  assert.deepEqual(by.searchItems.folded, ['API_BASE', 'ROUTES.items']);
  assert.equal(by.putItem.handler, 'api.main:put_item', 'axios({ method, url })');
  assert.deepEqual([by.health.handler, by.health.env], ['api.main:health', ['SERVICE_URL']]);
  assert.deepEqual([by.countItems.handler, by.countItems.match], ['api.main:count_items', 'suffix'], 'an unknown base: the one route with that tail');
  assert.deepEqual([by.missing.handler, by.wrongMethod.handler], [null, null]);
});

test('jest-vitest: tests by describe path, hooks bound by scope, setup files, module mocks (whole and partial), spies that replace', () => {
  const m = pack('jest-vitest');
  assertGolden('jest-vitest', { ...ruleView(m), tests: m.tests.map(t => `${t.id} asserts ${t.assertLines.join(',')} | mocked ${t.mocked.join(',')} | direct ${t.direct.map(d => `${d.to}/${d.via}`).join(',')}`) });
  const t = Object.fromEntries(m.tests.map(x => [x.id.split(':').pop(), x]));
  assert.ok(t['Cart > adds an item at its price'].direct.some(d => d.to === 'src/cart.ts:Cart.add'), 'let cart; beforeEach(() => { cart = new Cart() }) types cart');
  assert.ok(t['Cart > totals every item'].direct.some(d => d.to === 'src/cart.ts:Cart.total'), 'a spy with no mock implementation calls through');
  assert.deepEqual(t['Cart > discounts > gives %i a discount of %i'].mocked, ['src/mailer.ts:sendReceipt', 'src/pricing.ts:price']);
  assert.deepEqual(t['checkout > charges the cart total'].mocked, ['src/mailer.ts:sendReceipt', 'src/pricing.ts:discount'], 'a factory that spreads the real module mocks only its keys');
  const session = m.mocks.filter(x => x.scope === 'session');
  assert.deepEqual(session.map(x => [x.target, x.covers]), [['src/mailer.ts:sendReceipt', 'src']]);
  assert.deepEqual(t['a single item costs ten'].mocked, [], 'a test outside src/ is not under src/setupTests.ts');
  assert.ok(t['a single item costs ten'].direct.some(d => d.via === 'fixture' && d.to === 'src/clock.ts:resetClock'), 'a setup file a vitest config lists covers the config dir');
  assert.equal(m.files.find(f => f.path === 'vitest.config.ts').group, 'dev');
  assert.equal(m.files.find(f => f.path === 'src/setupTests.ts').group, 'test');
});
