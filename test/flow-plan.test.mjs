// The flow-list approval checkpoint and the plan (design §4.4b, §4.5): approve-flows binds the user's yes to the
// validated list's hash; flow-plan refuses (exit 5) without it or after any edit; the plan is coursework-shaped, so
// apply-enrichment, script-check and timing-report take it unchanged.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, FIXTURES, scratch, cleanup, mineInto, tool } from './helpers.mjs';

const GOOD = JSON.parse(readFileSync(join(FIXTURES, 'flows', 'flows.json'), 'utf8'));
const TMP = scratch();
after(() => cleanup(TMP));
const CANDIDATES = mineInto(join(FIXTURES, 'flows', 'repo'), join(TMP, 'out'));
const COURSEWORK = join(ROOT, 'skills', 'explainer-video-from-coursework', 'tools');

let n = 0;
// a validated copy of the good proposal (mutated) in its own dir
function validated(mutate = () => {}) {
  const dir = join(TMP, `case${n++}`); mkdirSync(dir);
  const flows = structuredClone(GOOD); mutate(flows);
  writeFileSync(join(dir, 'flows.json'), JSON.stringify(flows, null, 1));
  const r = tool('apply-flows.mjs', '--candidates', CANDIDATES, '--flows', join(dir, 'flows.json'));
  assert.equal(r.status, 0, r.stderr);
  return dir;
}
const V = dir => join(dir, 'flows.validated.json');
const approve = (dir, ...extra) => tool('approve-flows.mjs', '--flows', V(dir), '--by', 'user', '--note', 'yes, plan these four', ...extra);
const plan = (dir, ...flags) => tool('flow-plan.mjs', '--flows', V(dir), ...flags);
const json = f => JSON.parse(readFileSync(f, 'utf8'));

test('flow-plan exits 5 without an approval, and writes no plan', () => {
  const dir = validated();
  const r = plan(dir);
  assert.equal(r.status, 5);
  assert.match(r.stderr, /no flows\.approved\.json: the user has not approved this flow list/);
  assert.equal(existsSync(join(dir, 'plan.json')), false);
  assert.equal(existsSync(join(dir, 'plan.md')), false);
});

test('approve-flows records who, when, the note and the hash of the validated list', () => {
  const dir = validated();
  const r = approve(dir);
  assert.equal(r.status, 0, r.stderr);
  const a = json(join(dir, 'flows.approved.json'));
  assert.equal(a.approvedBy, 'user');
  assert.equal(a.note, 'yes, plan these four');
  assert.match(a.at, /^\d{4}-\d\d-\d\dT/);
  assert.match(a.flowsHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(a.series.map(s => s.id), ['lending', 'core:fees', 'search', 'eval-borrow']);
});

test('approve-flows refuses missing flags (1), and a missing, failing or stale list (2)', () => {
  const dir = validated();
  assert.equal(tool('approve-flows.mjs', '--flows', V(dir), '--by', 'user').status, 1, 'the user\'s words are required');
  assert.equal(tool('approve-flows.mjs', '--flows', V(dir), '--by', ' ', '--note', 'yes').status, 1);
  assert.equal(tool('approve-flows.mjs', '--flows', join(dir, 'nope.json'), '--by', 'user', '--note', 'yes').status, 2);
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...json(V(dir)), ok: false }));
  assert.equal(tool('approve-flows.mjs', '--flows', join(dir, 'bad.json'), '--by', 'user', '--note', 'yes').status, 2);
  writeFileSync(join(dir, 'flows.json'), readFileSync(join(dir, 'flows.json'), 'utf8') + '\n');
  const r = approve(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /flows\.json changed since apply-flows validated it/);
  assert.equal(existsSync(join(dir, 'flows.approved.json')), false);
});

test('flow-plan exits 5 after an edit to an approved list, revalidated or not', () => {
  const dir = validated();
  assert.equal(approve(dir).status, 0);
  assert.equal(plan(dir).status, 0);
  // the edit, not yet revalidated: flows.json no longer matches what was validated and approved
  const edited = structuredClone(GOOD); edited.series.reverse();
  writeFileSync(join(dir, 'flows.json'), JSON.stringify(edited, null, 1));
  const stale = plan(dir);
  assert.equal(stale.status, 5);
  assert.match(stale.stderr, /flows\.json changed since apply-flows validated it/);
  // revalidated: a new list, so the old approval no longer matches its hash
  assert.equal(tool('apply-flows.mjs', '--candidates', CANDIDATES, '--flows', join(dir, 'flows.json')).status, 0);
  const r = plan(dir);
  assert.equal(r.status, 5);
  assert.match(r.stderr, /approves a different flow list/);
  // and a hand edit of the validated file is an edit too
  assert.equal(approve(dir).status, 0);
  assert.equal(plan(dir).status, 0);
  writeFileSync(V(dir), readFileSync(V(dir), 'utf8').replace('"why": "eval #1', '"why": "eval no. 1'));
  assert.equal(plan(dir).status, 5);
});

