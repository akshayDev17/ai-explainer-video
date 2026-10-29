// On-screen code (design §4.6, §5.4, ADR-005): excerpt cuts a panel from the repo as mined, showing only the narrated
// lines with real numbers and elision markers, and a cited test's side of a "pinned by" pair; excerpt-check proves
// every panel is byte-identical to the mined file (exit 2 on drift) and every shown line sits in a focus window synced
// to the narration, except in at most three pause segments (exit 3).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, SKILL, scratch, cleanup, gitRepo, git, tool } from './helpers.mjs';

const TMP = scratch();
after(() => cleanup(TMP));

// a git work tree with a commit, so a panel can be checked against the file at the mined commit
function committed(from) {
  const dir = gitRepo(from);
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'fixture');
  return dir;
}
const mine = (repo, out) => {
  const r = spawnSync(process.execPath, [join(SKILL, 'tools', 'mine.mjs'), repo, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return join(out, 'codemap.json');
};
const REPO = committed(join(FIXTURES, 'flows', 'repo'));
const CODEMAP = mine(REPO, join(TMP, 'out'));
const excerpt = (...args) => tool('excerpt.mjs', '--codemap', CODEMAP, ...args);
const panel = (...args) => { const r = excerpt(...args); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const fileLines = f => readFileSync(join(REPO, f), 'utf8').split('\n');
const BORROW = 'library.service:LoanService.borrow';

test('a whole symbol: the file\'s lines byte for byte, with their real numbers and the mined source', () => {
  const p = panel('--symbol', BORROW);
  assert.deepEqual(p.numbers, [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  assert.deepEqual(p.lines, fileLines('library/service.py').slice(8, 18));
  assert.deepEqual(p.elided, []);
  assert.equal(p.lang, 'python');
  assert.equal(p.source.symbol, BORROW);
  assert.deepEqual([p.source.file, p.source.start, p.source.end], ['library/service.py', 9, 18]);
  assert.equal(p.source.sha256, JSON.parse(readFileSync(CODEMAP, 'utf8')).symbols.find(s => s.id === BORROW).sha256);
  assert.match(p.source.commit, /^[0-9a-f]{40}$/);
});

test('only the narrated lines: every unshown run collapses into one elision marker', () => {
  const p = panel('--symbol', BORROW, '--lines', '10-11,17');
  assert.deepEqual(p.numbers, [null, 10, 11, null, 17, null]);
  assert.deepEqual(p.lines.filter((_, i) => p.numbers[i] == null), ['    ⋯ 1 line', '        ⋯ 5 lines', '        ⋯ 1 line']);
  assert.deepEqual(p.elided, [{ at: 0, from: 9, to: 9 }, { at: 3, from: 12, to: 16 }, { at: 5, from: 18, to: 18 }]);
});

test('a run of blank lines is shown, not elided; the cap counts shown lines', () => {
  const dir = join(TMP, 'blank'); mkdirSync(join(dir, 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'pkg', '__init__.py'), '');
  writeFileSync(join(dir, 'pkg', 'm.py'), 'def run(x):\n    a = x\n\n\n    b = a\n' + Array.from({ length: 25 }, (_, i) => `    c${i} = b\n`).join('') + '    return b\n');
  const codemap = mine(dir, join(TMP, 'blank-out'));
  const p = JSON.parse(tool('excerpt.mjs', '--codemap', codemap, '--symbol', 'pkg.m:run', '--lines', '1-2,5').stdout);
  assert.deepEqual(p.numbers.slice(0, 5), [1, 2, 3, 4, 5]);
  const over = tool('excerpt.mjs', '--codemap', codemap, '--symbol', 'pkg.m:run');
  assert.equal(over.status, 2);
  assert.match(over.stderr, /31 lines shown, over the 22-line cap/);
  assert.equal(tool('excerpt.mjs', '--codemap', codemap, '--symbol', 'pkg.m:run', '--max', '40').status, 1, 'the cap is fixed');
});

test('a test panel: its def line, the line that calls the hop and its assertions, elided between', () => {
  const p = panel('--symbol', BORROW, '--test', 'tests.test_service:test_borrow_records_the_fee');
  assert.deepEqual(p.numbers, [8, null, 10, 11]);
  assert.equal(p.lines[0], 'def test_borrow_records_the_fee(fee):');
  assert.equal(p.lines[3], '    assert loan["fee"] == 50');
  assert.deepEqual([p.source.file, p.source.test, p.source.pins, p.source.via], ['tests/test_service.py', 'tests.test_service:test_borrow_records_the_fee', BORROW, 'body']);
});

test('a test that mocks the hop, or only reaches it, cannot be shown as pinning it', () => {
  const mocks = excerpt('--symbol', 'library.fees:charge_fee', '--test', 'tests.test_service:test_borrow_records_the_fee');
  assert.equal(mocks.status, 2);
  assert.match(mocks.stderr, /mocks library\.fees:charge_fee/);
  const reaches = excerpt('--symbol', 'library.service:rank_results', '--test', 'tests.test_search:test_search_returns_hits');
  assert.equal(reaches.status, 2);
  assert.match(reaches.stderr, /no direct link/);
});

test('excerpt refuses a missing symbol, a line outside the span, a changed file, and bad flags', () => {
  assert.equal(excerpt('--symbol', 'library.service:nope').status, 2);
  const outside = excerpt('--symbol', BORROW, '--lines', '8-10');
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /outside library\.service:LoanService\.borrow \(lines 9-18/);
  assert.equal(excerpt('--symbol', BORROW, '--lines', 'ten').status, 1);
  assert.equal(excerpt('--symbol', BORROW, '--bogus').status, 1);
  const dir = gitRepo(join(FIXTURES, 'flows', 'repo')), codemap = mine(dir, join(TMP, 'changed-out'));
  writeFileSync(join(dir, 'library', 'service.py'), readFileSync(join(dir, 'library', 'service.py'), 'utf8').replace('log_event("borrow")', 'log_event("lend")'));
  const changed = tool('excerpt.mjs', '--codemap', codemap, '--symbol', BORROW);
  assert.equal(changed.status, 2);
  assert.match(changed.stderr, /changed since it was mined/);
});

/* ---------------- excerpt-check ---------------- */
// one segment, two panels (the hop and its test), focus windows bound to narration lines; lead 0.5 s
const HOP = panel('--symbol', BORROW, '--lines', '9-13,16-18');
const PIN = panel('--symbol', BORROW, '--test', 'tests.test_service:test_borrow_records_the_fee');
const LINES = { lead: 0.5, lines: [{ line: 0, start: 0, end: 1.4 }, { line: 1, start: 1.6, end: 4.4 }, { line: 2, start: 4.6, end: 6.8 }] };
const goodScene = () => ({
  total: 8,
  panels: [{ id: 'hop', ...structuredClone(HOP) }, { id: 'pin', ...structuredClone(PIN) }],
  acts: [
    { op: 'show', panel: 'hop', from: 0, to: 0.5 },
    { op: 'focus', panel: 'hop', lines: [1, 2], from: 0.5, to: 2.0, narration: 0 },
    { op: 'focus', panel: 'hop', lines: [3, 4, 5, 7, 8, 9], from: 2.1, to: 4.95, narration: 1 },
    { op: 'focus', panel: 'pin', lines: [1, 3, 4], from: 5.1, to: 7.5, narration: 2 },
  ],
});
let w = 0;
// a work dir: manifest.json, one scene per segment, lines.json, script.json; `extra` adds more code segments, `pauses`
// names the segments whose script segment carries a pause
function work(scene = goodScene(), { extra = {}, lines = LINES, pauses = [] } = {}) {
  const dir = join(TMP, `work${w++}`); mkdirSync(join(dir, 'scenes'), { recursive: true });
  const all = { hop2: scene, ...extra };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ hosts: { code: 'src/scene-code.html' }, segments: Object.fromEntries(Object.keys(all).map(k => [k, { host: 'code', scene: k }])) }));
  for (const [k, cfg] of Object.entries(all)) writeFileSync(join(dir, 'scenes', `${k}.js`), `window.SCENE_CONFIG = ${JSON.stringify(cfg, null, 1)};\n`);
  if (lines) writeFileSync(join(dir, 'lines.json'), JSON.stringify({ segments: Object.fromEntries(Object.keys(all).map(k => [k, lines])) }));
  writeFileSync(join(dir, 'script.json'), JSON.stringify({ videoIndex: 2, title: 'x', segments: Object.keys(all).map(k =>
    pauses.includes(k) ? { key: k, text: 'Pause the video here and read this block.', pause: { dwell: 2 } } : { key: k, text: 'Read on.' }) }));
  return dir;
}
const check = (dir, repo = REPO) => tool('excerpt-check.mjs', '--work', dir, '--repo', repo, '--script', join(dir, 'script.json'));

test('excerpt-check passes panels cut by excerpt with every shown line in a narration-synced focus window', () => {
  const r = check(work());
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /1 code scene\(s\) · 2 panel\(s\) · 0 pause segment\(s\)/);
  assert.match(r.stdout, /every panel is the mined code, and every shown line is narrated/);
});

test('drift exits 2: an edited line, a typed panel, a fake elision marker, a gap hidden without a marker', () => {
  const edit = goodScene(); edit.panels[0].lines[1] = '        log_event("lend")';
  assert.match(check(work(edit)).stdout, /library\/service\.py:10 differs from the file/);
  assert.equal(check(work(edit)).status, 2);
  const typed = goodScene(); delete typed.panels[1].source;
  assert.equal(check(work(typed)).status, 2);
  const fake = goodScene(); fake.panels[0].lines[5] = '        os.system("rm -rf /")';
  const rf = check(work(fake));
  assert.equal(rf.status, 2);
  assert.match(rf.stdout, /unnumbered but not the elision marker for lines 14-15/);
  const hidden = goodScene(); hidden.panels[0].lines.splice(5, 1); hidden.panels[0].numbers.splice(5, 1); hidden.panels[0].elided = [];
  const rh = check(work(hidden));
  assert.equal(rh.status, 2);
  assert.match(rh.stdout, /library\/service\.py:14-15 hidden without an elision marker/);
});

test('the file at the mined commit stands in for a working tree edited since mining; with no such commit it is drift', () => {
  const dir = work();
  const edited = join(REPO, 'library', 'service.py'), before = readFileSync(edited, 'utf8');
  writeFileSync(edited, before.replace('return loan', 'return dict(loan)'));
  try {
    const r = check(dir);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /commit [0-9a-f]{12}/);
    const noCommit = goodScene(); noCommit.panels[0].source.commit = null;
    const d = check(work(noCommit));
    assert.equal(d.status, 2);
    assert.match(d.stdout, /is not the file excerpt\.mjs read/);
  } finally { writeFileSync(edited, before); }
});

