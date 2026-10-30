// The polyglot fixture end to end (design §5.1): a Python backend with its tests and a tiny eval harness, a
// TypeScript frontend, a Go inventory service and a C tool. Mined, proposed and ranked as one repo: the frontend's
// calls link to the routes they hit in Python and in Go (the §3.9 / Appendix B.4 demo cases, the B15 base-URL one
// included), its UI routes are entries, the C tool's command table makes one entry per command, and each language's
// tests (pytest, jest / vitest, go test, C test functions) are evidence on the code they pin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { FIXTURES, proposeAndRank, mineInto, tool, scratch, cleanup } from './helpers.mjs';

const r = proposeAndRank(join(FIXTURES, 'polyglot'));
const m = r.codemap, c = r.candidates, k = r.ranking;
const short = id => id.split(':').pop();

test('polyglot: mine, propose and rank all exit 0, with every language\'s self-check clean', () => {
  assert.deepEqual(r.statuses, [0, 0, 0], r.stderr);
  assert.equal(m.selfCheck.ok, true);
  for (const l of ['typescript', 'go', 'c']) assert.equal(m.selfCheck[l].defsExtracted, m.selfCheck[l].defNodes, l);
  assert.deepEqual(m.unsupported.byExt, {});
  assert.deepEqual(m.selfCheck.go.modules, [{ dir: 'services/inventory', module: 'example.com/inventory' }]);
  assert.deepEqual([...new Set(m.symbols.map(s => s.lang).filter(Boolean))].sort(), ['c', 'go', 'tsx', 'typescript'], 'the canonical lang names, as excerpt panels read them');
});

test('polyglot: every frontend call in the B.4 demo links to the FastAPI route it hits, the ${BASE} one by const folding', () => {
  const links = m.edges.filter(e => e.rule === 'js.http-client').map(e => `${short(e.from)} -> ${short(e.to)}`).sort();
  assert.deepEqual(links, ['importBooks -> import_shelf_books', 'jobStatus -> get_import_job', 'reserveCopy -> Server.reserve', 'searchBooks -> search_books', 'searchReviews -> search_reviews',
    'stockLevel -> Server.getStock']);
  const reviews = m.rules.jsHttp.find(h => short(h.from) === 'searchReviews');
  assert.deepEqual([reviews.client, reviews.method, reviews.url, reviews.folded], ['fetch', 'POST', '/api/v1/catalog/shelves/{}/reviews/search', ['BASE']]);
  assert.ok(m.edges.filter(e => e.rule === 'js.http-client').every(e => !e.groups), 'frontend and backend are both production: same group');
});

test('polyglot: the React Router routes are entries, both styles', () => {
  assert.deepEqual(m.entries.filter(e => e.kind === 'ui-route').map(e => `${e.path} ${short(e.id)} ${e.rule}`).sort(),
    ['/jobs/:id JobPage react-router.jsx', '/search SearchPage react-router.object', '/shelves/:shelf/import ImportPage react-router.object', '/stock/:isbn StockPage react-router.object']);
});

test('polyglot: the Go service\'s routes are entries, reached from the frontend in TypeScript and the eval harness in Python', () => {
  assert.deepEqual(m.entries.filter(e => e.rule === 'go.net-http').map(e => `${e.method} ${e.path} ${short(e.id)}`).sort(),
    ['GET /api/v1/stock/{isbn} Server.getStock', 'POST /api/v1/stock/{isbn}/reserve Server.reserve']);
  const stock = c.candidates['frontend/src/pages/StockPage.tsx:StockPage'];
  assert.deepEqual(stock.segments.map(s => short(s.root)), ['StockPage', 'Server.getStock', 'Server.reserve']);
  // the handler reads the store through its interface: every implementation is an alternative, chosen by the env
  const level = stock.dispatch.find(d => d.attr === 'Level');
  assert.deepEqual(level.targets.map(short).sort(), ['MemStore.Level', 'WarehouseStore.Level']);
  assert.deepEqual(c.candidates['services/inventory/api/server.go:Server.getStock'].continues, ['frontend/src/pages/StockPage.tsx:StockPage']);
  const open = m.edges.find(e => e.to === 'services/inventory/stock/store.go:WarehouseStore' && e.kind === 'ctor');
  assert.deepEqual(open.cfg, ['os.Getenv("INVENTORY_BACKEND") == "warehouse"']);
  assert.ok(m.config.envReads.some(r => r.key === 'INVENTORY_BACKEND' && r.via === 'os.Getenv'));
});