test('--estimate prints the plan without an approval and writes nothing', () => {
  const dir = validated();
  const r = plan(dir, '--estimate');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /estimate only: no flows\.approved\.json/);
  assert.match(r.stdout, /\*\*Estimate only: this flow list is not approved\.\*\*/);
  assert.match(r.stdout, /## 6 videos, 17\.1 min/);
  assert.equal(existsSync(join(dir, 'plan.json')), false);
});

const dir = validated();
approve(dir);
const planned = plan(dir);
const p = json(join(dir, 'plan.json'));

test('the plan: an overview, then each series item in order, split at a break', () => {
  assert.equal(planned.status, 0, planned.stderr);
  assert.deepEqual(p.videos.map(v => [v.index, v.form, v.group]), [[1, 'overview', 'overview'], [2, 'flow', 'lending'], [3, 'flow', 'lending'], [4, 'core', 'core:fees'], [5, 'flow', 'search'], [6, 'flow', 'eval-borrow']]);
  assert.deepEqual(p.videos[2].sectionSpans.map(s => s.title), ['notify_member', 'format_notice'], 'the break starts the second lending video');
  assert.deepEqual(p.forms, ['overview', 'flow', 'core']);
  assert.equal(p.model.maxVideoMin, 25);
  assert.equal(p.model.calibrated, true);
  assert.deepEqual(p.model.uncalibrated, ['boundary'], 'the pilot crossed no boundary');
  assert.equal(p.model.basis.narratedLines, 96);
  assert.equal(p.approval.by, 'user');
  assert.equal(p.approval.flowsHash, json(join(dir, 'flows.approved.json')).flowsHash);
});

test('sections name each hop as "<file> :: <symbol> @L<start>", with its cited tests on the span', () => {
  assert.deepEqual(p.videos[4].sections, ['library/api.py :: search @L20', 'library/service.py :: search_books @L26', 'library/service.py :: rank_results @L31']);
  const span = p.videos[4].sectionSpans[2];
  assert.deepEqual(span.pinnedBy.map(t => [t.test, t.assertLines, t.strength]), [['tests.test_search:test_rank_results_puts_the_best_hit_first', [6], 'direct']]);
  assert.deepEqual(p.videos[4].artefacts, ['tests/test_search.py']);
  assert.deepEqual(p.videos[0].sections, ['lending :: Borrowing a book: from the request to the member\'s notice', 'core:fees :: The fee rule: free for two weeks, then a daily charge',
    'search :: Searching the catalogue and ranking the hits', 'eval-borrow :: How the harness grades borrowing']);
});

test('plan.md calls only a direct citation "pinned by"; a reachable-only one is reachable from a test', () => {
  const d = validated(f => { f.flows[0].hops[2].pinnedBy = [{ test: 'tests.test_service:test_borrow_records_the_fee', say: 'members are checked on every borrow', strength: 'reachable' }]; });
  assert.equal(approve(d).status, 0);
  assert.equal(plan(d).status, 0);
  const md = readFileSync(join(d, 'plan.md'), 'utf8').split('\n'), line = name => md.find(l => l.includes(`:: ${name} @L`));
  assert.match(line('check_member'), /— reachable from `test_borrow_records_the_fee` \(tests\/test_service\.py:[\d,]+\): members are checked on every borrow \(reachable only: never "pinned" or "tested"\)$/);
  assert.doesNotMatch(line('check_member'), /pinned by/);
  assert.match(line('LoanService.borrow'), /— pinned by `test_borrow_records_the_fee` \(tests\/test_service\.py:[\d,]+\): a borrow records the fee/);
});

test('coverage (C4): every kept hop is assigned to exactly one video', () => {
  const hops = [...json(V(dir)).flows, ...json(V(dir)).cores].reduce((a, x) => a + x.hops.length, 0);
  assert.equal(p.coverage.length, hops);
  assert.equal(new Set(p.coverage.map(c => `${c.item}#${c.hop}`)).size, hops);
  assert.deepEqual(p.orphans, []);
  assert.match(planned.stdout, /17 hops · 17 assigned to exactly one video · \*\*0 orphaned\*\*/);
});

