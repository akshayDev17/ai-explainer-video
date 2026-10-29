// flow-diagram (design §4.6) generates a diagram's skeleton from the validated flows: the system map's modules and
// calls, a flow's call sequence across its crossings, and an eval flow's hand-off to the production flow it drives,
// named by its video number instead of re-drawn.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, scratch, cleanup, mineInto, tool } from './helpers.mjs';

const TMP = scratch();
after(() => cleanup(TMP));
const CANDIDATES = mineInto(join(FIXTURES, 'flows', 'repo'), join(TMP, 'out'));
const DIR = join(TMP, 'flows'); mkdirSync(DIR);
writeFileSync(join(DIR, 'flows.json'), readFileSync(join(FIXTURES, 'flows', 'flows.json')));
assert.equal(tool('apply-flows.mjs', '--candidates', CANDIDATES, '--flows', join(DIR, 'flows.json')).status, 0);
const V = join(DIR, 'flows.validated.json');
const diagram = (...args) => { const r = tool('flow-diagram.mjs', '--flows', V, ...args); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };

test('map: one box per module the series runs through, its hops as members, an arrow per call between modules', () => {
  const d = diagram('--as', 'map');
  assert.equal(d.host, 'diagram');
  assert.deepEqual(d.items, ['lending', 'core:fees', 'search', 'eval-borrow']);
  const byLabel = Object.fromEntries(d.config.nodes.map(n => [n.label, n]));
  assert.deepEqual(byLabel['library.service'].members, ['LoanService.borrow', 'search_books', 'rank_results']);
  assert.equal(byLabel['library.service'].stereotype, 'library.service · prod');
  const arrow = (a, b) => d.config.edges.find(e => e.from === byLabel[a].id && e.to === byLabel[b].id);
  assert.equal(arrow('library.service', 'library.tasks').color, 'hub', 'the queue hand-off');
  assert.equal(arrow('evals.run_eval', 'library.api').color, 'ok', 'the eval harness drives the API over HTTP');
  assert.deepEqual(d.crossings.map(c => `${c.kind} ${c.from} -> ${c.to}`), ['queue library.service:LoanService.borrow -> library.tasks:notify_member', 'http evals.run_eval:check_borrow -> library.api:borrow']);
  for (const n of d.config.nodes) assert.ok(d.config.layout.columns[n.column] && d.config.layout.rows[n.row] != null, `${n.id} is placed`);
  assert.deepEqual(diagram('--as', 'map', '--flow', 'search').config.nodes.map(n => n.label), ['library.api', 'library.service']);
});

test('sequence: the request, then one message per hop across the modules, the queue crossing marked', () => {
  const d = diagram('--as', 'sequence', '--flow', 'lending');
  assert.equal(d.primitive, 'sequence');
  const p = d.params;
  assert.deepEqual(p.participants[0], { id: 'caller', label: 'POST /v1/loans', sub: 'HTTP request' });
  const label = id => p.participants.find(x => x.id === id).label;
  assert.deepEqual(p.messages.map(m => `${label(m.from)} -${m.kind}-> ${label(m.to)} ${m.label}`), [
    'POST /v1/loans -http-> library.api borrow',
    'library.api -call-> library.service LoanService.borrow',
    'library.service -call-> library.members check_member',
    'library.members -call-> library.members MemberChecker.check',
    'library.service -call-> library.fees charge_fee',
    'library.service -call-> library.store make_store',
    'library.service -call-> library.store MemoryStore.save',
    'library.service -queue-> library.tasks notify_member',
    'library.tasks -call-> library.tasks format_notice',
  ]);
  assert.equal(p.messages[3].via, 1, 'MemberChecker.check is reached through one unnarrated call');
  assert.deepEqual(diagram('--as', 'sequence', '--flow', 'core:fees').params.participants[0], { id: 'caller', label: 'caller', sub: 'shared code: called from several flows' });
});

test('exercises: the harness lane, the production flow as one box with its video number, the HTTP crossing between', () => {
  const d = diagram('--as', 'exercises', '--flow', 'eval-borrow');
  assert.deepEqual(d.exercises, [{ hop: 2, symbol: 'evals.run_eval:check_borrow', target: 'lending', targetTitle: "Borrowing a book: from the request to the member's notice",
    video: 2, videoFrom: 'estimate (no plan.json from this file)', kind: 'http', to: 'library.api:borrow', evidence: 'evals/run_eval.py:6 POST /v1/loans' }]);
  assert.deepEqual(d.config.nodes.map(n => `${n.column} ${n.label}`), ['harness <main>', 'harness check_borrow', 'harness grade', 'production lending']);
  assert.deepEqual(d.config.nodes.at(-1).members, ['see video 2']);
  assert.deepEqual(d.config.edges, [{ id: 'x0', from: 'h2', to: 'flow:lending', arrow: true, color: 'ok' }]);
  // the sequence view names the driven flow by video too, and never re-draws it
  const s = diagram('--as', 'sequence', '--flow', 'eval-borrow').params;
  assert.deepEqual(s.participants.at(-1), { id: 'flow:lending', label: "Borrowing a book: from the request to the member's notice", sub: 'see video 2' });
});