test('polyglot: the C tool\'s command table makes a command entry per row; its main dispatches to them as alternatives', () => {
  assert.deepEqual(m.entries.filter(e => e.kind === 'command').map(e => `${e.key} ${short(e.id)} ${e.rule}`), ['check cmd_check c.handler-table', 'convert cmd_convert c.handler-table']);
  const main = c.candidates['native/isbn/src/cli.c:main'];
  assert.deepEqual(main.nodes.filter(n => n.folded === 'alternative').map(n => short(n.id)).sort(), ['cmd_check', 'cmd_convert']);
  assert.deepEqual(c.candidates['native/isbn/src/cli.c:cmd_check'].ownIds.map(short).sort(), ['cmd_check', 'digit', 'isbn10_valid', 'isbn13_valid']);
});

test('polyglot: go test and C test functions are evidence on the code they pin; a fake store stands in for the real ones', () => {
  const pinned = id => c.bySymbol[id]?.direct || [];
  assert.deepEqual(pinned('services/inventory/api/server.go:Server.getStock'), ['services/inventory/api/server_test.go:TestGetStock']);
  assert.deepEqual(pinned('services/inventory/api/server.go:Server.reserve'), ['services/inventory/api/server_test.go:TestReserve']);
  const reserve = m.tests.find(t => t.id === 'services/inventory/api/server_test.go:TestReserve');
  assert.deepEqual([reserve.table, reserve.subtests], [{ over: 'cases', line: 39, cases: 2 }, ['<tc.name>']]);
  assert.ok(reserve.mocked.includes('services/inventory/stock/store.go:MemStore.Reserve'), 'fakeStock stands in for every Store implementation');
  assert.deepEqual(pinned('services/inventory/stock/store.go:MemStore.Reserve'), ['services/inventory/stock/store_test.go:TestMemStoreReserve']);
  assert.deepEqual(pinned('native/isbn/src/isbn.c:isbn10_valid'), ['native/isbn/tests/test_isbn.c:test_isbn10_valid']);
  assert.deepEqual(m.tests.find(t => t.id === 'native/isbn/tests/test_isbn.c:test_isbn10_to13').assertLines, [12, 13, 14]);
  assert.equal(m.entries.some(e => e.id === 'native/isbn/tests/test_isbn.c:main'), false, 'a test binary\'s main is its runner, not an entry');
});

test('polyglot: a UI route is a candidate that crosses into the backend; the routes it hits are its continuations', () => {
  const imp = c.candidates['frontend/src/pages/ImportPage.tsx:ImportPage'];
  assert.deepEqual(imp.crossings.map(x => `${short(x.from)} -${x.kind}-> ${short(x.to)}`), ['importBooks -http-> import_shelf_books']);
  assert.deepEqual(imp.segments.map(s => short(s.root)), ['ImportPage', 'import_shelf_books']);
  assert.ok(imp.ownIds.includes('backend.imports:queue_import'), 'the walk continues into the Python handler and below');
  assert.deepEqual(c.candidates['backend.app:import_shelf_books'].continues, ['frontend/src/pages/ImportPage.tsx:ImportPage']);
  const prod = k.ranked.prod.map(x => short(x.entry));
  assert.deepEqual(prod, ['SearchPage', 'StockPage', 'ImportPage', 'JobPage', 'main', 'cmd_check', 'cmd_convert', 'main'],
    'every backend route is reached from a page, so the pages are the top-level rows; the Go and C programs follow');
  assert.doesNotMatch(r.md, /undefined/);
});

test('polyglot: the eval harness exercises the production route it calls, not as a continuation', () => {
  const ev = c.candidates['backend.evals.run_eval:<main>'];
  assert.deepEqual(ev.exercises.map(x => `${x.kind} ${short(x.to)}`), ['http search_books', 'http Server.getStock'], 'a Python HTTP client reaches the Go route too');
  assert.equal(c.candidates['backend.app:search_books'].continues.includes('backend.evals.run_eval:<main>'), false);
});

