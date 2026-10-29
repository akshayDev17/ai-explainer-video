#!/usr/bin/env node
/* =============================================================================
   propose.mjs — one candidate flow per prod, eval and dev entry point, walked
   from the code map; plus how far each test's direct links reach.

   Usage:
     node tools/propose.mjs --codemap out/<name>/codemap.json [--fanin 6] [--leafy 5] [--no-iface-fold]

   Writes candidates.json beside the code map. Each candidate is
   the tree of paths from its entry: every node with how it was reached and why
   it was folded (helper, interface, alternative, uses-prod), cut into segments
   at same-group crossings, with dispatch points, config-guarded branches, the
   test doubles it refused to walk, and for an eval or dev entry the production
   code it exercises. An entry reached through another candidate's same-group
   crossing is a continuation of that candidate. Tests are not entries: each
   test's direct links (from mine) are walked, stopping at what it mocks, to
   record what it exercises. No candidate is chosen here; rank.mjs orders them.

   Exit: 0 ok · 1 bad flags, unreadable code map, or the code map inside the repo
         · 2 an entry could not be walked (its symbol is not in the code map)
   ========================================================================== */
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, sep, relative } from 'node:path';
import { indexCodemap } from './lib/walk.mjs';

const fail = (code, msg) => { console.error(`[propose] ${msg}`); process.exit(code); };

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
const VALUED = new Set(['--codemap', '--fanin', '--leafy']);
const flags = new Map();
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) { if (argv[i + 1] == null) fail(1, `${argv[i]} needs a value`); flags.set(argv[i], argv[++i]); }
  else if (argv[i] === '--no-iface-fold') flags.set(argv[i], true);
  else fail(1, `unknown argument ${argv[i]}`);
}
if (!flags.has('--codemap')) fail(1, 'usage: propose.mjs --codemap out/<name>/codemap.json [--fanin 6] [--leafy 5] [--no-iface-fold]');
const count = (flag, d) => { const v = flags.has(flag) ? Number(flags.get(flag)) : d; if (!Number.isInteger(v) || v < 0) fail(1, `${flag} must be a whole number`); return v; };
const params = { fanin: count('--fanin', 6), leafy: count('--leafy', 5), ifaceFold: !flags.has('--no-iface-fold') };
const CODEMAP = resolve(flags.get('--codemap'));
let m;
try { m = JSON.parse(readFileSync(CODEMAP, 'utf8')); } catch (e) { fail(1, `cannot read the code map ${CODEMAP}: ${e.message}`); }
if (m.schema !== 1 || !Array.isArray(m.symbols) || !Array.isArray(m.edges)) fail(1, `${CODEMAP} is not a mine.mjs code map (schema 1)`);
const OUT = dirname(CODEMAP);
if (m.root && existsSync(m.root)) { const root = realpathSync(m.root), o = realpathSync(OUT); if (o === root || o.startsWith(root + sep)) fail(1, `refusing to write inside the repo: ${OUT}`); }

/* ---------------- candidates ---------------- */
const t0 = Date.now();
const W = indexCodemap(m, params);
const { sym, G, declCls, entryIds } = W;
const entryGroup = new Map(m.entries.map(e => [e.id, e.group]));
const unwalked = m.entries.filter(e => e.group !== 'test' && !sym.has(e.id));
const cands = m.entries.filter(e => e.group !== 'test' && sym.has(e.id)).map(e => ({ entry: e, group: e.group, ...W.expand(e, { grp: e.group }) }));
for (const c of cands) {
  // segments: the entry, then every crossing that stays in the candidate's group; a crossing into another group
  // (an eval's HTTP call into a production route) is an `exercises` link, not a segment
  const roots = [{ root: c.entry.id, from: null }, ...c.crossings.filter(x => x.intoGroup === c.group)
    .filter((x, i, a) => a.findIndex(y => y.to === x.to) === i).map(x => ({ root: x.to, from: x.from, kind: x.kind }))];
  c.segments = roots.map(r => { const sub = W.expand({ id: r.root, kind: 'segment' }, { grp: c.group, stopAtCrossing: true });
    return { ...r, own: sub.own.size, folded: sub.folded.size, ownIds: [...sub.own] }; });
  c.exercises = c.crossings.filter(x => x.intoGroup !== c.group && x.intoGroup !== 'ext').map(({ from, to, kind, evidence }) => ({ from, to, kind, evidence }));
}
const parentOf = new Map();   // continuation: an entry reached through a same-group crossing of another candidate
for (const c of cands) for (const x of c.crossings) if (entryIds.has(x.to) && x.to !== c.entry.id && entryGroup.get(x.to) === c.group)
  (parentOf.get(x.to) || parentOf.set(x.to, new Set()).get(x.to)).add(c.entry.id);

