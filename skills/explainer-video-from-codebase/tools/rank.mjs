#!/usr/bin/env node
/* =============================================================================
   rank.mjs — order each group's top-level candidates by the new code they cover,
   and print every row with the evidence the agent reads to propose a series.

   Usage:
     node tools/rank.mjs --candidates out/<name>/candidates.json [--out out/<name>]
                         [--explain-top 10] [--explain-top-eval 5]

   Writes ranking.json and ranking.md beside candidates.json (or in --out). Per
   group (prod, eval, dev) the order is greedy marginal coverage of that group's
   own symbols, ties broken by more crossings. There is no cut line and no series:
   each row carries its nearest higher-ranked row with their Jaccard overlap, how
   many of its functions tests pin, which evals exercise it, and its config-
   dependent dispatch points. A second table lists production modules that many
   candidates share and many tests pin, since cross-cutting code has no entry point
   of its own. The merged prod+eval order is evidence only. Dev rows are printed
   and filtered by default.

   Exit: 0 ok · 1 bad flags, unreadable candidates, or --out inside the repo
   ========================================================================== */
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, basename, sep, relative } from 'node:path';
import { renderRanking } from './ranking-md.mjs';

const fail = (code, msg) => { console.error(`[rank] ${msg}`); process.exit(code); };

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
const VALUED = new Set(['--candidates', '--out', '--explain-top', '--explain-top-eval']);
const flags = new Map();
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) { if (argv[i + 1] == null) fail(1, `${argv[i]} needs a value`); flags.set(argv[i], argv[++i]); }
  else fail(1, `unknown argument ${argv[i]}`);
}
if (!flags.has('--candidates')) fail(1, 'usage: rank.mjs --candidates out/<name>/candidates.json [--out out/<name>] [--explain-top 10] [--explain-top-eval 5]');
const count = (flag, d) => { const v = flags.has(flag) ? Number(flags.get(flag)) : d; if (!Number.isInteger(v) || v < 0) fail(1, `${flag} must be a whole number`); return v; };
const params = { explainTop: count('--explain-top', 10), explainTopEval: count('--explain-top-eval', 5) };
const CANDIDATES = resolve(flags.get('--candidates'));
let r;
try { r = JSON.parse(readFileSync(CANDIDATES, 'utf8')); } catch (e) { fail(1, `cannot read ${CANDIDATES}: ${e.message}`); }
if (r.schema !== 1 || !r.candidates || !r.bySymbol) fail(1, `${CANDIDATES} is not a propose.mjs candidates file (schema 1)`);
const OUT = resolve(flags.get('--out') || dirname(CANDIDATES));
const realOut = p => existsSync(p) ? realpathSync(p) : join(realOut(dirname(p)), basename(p));
if (r.root && existsSync(r.root)) { const root = realpathSync(r.root), o = realOut(OUT); if (o === root || o.startsWith(root + sep)) fail(1, `refusing to write inside the repo: ${OUT}`); }

/* ---------------- rank ---------------- */
const cands = Object.entries(r.candidates).map(([id, c]) => ({ id, ...c, own: new Set(c.ownIds) }));
const topLevel = grp => cands.filter(c => c.group === grp && !c.continues);
const pinnedBy = id => r.bySymbol[id]?.direct || [];
const jaccard = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };
const evalPool = topLevel('eval');
const exercisesOf = c => c.exercises.map(x => x.to);

// greedy marginal coverage: repeatedly take the candidate that adds the most not-yet-covered own symbols
function rankPool(pool) {
  const universe = new Set(pool.flatMap(c => [...c.own])), covered = new Set(), ranked = [], left = [...pool];
  while (left.length) {
    let best = null, bestGain = -1;
    for (const c of left) { let gain = 0; for (const s of c.own) if (!covered.has(s)) gain++;
      if (gain > bestGain || (gain === bestGain && c.crossings.length > best.crossings.length)) { best = c; bestGain = gain; } }
    left.splice(left.indexOf(best), 1);
    const newSyms = [...best.own].filter(s => !covered.has(s));
    for (const s of best.own) covered.add(s);
    let near = null, nj = -1;
    for (const x of ranked) { const j = jaccard(best.own, x.c.own); if (j > nj) { nj = j; near = x; } }
    const tests = new Set([...best.own].flatMap(pinnedBy)), testsNew = new Set(newSyms.flatMap(pinnedBy));
    ranked.push({ c: best, gain: bestGain, cumulative: covered.size, nearest: near ? near.c.id : null, jaccard: near ? Number(nj.toFixed(2)) : null,
      pinned: [...best.own].filter(s => pinnedBy(s).length).length, tests: tests.size, testsNew: testsNew.size,
      cfg: best.dispatch.filter(d => (d.collaborator && d.after > 1) || d.selectors).length,
      evals: evalPool.filter(e => e.usesProd.some(s => best.own.has(s)) || exercisesOf(e).some(s => best.own.has(s))).map(e => e.id) });
  }
  return { universe, ranked };
}
const pools = { prod: rankPool(topLevel('prod')), eval: rankPool(evalPool), dev: rankPool(topLevel('dev')) };
const merged = rankPool([...topLevel('prod'), ...evalPool]);   // evidence only: where eval flows would land on one list