test('focus exits 3: a shown line no focus window covers, a window off the narration, a window naming no line', () => {
  const unread = goodScene(); unread.acts.splice(2, 1);
  const r = check(work(unread));
  assert.equal(r.status, 3);
  assert.match(r.stdout, /hop2\/hop: 6 shown line\(s\) outside every narration-synced focus window: library\/service\.py:11,12,13,16,17,18/);
  const off = goodScene(); off.acts[1].from = 1.5;
  assert.match(check(work(off)).stdout, /starts 1\.00s off narration line 0's onset/);
  const late = goodScene(); late.acts[1].to = 3.5;
  assert.match(check(work(late)).stdout, /must end between narration line 0's end/);
  const open = goodScene(); delete open.acts[3].to;
  assert.match(check(work(open)).stdout, /needs numeric from and to/);
  const unbound = goodScene(); delete unbound.acts[3].narration;
  const ru = check(work(unbound));
  assert.equal(ru.status, 3);
  assert.match(ru.stdout, /names no narration line/);
});

test('a pause segment may show a whole block unfocused, with its badge; at most three per video', () => {
  const whole = goodScene(); whole.acts = whole.acts.filter(a => a.op !== 'focus'); whole.acts.push({ op: 'pause', from: 4, to: 6 });
  assert.equal(check(work(whole, { pauses: ['hop2'] })).status, 0);
  const badgeOnly = check(work(whole));
  assert.equal(badgeOnly.status, 3, 'a badge alone does not make a pause segment: the script must ask for it');
  assert.match(badgeOnly.stdout, /a pause badge on a segment whose narration does not ask for a pause/);
  const noBadge = goodScene(); noBadge.acts = noBadge.acts.filter(a => a.op !== 'focus');
  const rb = check(work(noBadge, { pauses: ['hop2'] }));
  assert.equal(rb.status, 3);
  assert.match(rb.stdout, /a pause segment shows no pause badge/);
  const stray = goodScene(); stray.acts.push({ op: 'pause', from: 4, to: 6 });
  assert.match(check(work(stray)).stdout, /a pause badge on a segment whose narration does not ask for a pause/);
  const four = work(whole, { extra: { a: whole, b: whole, c: whole }, pauses: ['hop2', 'a', 'b', 'c'] });
  const rf = check(four);
  assert.equal(rf.status, 3);
  assert.match(rf.stdout, /4 pause segments \(max 3\)/);
});

test('excerpt-check needs --script, a manifest, code scenes and lines.json (exit 1)', () => {
  const dir = work();
  const noScript = tool('excerpt-check.mjs', '--work', dir, '--repo', REPO);
  assert.equal(noScript.status, 1);
  assert.match(noScript.stderr, /usage: .*--script/);
  assert.equal(check(work(goodScene(), { lines: null })).status, 1);
  const noManifest = work(); rmSync(join(noManifest, 'manifest.json'));
  const rm = check(noManifest);
  assert.equal(rm.status, 1);
  assert.match(rm.stderr, /no manifest\.json/);
  const noCode = work(); writeFileSync(join(noCode, 'manifest.json'), JSON.stringify({ hosts: {}, segments: { hop2: { host: 'diagram', scene: 'hop2' } } }));
  assert.match(check(noCode).stderr, /no code scenes/);
  rmSync(join(noCode, 'scenes'), { recursive: true });
  assert.equal(check(noCode).status, 1);
});
