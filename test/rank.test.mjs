// Ranking is evidence (design §3.8): each group's top-level candidates in greedy marginal-coverage order with no cut
// line and no series, evidence columns on every row, the shared heavily-tested table, continuations, the merged order.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL, FIXTURES, proposeAndRank, scratch, cleanup, short } from './helpers.mjs';

const FIXTURE = join(FIXTURES, 'propose');
const r = proposeAndRank(FIXTURE);
const k = r.ranking;
const row = (grp, name) => k.ranked[grp].find(x => short(x.entry) === name);

test('rank succeeds and ranks every top-level candidate of each group', () => {
  assert.deepEqual(r.statuses, [0, 0, 0], r.stderr);
  assert.deepEqual(k.totals.topLevel, { prod: 4, eval: 1, dev: 1 });
  assert.deepEqual(k.ranked.prod.map(x => short(x.entry)), ['place_order', 'refund_order', 'cancel_order', 'health']);
});

test('no cut line and no series: nothing in the ranking picks rows', () => {
  for (const key of ['series', 'threshold', 'cut', 'selected']) assert.ok(!(key in k), key);
  for (const x of Object.values(k.ranked).flat()) for (const key of ['series', 'variant', 'selected']) assert.ok(!(key in x), key);
});

test('greedy order: gain is the new own code, cumulative coverage climbs to the whole universe', () => {
  const p = k.ranked.prod;
  assert.deepEqual(p.map(x => x.gain), [9, 4, 3, 1]);
  assert.deepEqual(p.map(x => x.cumulative), [9, 13, 16, 17]);
  assert.equal(p.at(-1).coverage, 1);
  assert.equal(k.totals.universe.prod, 17);
});

test('a continuation is not ranked on its own but listed with its parent', () => {
  assert.ok(!k.ranked.prod.some(x => short(x.entry) === 'ship_order'));
  assert.deepEqual(k.continuations.map(x => [short(x.entry), x.parents.map(short)]), [['ship_order', ['place_order']]]);
});

test('each row names its nearest higher-ranked row and their overlap', () => {
  assert.deepEqual([row('prod', 'place_order').nearest, row('prod', 'place_order').jaccard], [null, null]);
  const cancel = row('prod', 'cancel_order');
  assert.equal(short(cancel.nearest), 'refund_order');
  assert.equal(cancel.jaccard, 0.14, 'with_retry is shared: 1 of 7 symbols');
});

test('evidence columns: tests pinning own code, config-dependent dispatch, evals exercising the row', () => {
  const p = row('prod', 'place_order');
  assert.deepEqual([p.pinned, p.tests, p.testsNew], [3, 8, 8]);
  assert.equal(p.cfg, 1, 'the notifier factory');
  assert.deepEqual(p.evals, ['evals.run_eval:<main>']);
  assert.deepEqual(row('prod', 'health').evals, []);
});

test('an eval row lists what it exercises in production, with the production row that owns it', () => {
  const e = k.ranked.eval[0];
  assert.deepEqual(e.exercises, [{ to: 'shop.api:place_order', kind: 'http', flowRank: 1 }]);
  assert.deepEqual(e.usesProd.map(u => [short(u.id), u.flowRank]).sort(), [['fmt_money', 1], ['place_order', 1]]);
});

test('the shared table lists production code many rows share and many tests pin', () => {
  assert.deepEqual(k.shared, [{ module: 'shop/util.py', candidates: 3, firstOwner: 1, firstOwnerEntry: 'shop.api:place_order', functions: 2, directTests: 6 }]);
});

test('the merged prod + eval order is evidence only', () => {
  assert.deepEqual(k.merged.map(x => `${x.rank} ${short(x.entry)} ${x.group}`), ['1 place_order prod', '2 refund_order prod', '3 <main> eval', '4 cancel_order prod', '5 health prod']);
});

test('ranking.md prints every row of every group, the shared table and the continuations', () => {
  const mdName = id => id.endsWith(':<main>') ? `${id.split(':')[0].split('.').pop()}:<main>` : short(id);   // a main block is named by its module
  for (const x of Object.values(k.ranked).flat()) assert.ok(r.md.includes(`\`${mdName(x.entry)}\``), x.entry);
  assert.match(r.md, /There is no cut line and no series/);
  assert.match(r.md, /## dev: 1 rows \(filtered by default\)/);
  assert.match(r.md, /\| `shop\/util\.py` \| 3 \| #1 `place_order` \| 2 \| 6 \|/);
  assert.match(r.md, /\| `ship_order` \| prod \| orders\.ship \| 1 \| #1 `place_order` \|/);
  assert.match(r.md, /### prod #1 `place_order`[^]*Dispatch points:[^]*make_notifier[^]*`SmsNotifier` when kind == "sms"/);
});

test('ranking.md never prints a missing field as undefined, and lists exactly the cfg points of each explained row', () => {
  assert.doesNotMatch(r.md, /undefined/);
  assert.match(r.md, /### eval #1 `run_eval:<main>`\n\nevals\/run_eval\.py · /, 'a main block has no line');
  for (const x of k.ranked.prod.slice(0, k.params.explainTop)) {
    const section = r.md.split(`### prod #${x.rank} `)[1].split('\n### ')[0];
    const points = section.includes('Dispatch points:') ? section.split('Dispatch points:')[1].split('\n\n')[1].trim().split('\n').length - 2 : 0;
    assert.equal(points, x.cfg, short(x.entry));
  }
});

test('--explain-top limits the explained rows', () => {
  const one = proposeAndRank(FIXTURE, { rankFlags: ['--explain-top', '1', '--explain-top-eval', '0'] });
  assert.equal((one.md.match(/^### (prod|eval) #/gm) || []).length, 1);
});

/* ---------------- the tool's contract ---------------- */
const RANK = join(SKILL, 'tools', 'rank.mjs');
const TMP = scratch();
after(() => cleanup(TMP));
const run = (...args) => spawnSync(process.execPath, [RANK, ...args], { encoding: 'utf8' });
const candidatesFile = (name, mutate = x => x) => { const dir = join(TMP, name); mkdirSync(dir, { recursive: true });
  const f = join(dir, 'candidates.json'); writeFileSync(f, JSON.stringify(mutate(structuredClone(r.candidates)))); return f; };

test('exit 1: no --candidates, the removed series flags, an unreadable or foreign file', () => {
  assert.equal(run().status, 1);
  for (const flag of ['--min-new', '--min-share', '--series']) assert.equal(run('--candidates', candidatesFile('a'), flag, '3').status, 1, flag);
  assert.equal(run('--candidates', candidatesFile('a'), '--out', TMP).status, 1, 'output always goes beside candidates.json');
  assert.equal(run('--candidates', join(TMP, 'missing.json')).status, 1);
  assert.match(run('--candidates', candidatesFile('b', x => ({ ...x, schema: 2 }))).stderr, /not a propose\.mjs candidates file/);
});

test('exit 1: refuses to write inside the mined repo', () => {
  const r1 = run('--candidates', candidatesFile('c', x => ({ ...x, root: join(TMP, 'c') })));   // candidates placed inside the repo they came from
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /refusing to write inside the repo/);
  assert.equal(existsSync(join(TMP, 'c', 'ranking.json')), false);
  assert.equal(existsSync(join(TMP, 'c', 'ranking.md')), false);
});

test('two runs produce byte-identical rankings', () => {
  assert.equal(proposeAndRank(FIXTURE).raw.ranking, r.raw.ranking);
});