/* ---------------- tests: direct links (mine's) and what each reaches ---------------- */
// reach starts at the direct target with the call site's receiver, stops at the test's mocks and at crossings,
// and counts only expanded code (and helpers): reach, not proof
const direct = new Map(), exercised = new Map();
const addTo = (map, k, t) => (map.get(k) || map.set(k, new Set()).get(k)).add(t);
const testLinks = (m.tests || []).map(t => {
  const mocked = new Set(t.mocked);
  const ex = new Set();
  for (const l of t.direct) {
    addTo(direct, l.to, t.id);
    const w = W.expand({ id: l.to }, { grp: G(l.to), stopAtCrossing: true, stop: mocked, ctx0: l.recvClass || declCls(l.to) });
    for (const n of w.order) if ((!n.folded || n.folded === 'helper') && !n.id.startsWith('ext:')) ex.add(n.id);
  }
  for (const x of ex) addTo(exercised, x, t.id);
  return { test: t.id, file: t.file, line: t.line, asserts: t.asserts, assertLines: t.assertLines, mocked: t.mocked,
    direct: t.direct.map(({ to, via, kind, rule, line }) => ({ to, via, kind, rule, line })), exercised: ex.size, exercisedIds: [...ex].sort() };
});
const walkMs = Date.now() - t0;

/* ---------------- write ---------------- */
const nodeIds = new Set(cands.flatMap(c => [...c.ids]));
for (const id of [...direct.keys(), ...exercised.keys()]) nodeIds.add(id);
const symbols = Object.fromEntries([...nodeIds].filter(id => sym.has(id)).sort().map(id => { const s = sym.get(id);
  return [id, { group: s.group, kind: s.kind, file: s.file, start: s.start, end: s.end, module: s.module }]; }));
const brief = c => ({ group: c.group, kind: c.entry.kind, method: c.entry.method, path: c.entry.path, key: c.entry.key, file: c.entry.file, line: c.entry.line,
  continues: parentOf.has(c.entry.id) ? [...parentOf.get(c.entry.id)].sort() : null,
  symbols: c.ids.size, own: c.own.size, folded: c.folded.size, modules: c.modules.size, maxDepth: c.maxDepth });
const G4 = ['prod', 'eval', 'dev', 'test'];
const prodFns = m.symbols.filter(s => s.group === 'prod' && (s.kind === 'function' || s.kind === 'method'));
const allDoubles = new Set(cands.filter(c => c.group === 'prod').flatMap(c => [...c.testDoubles]));
const result = {
  schema: 1, tool: { name: 'propose.mjs' }, root: m.root, commit: m.commit, treeHash: m.treeHash, params,
  totals: {
    entries: m.entries.length, byGroup: Object.fromEntries(G4.map(k => [k, m.entries.filter(e => e.group === k).length])),
    candidates: Object.fromEntries(G4.slice(0, 3).map(k => [k, cands.filter(c => c.group === k).length])),
    topLevel: Object.fromEntries(G4.slice(0, 3).map(k => [k, cands.filter(c => c.group === k && !parentOf.has(c.entry.id)).length])),
    continuations: parentOf.size, helpers: m.symbols.filter(s => W.isHelper(s.id)).length,
    testDoublesRefused: allDoubles.size, tests: testLinks.length,
    prodFunctions: prodFns.length, prodFunctionsDirect: prodFns.filter(s => direct.has(s.id)).length,
    prodFunctionsReached: prodFns.filter(s => direct.has(s.id) || exercised.has(s.id)).length,
  },
  unwalked: unwalked.map(e => ({ id: e.id, group: e.group, file: e.file, line: e.line })),
  candidates: Object.fromEntries(cands.map(c => [c.entry.id, { ...brief(c),
    ownIds: [...c.own],
    nodes: c.order.map(n => ({ id: n.id, depth: n.depth, via: n.via, ctx: n.ctx || undefined, parent: n.parent || undefined, folded: n.folded || undefined })),
    crossings: c.crossings, exercises: c.exercises, dispatch: c.dispatch, branches: c.branches, constructs: [...c.constructs],
    testDoubles: [...c.testDoubles], usesProd: [...c.usesProd], crossGroup: [...c.crossGroup],
    segments: c.segments }])),
  testLinks,
  bySymbol: Object.fromEntries([...new Set([...direct.keys(), ...exercised.keys()])].sort()
    .map(s => [s, { direct: [...(direct.get(s) || [])].sort(), exercised: exercised.get(s)?.size || 0 }])),
  symbols,
};
writeFileSync(join(OUT, 'candidates.json'), JSON.stringify(result, null, 1) + '\n');

const t = result.totals;
console.log(`[propose] ${t.entries} entries ${JSON.stringify(t.byGroup)} walked in ${walkMs} ms · ${t.continuations} continuations · top-level ${JSON.stringify(t.topLevel)}`);
console.log(`[propose] helpers (same-group fan-in >= ${params.fanin}, subtree <= ${params.leafy}) ${t.helpers} · test doubles refused by production walks ${t.testDoublesRefused} · interface folding ${params.ifaceFold ? 'on' : 'off'}`);
console.log(`[propose] tests ${t.tests} · production functions ${t.prodFunctions}: direct test links ${t.prodFunctionsDirect}, reached from tests ${t.prodFunctionsReached}`);
console.log(`[propose] wrote ${relative(process.cwd(), join(OUT, 'candidates.json'))}`);
if (unwalked.length) { console.error(`[propose] ${unwalked.length} entries could not be walked (no such symbol in the code map): ${unwalked.map(e => e.id).join(', ')}`); process.exit(2); }
