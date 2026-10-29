// apply-flows validates the agent's series proposal (design §4.4): reasons on every series item and every high-ranked
// skip (C1′), every entry and kept segment triaged (C1, C2), hops connected and on the dispatch the receiver selects
// (C3), cited tests that directly pin an unmocked hop (C3′), and group boundaries. Each negative fixture breaks one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, scratch, cleanup, mineInto, tool } from './helpers.mjs';

const REPO = join(FIXTURES, 'flows', 'repo');
const GOOD = JSON.parse(readFileSync(join(FIXTURES, 'flows', 'flows.json'), 'utf8'));
const TMP = scratch();
after(() => cleanup(TMP));
const CANDIDATES = mineInto(REPO, join(TMP, 'out'));
const NARROW = mineInto(REPO, join(TMP, 'narrow'), ['--explain-top', '1', '--explain-top-eval', '1']);   // only #1 of each group is high-ranked by K

let n = 0;
// write a (mutated) copy of the good proposal in its own dir and validate it
function apply(mutate = () => {}, candidates = CANDIDATES) {
  const dir = join(TMP, `case${n++}`); mkdirSync(dir);
  const flows = structuredClone(GOOD); mutate(flows);
  writeFileSync(join(dir, 'flows.json'), JSON.stringify(flows, null, 1));
  const r = tool('apply-flows.mjs', '--candidates', candidates, '--flows', join(dir, 'flows.json'));
  const read = f => existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null;
  return { ...r, dir, md: read('flows.md'), raw: read('flows.validated.json'), v: read('flows.validated.json') && JSON.parse(read('flows.validated.json')) };
}
const flow = (f, id) => f.flows.find(x => x.id === id);
const fails = (r, re) => { assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, re); assert.equal(r.raw, null, 'no flows.validated.json on a problem'); assert.match(r.md, re); };

const good = apply();

test('the good proposal validates', () => {
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.v.ok, true);
  assert.deepEqual(good.v.series.map(s => [s.kind, s.id, s.rank]), [['flow', 'lending', 'prod #1'], ['core', 'core:fees', null], ['flow', 'search', 'prod #2'], ['flow', 'eval-borrow', 'eval #1']]);
  assert.match(good.stdout, /prod: 5 high-ranked · 2 in series · 0 variant · 3 skipped · 0 unexplained/);
  assert.match(good.stdout, /eval: 2 high-ranked · 1 in series · 0 variant · 1 skipped · 0 unexplained/);
  assert.match(good.stdout, /10 entries · prod 7 · eval 2 · dev 1 \(1 filtered, 0 continuations\) · 0 untriaged · test-group entries: 0 \(listed\)/);
});

test('entry triage (C1): flows, continuations, skips and filtered dev rows', () => {
  assert.deepEqual(Object.fromEntries(good.v.triage.entries.map(t => [t.id, t.status])), {
    'library.api:borrow': 'flow', 'library.api:give_back': 'skipped', 'library.api:search': 'flow', 'library.api:remove': 'skipped', 'library.api:health': 'skipped',
    'library.tasks:notify_member': 'continuation', 'library.tasks:write_audit': 'continuation', 'evals.report:<main>': 'skipped', 'evals.run_eval:<main>': 'flow',
    'scripts.seed:<main>': 'dev-filtered' });
  assert.equal(good.v.triage.entries.find(t => t.id === 'library.tasks:write_audit').by, 'lending', 'a continuation of a kept flow');
});

test('segments (C2) of the kept candidate: the entry, a kept consumer, a mentioned one', () => {
  assert.deepEqual(flow(good.v, 'lending').segments.map(s => [s.root.split(':').pop(), s.decision]), [['borrow', 'entry'], ['notify_member', 'keep'], ['write_audit', 'mention']]);
});

test('hops (C3): how each is reached, which are crossings, the taught branch', () => {
  const hops = flow(good.v, 'lending').hops;
  assert.deepEqual(hops.map(h => h.connection.how), ['entry', 'candidate', 'candidate', 'candidate', 'candidate', 'candidate', 'candidate', 'candidate', 'candidate']);
  assert.deepEqual(hops.find(h => h.name === 'MemoryStore.save').connection.steps.map(s => s.kind), ['return', 'dispatch'], 'back to the caller, then the store it picked');
  const fee = hops.find(h => h.name === 'charge_fee').connection;
  assert.deepEqual([fee.path[0], fee.steps.map(s => s.kind)], ['library.members:MemberChecker.check', ['return', 'return', 'return', 'static']], 'back up the stack from the previous hop');
  assert.deepEqual(hops.filter(h => h.crossing).map(h => h.name), ['notify_member']);
  assert.deepEqual(flow(good.v, 'eval-borrow').hops.filter(h => h.crossing).map(h => h.name), ['check_borrow'], 'an eval hop that drives production is a crossing');
  assert.deepEqual(flow(good.v, 'lending').teach.map(t => [t.dispatch, t.hop]), [['library.store:make_store', 6]]);
});

