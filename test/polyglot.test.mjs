// The polyglot fixture end to end (design §5.1): a Python backend with its tests and a tiny eval harness, and a
// TypeScript frontend. Mined, proposed and ranked as one repo: the frontend's calls link to the backend routes they
// hit (the §3.9 / Appendix B.4 demo cases, the B15 base-URL one included), its UI routes are entries, and its
// jest / vitest tests are evidence on the frontend code they pin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { FIXTURES, proposeAndRank, mineInto, tool, scratch, cleanup } from './helpers.mjs';

const r = proposeAndRank(join(FIXTURES, 'polyglot'));
const m = r.codemap, c = r.candidates, k = r.ranking;
const short = id => id.split(':').pop();

test('polyglot: mine, propose and rank all exit 0, with both self-checks clean', () => {
  assert.deepEqual(r.statuses, [0, 0, 0], r.stderr);
  assert.equal(m.selfCheck.ok, true);
  assert.equal(m.selfCheck.typescript.defsExtracted, m.selfCheck.typescript.defNodes);
  assert.deepEqual(m.unsupported.byExt, { '.go': 2 });
});

test('polyglot: every frontend call in the B.4 demo links to the FastAPI route it hits, the ${BASE} one by const folding', () => {
  const links = m.edges.filter(e => e.rule === 'js.http-client').map(e => `${short(e.from)} -> ${short(e.to)}`).sort();
  assert.deepEqual(links, ['importBooks -> import_shelf_books', 'jobStatus -> get_import_job', 'searchBooks -> search_books', 'searchReviews -> search_reviews']);
  const reviews = m.rules.jsHttp.find(h => short(h.from) === 'searchReviews');
  assert.deepEqual([reviews.client, reviews.method, reviews.url, reviews.folded], ['fetch', 'POST', '/api/v1/catalog/shelves/{}/reviews/search', ['BASE']]);
  assert.ok(m.edges.filter(e => e.rule === 'js.http-client').every(e => !e.groups), 'frontend and backend are both production: same group');
});

test('polyglot: the React Router routes are entries, both styles', () => {
  assert.deepEqual(m.entries.filter(e => e.kind === 'ui-route').map(e => `${e.path} ${short(e.id)} ${e.rule}`).sort(),
    ['/jobs/:id JobPage react-router.jsx', '/search SearchPage react-router.object', '/shelves/:shelf/import ImportPage react-router.object']);
});

test('polyglot: a UI route is a candidate that crosses into the backend; the routes it hits are its continuations', () => {
  const imp = c.candidates['frontend/src/pages/ImportPage.tsx:ImportPage'];
  assert.deepEqual(imp.crossings.map(x => `${short(x.from)} -${x.kind}-> ${short(x.to)}`), ['importBooks -http-> import_shelf_books']);
  assert.deepEqual(imp.segments.map(s => short(s.root)), ['ImportPage', 'import_shelf_books']);
  assert.ok(imp.ownIds.includes('backend.imports:queue_import'), 'the walk continues into the Python handler and below');
  assert.deepEqual(c.candidates['backend.app:import_shelf_books'].continues, ['frontend/src/pages/ImportPage.tsx:ImportPage']);
  const prod = k.ranked.prod.map(x => short(x.entry));
  assert.deepEqual(prod, ['SearchPage', 'ImportPage', 'JobPage'], 'every backend route is reached from a page, so the pages are the top-level rows');
  assert.doesNotMatch(r.md, /undefined/);
});

test('polyglot: the eval harness exercises the production route it calls, not as a continuation', () => {
  const ev = c.candidates['backend.evals.run_eval:<main>'];
  assert.deepEqual(ev.exercises.map(x => `${x.kind} ${short(x.to)}`), ['http search_books']);
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

test('polyglot: a series with a UI-route flow that crosses into Python validates, is approved and plans; its panels and diagrams name both sides', () => {
  const out = join(scratch(), 'out'), flows = join(out, 'flows.json');
  const candidates = mineInto(join(FIXTURES, 'polyglot'), out);
  writeFileSync(flows, readFileSync(join(FIXTURES, 'flows', 'polyglot-flows.json'), 'utf8'));
  const apply = tool('apply-flows.mjs', '--candidates', candidates, '--flows', flows);
  assert.equal(apply.status, 0, apply.stdout + apply.stderr);
  assert.match(apply.stdout, /15 hops · 4 crossings · 4 cited tests/);
  assert.equal(tool('approve-flows.mjs', '--flows', join(out, 'flows.validated.json'), '--by', 'user', '--note', 'approved as proposed').status, 0);
  const plan = tool('flow-plan.mjs', '--flows', join(out, 'flows.validated.json'));
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /15 hops · 15 assigned to exactly one video · \*\*0 orphaned\*\*/);
  const panel = JSON.parse(tool('excerpt.mjs', '--codemap', join(out, 'codemap.json'), '--symbol', 'frontend/src/api/catalog.ts:searchReviews').stdout);
  assert.deepEqual([panel.lang, panel.numbers], ['typescript', [9, 10, 11]]);
  const seq = JSON.parse(tool('flow-diagram.mjs', '--flows', join(out, 'flows.validated.json'), '--flow', 'import', '--as', 'sequence').stdout);
  assert.deepEqual(seq.params.participants.map(p => p.label), ['/shelves/:shelf/import', 'pages/ImportPage.tsx', 'api/catalog.ts', 'backend.app', 'backend.imports']);
  cleanup(dirname(out));
});
