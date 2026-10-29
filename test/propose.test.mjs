// Candidate proposal: one walk per prod, eval and dev entry, with the group rules of design §3.7 and §3.15.
// The negative fixtures: a test double that production CHA can reach is never walked, and a production function
// with many test callers is never folded as a helper. Plus continuations, exercises links, callbacks, test reach.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL, FIXTURES, proposeAndRank, scratch, cleanup, short } from './helpers.mjs';

const FIXTURE = join(FIXTURES, 'propose');
const r = proposeAndRank(FIXTURE);
const m = r.codemap, c = r.candidates;
const cand = name => Object.entries(c.candidates).find(([id]) => short(id) === name)[1];
const own = name => cand(name).ownIds.map(short).sort();
const foldedAs = (name, how) => cand(name).nodes.filter(n => n.folded === how).map(n => short(n.id)).sort();
const groupOf = id => m.symbols.find(s => s.id === id)?.group;

test('mine, propose and rank all succeed on the fixture', () => assert.deepEqual(r.statuses, [0, 0, 0], r.stderr));

test('one candidate per prod, eval and dev entry; tests are not entries', () => {
  assert.deepEqual(c.totals.byGroup, { prod: 5, eval: 1, dev: 1, test: 0 });
  assert.deepEqual(c.totals.candidates, { prod: 5, eval: 1, dev: 1 });
  assert.ok(Object.values(c.candidates).every(x => x.group !== 'test'));
});

test('negative fixture: a test double production CHA reaches is refused, never walked', () => {
  // precondition: the code map does hold a production -> test override edge, so the walk had the chance to take it
  assert.ok(m.edges.some(e => e.kind === 'virtual' && groupOf(e.from) === 'prod' && e.to === 'tests.test_processors:FakeProcessor._run'));
  assert.deepEqual(cand('place_order').testDoubles, ['tests.test_processors:FakeProcessor._run']);
  for (const [id, x] of Object.entries(c.candidates))
    for (const n of x.nodes) assert.notEqual(groupOf(n.id), 'test', `${short(id)} walked into test code: ${n.id}`);
  assert.equal(c.totals.testDoublesRefused, 1);
});

test('negative fixture: test callers never fold a production helper', () => {
  // fmt_money has one production caller and six test callers: counted together that is over the fan-in of 6
  const callers = new Set(m.edges.filter(e => e.to === 'shop.util:fmt_money').map(e => e.from));
  assert.ok(callers.size >= 6 && [...callers].filter(f => groupOf(f) === 'prod').length === 1);
  assert.ok(own('place_order').includes('fmt_money'), 'fmt_money stays expanded in the flow that calls it');
  for (const x of Object.values(c.candidates)) assert.ok(!x.nodes.some(n => short(n.id) === 'fmt_money' && n.folded === 'helper'));
  // the positive control: eight production callers and no callees fold log_event
  assert.deepEqual(foldedAs('place_order', 'helper'), ['log_event']);
  assert.equal(c.totals.helpers, 1);
});

test('--fanin moves the helper threshold', () => {
  const high = proposeAndRank(FIXTURE, { proposeFlags: ['--fanin', '9'] });
  assert.deepEqual(high.candidates.params, { fanin: 9, leafy: 5, ifaceFold: true });
  assert.equal(high.candidates.totals.helpers, 0);
  assert.ok(Object.entries(high.candidates.candidates).find(([id]) => short(id) === 'place_order')[1].ownIds.includes('shop.util:log_event'));
});

test('self-calls resolve under the receiver; a production walk follows the queue into its consumer', () => {
  assert.deepEqual(own('place_order'), ['BaseProcessor._run', 'BaseProcessor.process', 'OrderProcessor._run', 'OrderService.place', 'fmt_money',
    'make_notifier', 'place_order', 'run_processor', 'ship_order']);
  const x = cand('place_order');
  assert.deepEqual(x.crossings.map(k => `${k.kind} ${short(k.to)}`), ['queue ship_order']);
  assert.deepEqual(x.segments.map(s => [short(s.root), s.from && short(s.from), s.kind]), [['place_order', null, undefined], ['ship_order', 'OrderService.place', 'queue']]);
});

test('an entry reached through a same-group crossing is a continuation of its parent', () => {
  assert.deepEqual(cand('ship_order').continues, ['shop.api:place_order']);
  assert.equal(c.totals.continuations, 1);
  assert.deepEqual(c.totals.topLevel, { prod: 4, eval: 1, dev: 1 });
});

test('a callable handed to a callee is followed only from the caller that handed it over', () => {
  assert.deepEqual(own('refund_order'), ['refund', 'refund.<locals>._do', 'refund_order', 'with_retry']);
  assert.deepEqual(own('cancel_order'), ['cancel', 'cancel.<locals>._undo', 'cancel_order', 'with_retry']);
  assert.equal(cand('refund_order').nodes.find(n => short(n.id) === 'refund.<locals>._do').parent, 'shop.retry:with_retry');
});