// the first-ranked production row whose own code holds a symbol: which flow an eval exercises
const prodRanked = pools.prod.ranked;
const flowRank = id => { const i = prodRanked.findIndex(x => x.c.own.has(id)); return i === -1 ? null : i + 1; };
const row = (x, i, universe) => ({
  rank: i + 1, entry: x.c.id, group: x.c.group, kind: x.c.kind, method: x.c.method, path: x.c.path, key: x.c.key, file: x.c.file, line: x.c.line,
  gain: x.gain, cumulative: x.cumulative, coverage: Number((x.cumulative / (universe.size || 1)).toFixed(3)),
  own: x.c.own.size, folded: x.c.folded, modules: x.c.modules, crossings: x.c.crossings.length, nearest: x.nearest, jaccard: x.jaccard,
  pinned: x.pinned, tests: x.tests, testsNew: x.testsNew, cfg: x.cfg, evals: x.evals,
  ...(x.c.group !== 'prod' ? {
    exercises: [...new Map(x.c.exercises.map(e => [e.to, { to: e.to, kind: e.kind, flowRank: flowRank(e.to) }])).values()],
    usesProd: x.c.usesProd.map(id => ({ id, flowRank: flowRank(id) })) } : {}),
});
const ranked = Object.fromEntries(Object.entries(pools).map(([g, p]) => [g, p.ranked.map((x, i) => row(x, i, p.universe))]));

// shared, heavily tested production code: a module whose functions appear in >= 3 top-level production candidates
// and that >= 5 tests pin directly, listed with the first row that owns it
const sym = r.symbols;
const mods = new Map();
prodRanked.forEach((x, i) => { for (const n of x.c.nodes) { const s = sym[n.id];
  if (!s || s.group !== 'prod' || (s.kind !== 'function' && s.kind !== 'method')) continue;
  const mod = mods.get(s.file) || mods.set(s.file, { cands: new Set(), fns: new Set(), tests: new Set() }).get(s.file);
  mod.cands.add(i + 1); mod.fns.add(n.id); for (const t of pinnedBy(n.id)) mod.tests.add(t); } });
const shared = [...mods].map(([file, x]) => ({ module: file, candidates: x.cands.size, firstOwner: Math.min(...x.cands),
  firstOwnerEntry: prodRanked[Math.min(...x.cands) - 1].c.id, functions: x.fns.size, directTests: x.tests.size }))
  .filter(x => x.candidates >= 3 && x.directTests >= 5)
  .sort((a, b) => b.directTests - a.directTests || b.candidates - a.candidates || (a.module < b.module ? -1 : 1));

const continuations = cands.filter(c => c.continues).map(c => ({ entry: c.id, group: c.group, kind: c.kind, path: c.path, key: c.key, parents: c.continues, own: c.own.size }));
const ranking = {
  schema: 1, tool: { name: 'rank.mjs' }, root: r.root, commit: r.commit, treeHash: r.treeHash, params,
  totals: { topLevel: Object.fromEntries(Object.entries(pools).map(([g, p]) => [g, p.ranked.length])),
    universe: Object.fromEntries(Object.entries(pools).map(([g, p]) => [g, p.universe.size])), continuations: continuations.length },
  ranked,
  merged: merged.ranked.map((x, i) => ({ rank: i + 1, entry: x.c.id, group: x.c.group, gain: x.gain })),
  shared, continuations, testEntries: r.testEntries,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'ranking.json'), JSON.stringify(ranking, null, 1) + '\n');
writeFileSync(join(OUT, 'ranking.md'), renderRanking(ranking, r));

const t = ranking.totals;
console.log(`[rank] top-level ${JSON.stringify(t.topLevel)} · universes ${JSON.stringify(t.universe)} · ${t.continuations} continuations · no cut line`);
console.log(`[rank] merged prod+eval (evidence only): ${ranking.merged.slice(0, 5).map(x => `${x.rank}:${x.entry.split(':').pop()}[${x.group}]`).join(' ')}`);
console.log(`[rank] shared heavily-tested production modules ${shared.length}${shared.length ? `, led by ${shared[0].module} (${shared[0].directTests} direct tests)` : ''}`);
console.log(`[rank] wrote ${relative(process.cwd(), OUT) || '.'}/ranking.{json,md}`);