test('the cost model: frame, hops by narrated lines, crossings, taught branches, cited tests', () => {
  // lending part 1: hops 1-7, two cited tests, the make_store branch; spans 2,10,2,2,4,5,2 lines → 1,5,1,1,2,3,1 narrated
  const v = p.videos[1];
  assert.equal(v.words, 150 + 7 * 5 + 6 * (1 + 5 + 1 + 1 + 2 + 3 + 1) + 70 + 2 * 45);
  assert.deepEqual([v.evidence.crossings, v.evidence.branches, v.evidence.citedTests], [0, 1, 2]);
  assert.equal(p.videos[2].evidence.crossings, 1, 'the queue hand-off');
  assert.equal(v.minutes, +(Math.round(v.words / 153 * 60 * 1.1) / 60).toFixed(1));
  assert.match(readFileSync(join(dir, 'plan.md'), 'utf8'), /^# repo — code-flow video plan\n\nApproved by \*\*user\*\* at .*: "yes, plan these four"/);
  assert.match(readFileSync(join(dir, 'plan.md'), 'utf8'), /> Calibrated on 1 narrated pilot video \(8 hops, 96 narrated lines, .*Still \*\*uncalibrated\*\*: crossing 60/);
});

test('splitting under the cap: at the latest crossing, else at the overflowing hop', () => {
  const d = validated(f => { delete f.flows[0].hops[7].break; });
  approve(d);
  const lending = cap => { const r = plan(d, '--max-min', cap, '--force'); return json(join(d, 'plan.json')).videos.filter(v => v.group === 'lending').map(v => v.sectionSpans.map(s => s.hop)); };
  assert.deepEqual(lending('4'), [[1, 2, 3, 4, 5, 6, 7, 8, 9]]);
  assert.deepEqual(lending('3.5'), [[1, 2, 3, 4, 5, 6, 7], [8, 9]], 'at the queue crossing');
  assert.deepEqual(lending('2.5'), [[1, 2, 3, 4, 5], [6, 7, 8, 9]], 'no crossing in the first piece: at the overflowing hop');
});

test('exit 2 when a video cannot fit the cap: a hop is never split', () => {
  const r = plan(dir, '--max-min', '1', '--force');
  assert.equal(r.status, 2);
  assert.match(r.stdout, /over the 1 min cap: a hop is never split/);
  plan(dir);   // restore the 25-minute plan for the tests below
});

test('downstream: apply-enrichment takes the plan\'s forms, script-check its sections, timing-report its groups', () => {
  const e = json(join(dir, 'plan.json')).videos.map(v => ({ index: v.index, title: v.title.replace(/ \(part (\d) of \d\)/, ', step $1'), form: v.form, why: 'kept as planned for this check' }));
  writeFileSync(join(dir, 'enrichment.json'), JSON.stringify({ videos: e }));
  const en = spawnSync(process.execPath, [join(COURSEWORK, 'apply-enrichment.mjs'), '--plan', join(dir, 'plan.json'), '--enrichment', join(dir, 'enrichment.json')], { encoding: 'utf8' });
  assert.equal(en.status, 0, en.stdout);
  const script = { videoIndex: 5, title: 'Searching the catalogue and ranking the hits', form: 'flow', segments: [
    { key: 's1', text: 'A search request arrives at the search route with a query string, and the route hands it straight to the search books function in the service module.', style: 'plain', visual: 'code', covers: ['library/api.py :: search @L20'] },
    { key: 's2', text: 'Search books builds a list of hits for the query and asks rank results to order them, so the caller always gets the strongest match first in the list it returns.', style: 'plain', visual: 'code', covers: ['library/service.py :: search_books @L26'] },
    { key: 's3', text: 'Rank results sorts the hits by score, highest first. A unit test pins exactly that: given two hits, the one scoring nine tenths comes back ahead of the one scoring two tenths.', style: 'plain', visual: 'code', covers: ['library/service.py :: rank_results @L31'] }] };
  writeFileSync(join(dir, 'script.json'), JSON.stringify(script));
  const sc = spawnSync(process.execPath, [join(COURSEWORK, 'script-check.mjs'), '--script', join(dir, 'script.json'), '--plan', join(dir, 'plan.enriched.json')], { encoding: 'utf8' });
  assert.equal(sc.status, 0, sc.stdout + sc.stderr);
  assert.match(sc.stdout, /3\/3 assigned sections covered/);
  writeFileSync(join(dir, 'timing.jsonl'), ['2', '3', '5'].map(v => JSON.stringify({ video: v, stage: '3', attempt: 1, seconds: 30, ended_at: '2026-10-29T00:00:00.000Z', note: null })).join('\n') + '\n');
  const tr = spawnSync(process.execPath, [join(COURSEWORK, 'timing-report.mjs'), '--out', dir], { encoding: 'utf8' });
  assert.equal(tr.status, 0, tr.stderr);
  const html = readFileSync(join(dir, 'timing.html'), 'utf8');
  assert.match(html, /Lending/, 'videos grouped by their flow');
  assert.match(html, /Search/);
});

test('exit 4: re-planning under an enriched plan needs --force', () => {
  assert.ok(existsSync(join(dir, 'plan.enriched.json')));
  assert.equal(plan(dir).status, 0, 'same inputs, same approval, same cap: nothing changes');
  const r = plan(dir, '--max-min', '20');
  assert.equal(r.status, 4);
  assert.match(r.stderr, /the cap \(25 → 20 min\) changed/);
  assert.equal(json(join(dir, 'plan.json')).model.maxVideoMin, 25, 'the plan was not overwritten');
  assert.equal(approve(dir).status, 0);
  const reapproved = plan(dir);
  assert.equal(reapproved.status, 4, 'a new approval is a new plan');
  assert.match(reapproved.stderr, /the approval changed/);
  assert.equal(plan(dir, '--force').status, 0);
});

test('exit 1: bad flags or an unreadable list', () => {
  assert.equal(tool('flow-plan.mjs').status, 1);
  assert.equal(plan(dir, '--max-min', '0').status, 1);
  assert.equal(tool('flow-plan.mjs', '--flows', join(dir, 'missing.json')).status, 1);
  rmSync(join(dir, 'plan.enriched.json'));
});