test('the video number comes from plan.json when it was planned from this file', () => {
  assert.equal(tool('approve-flows.mjs', '--flows', V, '--by', 'user', '--note', 'yes').status, 0);
  assert.equal(tool('flow-plan.mjs', '--flows', V).status, 0);
  const plan = JSON.parse(readFileSync(join(DIR, 'plan.json'), 'utf8'));
  const d = diagram('--as', 'exercises', '--flow', 'eval-borrow');
  assert.deepEqual([d.exercises[0].video, d.exercises[0].videoFrom], [plan.videos.find(x => x.group === 'lending').index, 'plan.json']);
  // a plan made from another validated list is not trusted for numbering
  writeFileSync(join(DIR, 'plan.json'), JSON.stringify({ ...plan, inputs: { ...plan.inputs, validated: { ...plan.inputs.validated, sha256: '0'.repeat(64) } } }));
  assert.equal(diagram('--as', 'exercises', '--flow', 'eval-borrow').exercises[0].videoFrom, 'estimate (no plan.json from this file)');
});

test('a hop that drives production by a direct call is drawn with apply-flows\' drive; one box per driven flow', () => {
  const repo = join(TMP, 'direct-repo'); cpSync(join(FIXTURES, 'flows', 'repo'), repo, { recursive: true });
  const evalPy = join(repo, 'evals', 'run_eval.py');
  writeFileSync(evalPy, readFileSync(evalPy, 'utf8')
    .replace('import httpx\n', 'import httpx\n\nfrom library.members import check_member\n')
    .replace('\n\nif __name__', '\n\ndef check_rule():\n    return grade(check_member({"active": True}))\n\n\nif __name__')
    .replace('    print(check_borrow("http://localhost:8000"))\n', '    print(check_borrow("http://localhost:8000"))\n    print(check_rule())\n'));
  const candidates = mineInto(repo, join(TMP, 'direct-out'));
  const dir = join(TMP, 'direct-flows'); mkdirSync(dir);
  const f = JSON.parse(readFileSync(join(FIXTURES, 'flows', 'flows.json'), 'utf8'));
  f.flows.find(x => x.id === 'eval-borrow').hops.splice(2, 0, { symbol: 'evals.run_eval:check_rule', exercises: 'lending' });
  writeFileSync(join(dir, 'flows.json'), JSON.stringify(f));
  const applied = tool('apply-flows.mjs', '--candidates', candidates, '--flows', join(dir, 'flows.json'));
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const run = (...a) => { const r = tool('flow-diagram.mjs', '--flows', join(dir, 'flows.validated.json'), ...a); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const call = { kind: 'call', to: 'library.members:check_member', evidence: null };
  const x = run('--as', 'exercises', '--flow', 'eval-borrow');
  assert.deepEqual(x.exercises.map(l => [l.symbol, l.kind, l.to]), [['evals.run_eval:check_borrow', 'http', 'library.api:borrow'], ['evals.run_eval:check_rule', call.kind, call.to]]);
  assert.deepEqual(x.config.nodes.filter(n => n.column === 'production').map(n => n.label), ['lending']);
  const m = run('--as', 'map');
  assert.deepEqual(m.crossings.filter(c => c.exercises).map(c => `${c.kind} ${c.from} -> ${c.to}`), ['http evals.run_eval:check_borrow -> library.api:borrow', 'call evals.run_eval:check_rule -> library.members:check_member']);
  const byLabel = Object.fromEntries(m.config.nodes.map(n => [n.label, n.id]));
  assert.ok(m.config.edges.some(e => e.from === byLabel['evals.run_eval'] && e.to === byLabel['library.members']), 'the direct call is an arrow into production');
  const s = run('--as', 'sequence', '--flow', 'eval-borrow').params;
  assert.equal(s.participants.filter(p => p.id === 'flow:lending').length, 1, 'two hops driving one flow share its participant');
  assert.deepEqual(s.messages.filter(x => x.to === 'flow:lending').map(x => [x.hop, x.kind]), [[2, 'http'], [3, 'call']]);
});

test('flow-diagram refuses bad flags, an unknown flow, and exercises on a flow that drives none (exit 1)', () => {
  const run = (...a) => tool('flow-diagram.mjs', '--flows', V, ...a);
  assert.equal(run('--as', 'graph').status, 1);
  assert.equal(run('--as', 'sequence').status, 1, 'a sequence draws one flow');
  assert.equal(run('--as', 'map', '--flow', 'nope').status, 1);
  const r = run('--as', 'exercises', '--flow', 'lending');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lending has no hop that exercises a production flow/);
});