test('an eval walk folds production code into uses-prod leaves and records its HTTP call as an exercises link', () => {
  const x = c.candidates['evals.run_eval:<main>'];
  assert.deepEqual(x.ownIds.map(short).sort(), ['<main>', 'check_orders', 'score']);
  assert.deepEqual(x.usesProd.sort(), ['shop.api:place_order', 'shop.util:fmt_money']);
  assert.deepEqual(x.exercises.map(e => `${e.kind} ${e.to}`), ['http shop.api:place_order']);
  assert.deepEqual(x.segments.map(s => short(s.root)), ['<main>'], 'a crossing into production is not a segment');
  assert.equal(cand('place_order').continues, null, 'nor does it make the route a continuation');
});

test('a dev walk folds the production code it calls', () => {
  const x = c.candidates['scripts.seed:<main>'];
  assert.deepEqual(x.ownIds.map(short).sort(), ['<main>', 'seed']);
  assert.deepEqual(x.usesProd, ['shop.service:OrderService.place']);
});

test('test reach starts at the direct links, stops at what the test mocks, and never enters test code', () => {
  const link = name => c.testLinks.find(t => short(t.test) === name);
  const mocked = link('test_order_processor_runs');
  assert.deepEqual(mocked.direct.map(d => short(d.to)), ['OrderProcessor._run']);
  assert.ok(!mocked.exercisedIds.includes('shop.util:log_event'), 'log_event is patched in this test');
  assert.ok(link('test_run_processor_uses_the_hook').exercisedIds.includes('shop.processors:BaseProcessor.process'));
  for (const t of c.testLinks) for (const id of t.exercisedIds) assert.notEqual(groupOf(id), 'test', `${short(t.test)} reaches test code ${id}`);
  assert.deepEqual(c.bySymbol['shop.util:fmt_money'].direct.length, 6);
  assert.deepEqual([c.totals.prodFunctionsDirect, c.totals.prodFunctions], [m.testSummary.prodFunctionsWithDirectLink, m.testSummary.prodFunctions]);
});

test('two concrete classes behind a factory are named alternatives, with the config site that selects them', () => {
  assert.deepEqual(foldedAs('place_order', 'alternative'), ['EmailNotifier.send', 'SmsNotifier.send']);
  const d = cand('place_order').dispatch.find(x => x.attr === 'send');
  assert.deepEqual([d.how, d.narrowedBy, d.config.classification], ['factory', 'shop.notify:make_notifier', 'config-dependent (runtime input)']);
  assert.deepEqual(d.config.alternatives.map(a => [short(a.cls), a.guards]), [['SmsNotifier', ['kind == "sms"']], ['EmailNotifier', ['not kind == "sms"']]]);
});

test('--no-iface-fold expands what interface and alternative folding would leave as leaves', () => {
  const off = proposeAndRank(FIXTURE, { proposeFlags: ['--no-iface-fold'] });
  assert.equal(off.statuses[1], 0, off.stderr);
  assert.equal(off.candidates.params.ifaceFold, false);
  const x = Object.entries(off.candidates.candidates).find(([id]) => short(id) === 'place_order')[1];
  assert.ok(['shop.notify:EmailNotifier.send', 'shop.notify:SmsNotifier.send'].every(id => x.ownIds.includes(id)));
  assert.ok(Object.values(off.candidates.candidates).every(y => y.nodes.every(n => n.folded !== 'interface' && n.folded !== 'alternative')));
});

/* ---------------- the tool's contract ---------------- */
const PROPOSE = join(SKILL, 'tools', 'propose.mjs');
const TMP = scratch();
after(() => cleanup(TMP));
const run = (...args) => spawnSync(process.execPath, [PROPOSE, ...args], { encoding: 'utf8' });
const codemapFile = (name, mutate = x => x) => { const dir = join(TMP, name); mkdirSync(dir, { recursive: true });
  const f = join(dir, 'codemap.json'); writeFileSync(f, JSON.stringify(mutate(structuredClone(m)))); return f; };

test('exit 1: no --codemap, an unknown flag, a bad number, an unreadable or foreign code map', () => {
  assert.equal(run().status, 1);
  assert.equal(run('--codemap', codemapFile('a'), '--series', '3').status, 1, 'there is no series flag');
  assert.equal(run('--codemap', codemapFile('b'), '--fanin', 'many').status, 1);
  assert.equal(run('--codemap', join(TMP, 'missing.json')).status, 1);
  assert.match(run('--codemap', codemapFile('c', x => ({ ...x, schema: 9 }))).stderr, /not a mine\.mjs code map/);
});

test('exit 1: refuses to write inside the mined repo', () => {
  const r1 = run('--codemap', codemapFile('d'), '--out', join(FIXTURE, 'out'));
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /refusing to write inside the repo/);
  assert.equal(existsSync(join(FIXTURE, 'out')), false);
});

test('exit 2: an entry whose symbol is not in the code map is reported, the rest still written', () => {
  const f = codemapFile('e', x => ({ ...x, entries: [...x.entries, { id: 'shop.api:gone', group: 'prod', kind: 'http', file: 'shop/api.py', line: 1 }] }));
  const r2 = run('--codemap', f);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /could not be walked.*shop\.api:gone/);
  const written = JSON.parse(readFileSync(join(TMP, 'e', 'candidates.json'), 'utf8'));
  assert.deepEqual(written.unwalked.map(e => e.id), ['shop.api:gone']);
  assert.equal(Object.keys(written.candidates).length, 7);
});

test('two runs produce byte-identical candidates', () => {
  assert.equal(proposeAndRank(FIXTURE).raw.candidates, r.raw.candidates);
});