test('polyglot: jest and vitest tests are evidence on the frontend code they pin; a jest.mock hides what it replaces', () => {
  const pinned = id => c.bySymbol[id]?.direct || [];
  assert.deepEqual(pinned('frontend/src/api/catalog.ts:searchReviews'), ['frontend/src/api/catalog.test.ts:catalog api > posts a review search']);
  assert.deepEqual(pinned('frontend/src/api/catalog.ts:jobStatus'), ['frontend/src/api/catalog.test.ts:catalog api > reads a job status']);
  assert.deepEqual(pinned('frontend/src/pages/ImportPage.tsx:ImportPage'), ['frontend/src/pages/ImportPage.test.tsx:starts an import when the button is pressed']);
  assert.deepEqual(pinned('frontend/src/api/catalog.ts:importBooks'), [], "jest.mock('../api/catalog') replaces importBooks in the only test that reaches it");
  const t = m.tests.find(x => x.id === 'frontend/src/pages/ImportPage.test.tsx:starts an import when the button is pressed');
  assert.ok(t.mocked.includes('frontend/src/api/catalog.ts:importBooks'));
  assert.ok(m.tests.filter(x => x.file.startsWith('frontend/')).every(x => x.asserts > 0));
  const row = k.ranked.prod.find(x => short(x.entry) === 'SearchPage');
  assert.ok(row.pinned >= 1 && row.tests >= 1, 'the ranking shows the frontend tests on its rows');
  assert.deepEqual(pinned('backend.app:search_books'), ['backend.test_app:test_search_route_returns_hits'], 'the Python test client pins the route');
});

test('polyglot: a series with UI-route flows that cross into Python and Go, and a C command flow, validates, is approved and plans; its panels and diagrams name each side', () => {
  const out = join(scratch(), 'out'), flows = join(out, 'flows.json');
  const candidates = mineInto(join(FIXTURES, 'polyglot'), out);
  writeFileSync(flows, readFileSync(join(FIXTURES, 'flows', 'polyglot-flows.json'), 'utf8'));
  const apply = tool('apply-flows.mjs', '--candidates', candidates, '--flows', flows);
  assert.equal(apply.status, 0, apply.stdout + apply.stderr);
  assert.match(apply.stdout, /22 hops · 5 crossings · 6 cited tests/);
  assert.equal(tool('approve-flows.mjs', '--flows', join(out, 'flows.validated.json'), '--by', 'user', '--note', 'approved as proposed').status, 0);
  const plan = tool('flow-plan.mjs', '--flows', join(out, 'flows.validated.json'));
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /22 hops · 22 assigned to exactly one video · \*\*0 orphaned\*\*/);
  const panel = JSON.parse(tool('excerpt.mjs', '--codemap', join(out, 'codemap.json'), '--symbol', 'frontend/src/api/catalog.ts:searchReviews').stdout);
  assert.deepEqual([panel.lang, panel.numbers], ['typescript', [9, 10, 11]]);
  const goPanel = JSON.parse(tool('excerpt.mjs', '--codemap', join(out, 'codemap.json'), '--symbol', 'services/inventory/api/server.go:Server.getStock').stdout);
  assert.deepEqual([goPanel.lang, goPanel.numbers[0]], ['go', 23]);
  const cPanel = JSON.parse(tool('excerpt.mjs', '--codemap', join(out, 'codemap.json'), '--symbol', 'native/isbn/src/isbn.c:isbn10_valid').stdout);
  assert.deepEqual([cPanel.lang, cPanel.numbers[0]], ['c', 6]);
  const stock = JSON.parse(tool('flow-diagram.mjs', '--flows', join(out, 'flows.validated.json'), '--flow', 'stock', '--as', 'sequence').stdout);
  assert.deepEqual(stock.params.participants.map(p => p.label), ['/stock/:isbn', 'pages/StockPage.tsx', 'api/stock.ts', 'api/server.go']);
  const seq = JSON.parse(tool('flow-diagram.mjs', '--flows', join(out, 'flows.validated.json'), '--flow', 'import', '--as', 'sequence').stdout);
  assert.deepEqual(seq.params.participants.map(p => p.label), ['/shelves/:shelf/import', 'pages/ImportPage.tsx', 'api/catalog.ts', 'backend.app', 'backend.imports']);
  cleanup(dirname(out));
});