test('cited tests (C3′) carry the test span and its assertion lines', () => {
  const c = flow(good.v, 'search').hops[2].pinnedBy[0];
  assert.deepEqual([c.test, c.file, c.line, c.end, c.assertLines, c.strength, c.via], ['tests.test_search:test_rank_results_puts_the_best_hit_first', 'tests/test_search.py', 4, 6, [6], 'direct', 'body']);
  assert.equal(good.v.cores[0].hops[0].pinnedBy[0].test, 'tests.test_service:test_late_fee_after_two_weeks', 'a core-level citation lands on its hop');
});

test('flows.md: the approval table, the accounting and every hop', () => {
  assert.match(good.md, /## Approval table[^]*### The proposed series, in video order[^]*### Skipped rows[^]*### Variants[^]*### Dev rows[^]*### Estimate: 6 videos/);
  assert.match(good.md, /\| `health` \| prod \| prod #5 \| yes \| a liveness probe that returns a constant \|/);
  for (const f of [...good.v.flows, ...good.v.cores]) for (const h of f.hops) assert.ok(good.md.includes(`\`${h.symbol}\``), h.symbol);
  assert.match(good.md, /`test_rank_results_puts_the_best_hit_first` \(tests\/test_search\.py:4-6, asserts at 6\) — the best-scoring hit comes first/);
  assert.match(good.md, /`SqlStore` when settings\.store_backend == "sql" \(code defaults: no\)/);
  assert.doesNotMatch(good.md, /undefined|null/);
});

test('two runs produce byte-identical validated flows and flows.md', () => {
  const again = apply();
  assert.equal(again.raw, good.raw);
  assert.equal(again.md, good.md);
});

/* ---------------- the negative fixtures named by the design (§5.6 item 3) ---------------- */
test('an unexplained high-ranked skip fails (C1′)', () => {
  fails(apply(f => { f.skipped = f.skipped.filter(s => s.entry !== 'library.api:health'); }), /prod #5 library\.api:health: is a high-ranked row \(rank <= 10\) and is unexplained/);
});

test('a placeholder reason fails', () => {
  fails(apply(f => { f.series[2].why = 'TBD'; }), /series search: "why" is a placeholder: "TBD"/);
  fails(apply(f => { f.skipped[0].why = 'see the docs for this …'; }), /skipped library\.api:give_back: "why" is a placeholder/);
  fails(apply(f => { f.skipped[1].why = 'admin'; }), /"why" is too short to be a reason/);
  fails(apply(f => { delete f.series[0].why; }), /series lending: needs a "why"/);
});

test('a cited test that mocks its hop fails (C3′)', () => {
  fails(apply(f => { flow(f, 'lending').hops[4].pinnedBy = [{ test: 'tests.test_service:test_borrow_records_the_fee', say: 'the fee lands on the loan' }]; }),
    /lending hop 5 pinnedBy\[0\]: test tests\.test_service:test_borrow_records_the_fee mocks library\.fees:charge_fee: a test that replaces a hop cannot pin it/);
});

test('an untriaged eval row fails (C1), and eval rows are never implicit', () => {
  // with only eval #1 high-ranked, report is an ordinary row: it still needs a decision
  const r = apply(f => { f.skipped = f.skipped.filter(s => s.entry !== 'evals.report:<main>'); for (const s of f.skipped) delete s.rank; }, NARROW);
  fails(r, /entry evals\.report:<main>: \(eval #2\) is untriaged: .* \(eval rows are never triaged implicitly\)/);
  assert.doesNotMatch(r.stderr, /high-ranked row/);
  const excluded = apply(f => { f.skipped = f.skipped.filter(s => s.entry !== 'evals.report:<main>'); for (const s of f.skipped) delete s.rank;
    f.triage = { excluded: [{ match: 'evals.report:*', why: 'averages scores the harness already produced' }] }; }, NARROW);
  assert.equal(excluded.status, 0, excluded.stderr);
  assert.equal(excluded.v.triage.entries.find(t => t.id === 'evals.report:<main>').status, 'excluded');
});

test('a production flow with a test hop fails', () => {
  fails(apply(f => { flow(f, 'lending').hops.splice(4, 0, { symbol: 'tests.test_members:FakeChecker.check' }); }),
    /lending hop 5: tests\.test_members:FakeChecker\.check is test-group code/);
});

/* ---------------- the other checks ---------------- */
test('a glob never explains a high-ranked row', () => {
  fails(apply(f => { f.skipped = f.skipped.filter(s => s.entry !== 'library.api:health'); f.triage = { excluded: [{ match: 'library.api:health', why: 'a liveness probe returning a constant' }] }; }),
    /is unexplained: .*\(an excluded glob does not explain a high-ranked row\)/);
  fails(apply(f => { f.skipped[2].entry = 'library.api:*'; }), /skipped\[2\]: "library\.api:\*" is a glob/);
});

test('every row above the lowest-ranked included row is high-ranked', () => {
  // with K = 1 the skipped rows 3-5 are ordinary and a glob may exclude them...
  const strip = f => { f.skipped = f.skipped.filter(s => s.entry.startsWith('evals')); for (const s of f.skipped) delete s.rank;
    f.triage = { excluded: [{ match: 'library.api:*', why: 'thin routes with no logic of their own' }] }; };
  const ok = apply(strip, NARROW);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /prod: 2 high-ranked · 2 in series/);
  // ...until the series includes #5: then #3 and #4 sit above it and each needs its own reason
  const r = apply(f => { strip(f); f.flows.push({ id: 'probe', title: 'The liveness probe', from: 'library.api:health', hops: ['library.api:health'] }); f.series.push({ flow: 'probe', why: 'what the load balancer polls every second' }); }, NARROW);
  fails(r, /prod #3 library\.api:give_back: is a high-ranked row \(rank <= 1 or at or above #5, the lowest-ranked row the series includes\)/);
  assert.match(r.stderr, /prod #4 library\.api:remove/);
});

test('an untriaged segment fails (C2); a mention needs a say', () => {
  fails(apply(f => { delete flow(f, 'lending').segments.mention; }), /flow lending: segment library\.tasks:write_audit \(reached from library\.service:LoanService\.borrow by queue\) is untriaged/);
  fails(apply(f => { flow(f, 'lending').segments.mention[0].say = ''; }), /needs a "say"/);
  fails(apply(f => { flow(f, 'lending').segments.keep.push('library.tasks:format_notice'); }), /library\.tasks:format_notice is not a segment of library\.api:borrow/);
  const glob = apply(f => { delete flow(f, 'lending').segments.mention; f.triage = { excluded: [{ match: 'library.tasks:write_*', why: 'the audit trail is out of scope for this series' }] }; });
  assert.equal(glob.status, 0, glob.stderr);
  assert.deepEqual(flow(glob.v, 'lending').segments[2], { root: 'library.tasks:write_audit', from: 'library.service:LoanService.borrow', kind: 'queue', own: 1, folded: 1,
    decision: 'exclude', why: 'the audit trail is out of scope for this series', rule: 'library.tasks:write_*' });
});

test('an unconnected hop fails (C3); a declared link with real evidence connects it', () => {
  fails(apply(f => { flow(f, 'search').hops.splice(2, 0, { symbol: 'library.service:remove_book' }); }), /flow search: hop 2→3 not connected: library\.service:remove_book/);
  const linked = apply(f => { const s = flow(f, 'search'); s.hops.splice(2, 0, { symbol: 'library.service:remove_book' });
    s.links = [{ from: 'library.service:search_books', to: 'library.service:remove_book', kind: 'static', evidence: 'library/service.py:35-37 the curator removes what search surfaced' }]; });
  assert.equal(linked.status, 0, linked.stderr);
  assert.equal(flow(linked.v, 'search').hops[2].connection.how, 'link');
  fails(apply(f => { const s = flow(f, 'search'); s.hops.splice(2, 0, { symbol: 'library.service:remove_book' });
    s.links = [{ from: 'library.service:search_books', to: 'library.service:remove_book', kind: 'static', evidence: 'library/service.py:90-91' }]; }), /past the end of the file/);
});

test('a hop on a config alternative no profile selects fails; teach it instead', () => {
  fails(apply(f => { flow(f, 'lending').hops[6].symbol = 'library.store:SqlStore.save'; }), /SqlStore alternative at .*no profile selects \(code defaults → MemoryStore\): teach it instead/);
  fails(apply(f => { flow(f, 'lending').teach[0].dispatch = 'library.store:nowhere'; }), /not a recorded dispatch point/);
});

test('a test that only reaches its hop may be cited only as reachable', () => {
  const hop = f => flow(f, 'lending').hops[2];
  fails(apply(f => { hop(f).pinnedBy = [{ test: 'tests.test_service:test_borrow_records_the_fee', say: 'members are checked on every borrow' }]; }),
    /has no direct link to library\.members:check_member \(it only reaches it: cite it with "strength": "reachable"/);
  const ok = apply(f => { hop(f).pinnedBy = [{ test: 'tests.test_service:test_borrow_records_the_fee', say: 'members are checked on every borrow', strength: 'reachable' }]; });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(flow(ok.v, 'lending').hops[2].pinnedBy[0].strength, 'reachable');
  assert.match(ok.md, /reachable only: never "tested"/);
});

test('an eval flow names the production flow it drives instead of re-narrating it', () => {
  fails(apply(f => { flow(f, 'eval-borrow').hops.splice(2, 0, { symbol: 'library.api:borrow' }); }), /eval-borrow hop 3: library\.api:borrow is production code/);
  fails(apply(f => { flow(f, 'eval-borrow').hops[1].exercises = 'search'; }), /check_borrow exercises search, but it calls none of that flow's code/);
  fails(apply(f => { flow(f, 'lending').hops[1].exercises = 'search'; }), /"exercises" marks the hop of an eval or dev flow/);
});

test('existence, shape and series checks', () => {
  fails(apply(f => { flow(f, 'lending').hops[1].pinnedby = []; }), /unknown field "pinnedby"/);
  fails(apply(f => { f.skipped[0].rank = 'prod #9'; }), /says prod #9 but ranks prod #3/);
  fails(apply(f => { f.series.pop(); }), /flow eval-borrow: is defined but not in the series/);
  fails(apply(f => { f.series = []; }), /series: is empty/);
  fails(apply(f => { flow(f, 'search').hops[0].symbol = 'library.service:search_books'; }), /a flow opens on its entry/);
  fails(apply(f => { flow(f, 'search').title = 'lending-path'; }), /is a slug/);
  fails(apply(f => { f.skipped.push({ entry: 'library.api:borrow', why: 'already the first flow of the series' }); }), /library\.api:borrow is already decided \(flow in flow lending\)/);
  fails(apply(f => { f.promote = [{ entry: 'library.api:health', why: 'it is not a dev row at all' }]; }), /only dev rows are promoted/);
  fails(apply(f => { flow(f, 'lending').hops[4].uses = 'core:nothing'; }), /uses "core:nothing", which is not a core/);
  fails(apply(f => { flow(f, 'search').hops[2].lines = '40-50'; }), /lines 40-50 fall outside 31-32/);
});

test('a promoted dev row needs a decision like any other', () => {
  fails(apply(f => { f.promote = [{ entry: 'scripts.seed:<main>', why: 'seeding shows the whole write path offline' }]; }), /entry scripts\.seed:<main>: \(dev #1\) is untriaged: .* \(it is promoted\)/);
});

/* ---------------- the tool's contract ---------------- */
test('exit 1: missing flags, unreadable or mismatched inputs, output inside the repo', () => {
  assert.equal(tool('apply-flows.mjs').status, 1);
  assert.equal(tool('apply-flows.mjs', '--candidates', CANDIDATES).status, 1);
  assert.equal(tool('apply-flows.mjs', '--candidates', CANDIDATES, '--flows', join(TMP, 'missing.json')).status, 1);
  const mixed = join(TMP, 'mixed'); mkdirSync(mixed);
  for (const f of ['codemap.json', 'ranking.json']) writeFileSync(join(mixed, f), readFileSync(join(TMP, 'out', f)));
  writeFileSync(join(mixed, 'candidates.json'), JSON.stringify({ ...JSON.parse(readFileSync(CANDIDATES, 'utf8')), treeHash: 'sha256:other' }));
  const r = tool('apply-flows.mjs', '--candidates', join(mixed, 'candidates.json'), '--flows', join(FIXTURES, 'flows', 'flows.json'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /different trees/);
  // a code map whose repo root holds the flows: nothing may be written inside the mined repo
  const repo = join(TMP, 'inside'); mkdirSync(repo);
  for (const f of ['codemap.json', 'candidates.json', 'ranking.json']) writeFileSync(join(repo, f), JSON.stringify({ ...JSON.parse(readFileSync(join(TMP, 'out', f), 'utf8')), root: repo }));
  writeFileSync(join(repo, 'flows.json'), JSON.stringify(GOOD));
  const inside = tool('apply-flows.mjs', '--candidates', join(repo, 'candidates.json'), '--flows', join(repo, 'flows.json'));
  assert.equal(inside.status, 1);
  assert.match(inside.stderr, /refusing to write inside the repo/);
  assert.equal(existsSync(join(repo, 'flows.md')), false);
});

test('a failing run removes a stale flows.validated.json', () => {
  const dir = join(TMP, 'stale'); mkdirSync(dir);
  writeFileSync(join(dir, 'flows.json'), JSON.stringify(GOOD));
  assert.equal(tool('apply-flows.mjs', '--candidates', CANDIDATES, '--flows', join(dir, 'flows.json')).status, 0);
  assert.ok(existsSync(join(dir, 'flows.validated.json')));
  writeFileSync(join(dir, 'flows.json'), JSON.stringify({ ...GOOD, series: [] }));
  assert.equal(tool('apply-flows.mjs', '--candidates', CANDIDATES, '--flows', join(dir, 'flows.json')).status, 2);
  assert.equal(existsSync(join(dir, 'flows.validated.json')), false);
});
