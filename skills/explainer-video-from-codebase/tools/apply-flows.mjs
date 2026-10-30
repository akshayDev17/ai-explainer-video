#!/usr/bin/env node
/* =============================================================================
   apply-flows.mjs — validate the agent's series proposal (flows.json) against
   the code map, the candidates and the ranking, and print it for approval.

   Usage:
     node tools/apply-flows.mjs --candidates out/<name>/candidates.json --flows out/<name>/flows.json

   Reads codemap.json and ranking.json beside candidates.json. Writes
   flows.validated.json and flows.md beside flows.json. The checks (design §4.4):
     - every flow, core, hop, segment, variant, skip, promotion, teach target
       and cited test exists;
     - every series item has a reason, and so does every high-ranked row the
       series does not include (C1′: rank <= 10 prod / 5 eval, or the ranking's larger
       --explain-top / --explain-top-eval, or at or above the lowest-ranked row the series includes);
       a glob never explains one;
     - every non-test entry is triaged (C1); eval rows are never implicit;
     - every segment of a kept candidate is kept, mentioned or excluded (C2);
     - every hop is connected to the hops before it (C3) and is a dispatch
       target its receiver and config select; other alternatives are taught;
     - every cited test directly pins its hop and does not mock it (C3′);
     - production flows have no test hops; eval and dev flows do not re-narrate
       production code, they name the production flow they exercise.
   On any problem it writes flows.md with the problems, removes a stale
   flows.validated.json, and exits 2. No series is ever chosen here.

   Exit: 0 ok · 1 bad flags, unreadable or mismatched inputs, or output inside the repo
         · 2 validation problems
   ========================================================================== */
import { readFileSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve, dirname, sep, relative, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { CROSSING } from './lib/walk.mjs';
import { planVideos } from './lib/decompose.mjs';
import { renderFlows } from './flows-md.mjs';

const fail = (code, msg) => { console.error(`[apply-flows] ${msg}`); process.exit(code); };

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
const VALUED = new Set(['--candidates', '--flows']);
const flags = new Map();
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) { if (argv[i + 1] == null) fail(1, `${argv[i]} needs a value`); flags.set(argv[i], argv[++i]); }
  else fail(1, `unknown argument ${argv[i]}`);
}
if (!flags.has('--candidates') || !flags.has('--flows')) fail(1, 'usage: apply-flows.mjs --candidates out/<name>/candidates.json --flows out/<name>/flows.json');
const CANDIDATES = resolve(flags.get('--candidates')), FLOWS = resolve(flags.get('--flows'));
const IN = dirname(CANDIDATES), OUT = dirname(FLOWS);
const readText = (f, what) => { try { return readFileSync(f, 'utf8'); } catch (e) { fail(1, `cannot read ${what} ${f}: ${e.message}`); } };
const readJson = (f, what) => { const t = readText(f, what); try { return { text: t, json: JSON.parse(t) }; } catch (e) { fail(1, `${what} ${f} is not valid JSON: ${e.message}`); } };
const sha = t => createHash('sha256').update(t).digest('hex');
const C = readJson(CANDIDATES, 'the candidates'), M = readJson(join(IN, 'codemap.json'), 'the code map'), K = readJson(join(IN, 'ranking.json'), 'the ranking');
const F = readJson(FLOWS, 'the flows');
const r = C.json, m = M.json, k = K.json, f = F.json;
if (m.schema !== 1 || !Array.isArray(m.symbols)) fail(1, 'codemap.json is not a mine.mjs code map (schema 1)');
if (r.schema !== 1 || !r.candidates) fail(1, `${CANDIDATES} is not a propose.mjs candidates file (schema 1)`);
if (k.schema !== 1 || !k.ranked) fail(1, 'ranking.json is not a rank.mjs ranking (schema 1)');
if (r.treeHash !== m.treeHash || k.treeHash !== m.treeHash) fail(1, 'codemap.json, candidates.json and ranking.json come from different trees: rerun mine, propose and rank');
if (!f || typeof f !== 'object' || Array.isArray(f)) fail(1, `${FLOWS} is not a flows object`);
if (m.root && existsSync(m.root)) { const root = realpathSync(m.root), o = realpathSync(OUT); if (o === root || o.startsWith(root + sep)) fail(1, `refusing to write inside the repo: ${OUT}`); }

/* ---------------- indexes ---------------- */
const MAX_PATH = 4;   // a hop is connected when it is at most 4 calls from a hop before it
const sym = new Map(m.symbols.map(s => [s.id, s]));
const entry = new Map(m.entries.map(e => [e.id, e]));
const testById = new Map((m.tests || []).map(t => [t.id, t]));
const reach = new Map((r.testLinks || []).map(t => [t.test, new Set(t.exercisedIds)]));
const G = id => sym.get(id)?.group || (id.startsWith('ext:') ? 'ext' : null);
const rankOf = new Map();
for (const [grp, rows] of Object.entries(k.ranked)) for (const x of rows) rankOf.set(x.entry, { group: grp, rank: x.rank });
const rankText = id => rankOf.has(id) ? `${rankOf.get(id).group} #${rankOf.get(id).rank}` : null;
const out = new Map(), handedBy = new Map();
for (const e of m.edges) {
  if (e.rule === 'py.callback') (handedBy.get(e.passedBy) || handedBy.set(e.passedBy, []).get(e.passedBy)).push(e);
  else (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e);
}
const configSite = new Map((m.config?.sites || []).map(s => [s.factory, s]));
const fileLines = new Map();
const linesOf = file => { if (!fileLines.has(file)) { let n = null; const p = m.root && join(m.root, file);
  try { if (p && realpathSync(p).startsWith(realpathSync(m.root) + sep)) n = readFileSync(p, 'utf8').split('\n').length; } catch { n = null; }
  fileLines.set(file, n); } return fileLines.get(file); };

const problems = [];
const problem = (where, msg) => problems.push(`${where}: ${msg}`);
const PLACEHOLDER = /(^|[^a-z])(tbd|tba|todo|fixme|xxx|placeholder|lorem)([^a-z]|$)|…|\.\.\.|^<.*>$/i;
// a reason is a sentence fragment someone can argue with: at least three words, not a placeholder
const reasonProblem = (text, what = 'why') => {
  if (typeof text !== 'string' || !text.trim()) return `needs a "${what}"`;
  if (PLACEHOLDER.test(text.trim())) return `"${what}" is a placeholder: "${text.trim()}"`;
  if (text.trim().split(/\s+/).filter(w => /[a-z0-9]/i.test(w)).length < 3) return `"${what}" is too short to be a reason (at least 3 words): "${text.trim()}"`;
  return null;
};
const needReason = (where, text, what) => { const p = reasonProblem(text, what); if (p) problem(where, p); };
const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
const keys = (where, o, allowed) => { for (const x of Object.keys(o)) if (!allowed.includes(x)) problem(where, `unknown field "${x}" (allowed: ${allowed.join(', ')})`); };
const list = (where, x) => { if (x == null) return []; if (!Array.isArray(x)) { problem(where, 'must be a list'); return []; } return x; };
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)+$/;
const titleProblem = t => typeof t !== 'string' || !t.trim() ? 'needs a title' : t.length > 70 ? `title too long (${t.length})` : /\.\.\.|…/.test(t) ? 'title contains an ellipsis'
  : /^part\s+\d+$/i.test(t.trim()) ? 'title is a placeholder' : SLUG_RE.test(t.trim()) ? `title "${t}" is a slug: write a real title` : null;
const globRe = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
const parseLines = (where, text, lo, hi) => {
  if (text == null) return null;
  const ranges = String(text).split(',').map(x => x.trim().match(/^(\d+)(?:-(\d+))?$/));
  if (ranges.some(x => !x)) { problem(where, `lines "${text}" must look like 12-20 or 12-20,31`); return null; }
  const out = ranges.map(x => [Number(x[1]), Number(x[2] || x[1])]);
  for (const [a, b] of out) if (a > b || a < lo || b > hi) problem(where, `lines ${a}-${b} fall outside ${lo}-${hi}`);
  return out;
};

/* ---------------- top level ---------------- */
keys('flows.json', f, ['codemap', 'candidates', 'trace', 'series', 'skipped', 'promote', 'flows', 'cores', 'triage', 'outOfRepo']);
const flows = list('flows', f.flows).filter((x, i) => isObj(x) || problem(`flows[${i}]`, 'must be an object'));
const cores = list('cores', f.cores).filter((x, i) => isObj(x) || problem(`cores[${i}]`, 'must be an object'));
const items = new Map();   // id -> { kind, def }
const ITEM_FIELDS = { flow: ['id', 'title', 'from', 'group', 'hops', 'segments', 'variants', 'teach', 'links'], core: ['id', 'title', 'hops', 'pinnedBy', 'variants', 'teach', 'links'] };
for (const [kind, defs] of [['flow', flows], ['core', cores]]) defs.forEach((d, i) => {
  const hasId = typeof d.id === 'string' && d.id.trim();
  keys(hasId ? `${kind} ${d.id}` : `${kind}s[${i}]`, d, ITEM_FIELDS[kind]);
  if (!hasId) return problem(`${kind}s[${i}]`, 'needs an id');
  if (items.has(d.id)) return problem(`${kind} ${d.id}`, 'id is used twice');
  items.set(d.id, { kind, def: d });
});

// series: the agent's proposal, in video order, each item with a reason
const series = [];
const seriesList = list('series', f.series);
if (!seriesList.length) problem('series', 'is empty: propose at least one flow or core');
seriesList.forEach((s, i) => {
  const where = `series[${i}]`;
  if (!isObj(s)) return problem(where, 'must be an object');
  keys(where, s, ['flow', 'core', 'why']);
  const kind = s.flow != null ? 'flow' : s.core != null ? 'core' : null, id = s.flow ?? s.core;
  if (!kind || (s.flow != null && s.core != null)) return problem(where, 'names exactly one "flow" or "core"');
  const it = items.get(id);
  if (!it || it.kind !== kind) return problem(where, `${kind} "${id}" is not defined in ${kind}s`);
  if (series.some(x => x.id === id)) return problem(where, `${id} is in the series twice`);
  needReason(`series ${id}`, s.why);
  series.push({ kind, id, why: s.why });
});
for (const [id, it] of items) if (!series.some(x => x.id === id)) problem(`${it.kind} ${id}`, 'is defined but not in the series');
const titles = new Map();
for (const [id, it] of items) { const t = it.def.title, p = titleProblem(t);
  if (p) problem(`${it.kind} ${id}`, p); else if (titles.has(t.trim())) problem(`${it.kind} ${id}`, `duplicate title "${t}" (also ${titles.get(t.trim())})`); else titles.set(t.trim(), id); }

/* ---------------- entry decisions: flows, variants, skips, promotions, exclusions ---------------- */
const decided = new Map();   // entry id -> { status, by, why? }
const decide = (where, id, status, extra) => {
  if (decided.has(id)) return problem(where, `${id} is already decided (${decided.get(id).status} in ${decided.get(id).by})`);
  decided.set(id, { status, by: where, ...extra });
};
const realEntry = (where, id) => {
  if (typeof id !== 'string' || !id) { problem(where, 'needs an entry id'); return false; }
  if (/[*?]/.test(id)) { problem(where, `"${id}" is a glob: name one entry (globs belong in triage.excluded)`); return false; }
  const e = entry.get(id);
  if (!e) { problem(where, `${id} is not an entry in the code map`); return false; }
  if (e.group === 'test') { problem(where, `${id} is a test-group entry: tests are evidence, not flows`); return false; }
  if (!r.candidates[id]) { problem(where, `${id} has no candidate`); return false; }
  return true;
};
for (const [id, it] of items) if (it.kind === 'flow' && realEntry(`flow ${id} from`, it.def.from)) {
  decide(`flow ${id}`, it.def.from, 'flow', { flow: id });
  const g = entry.get(it.def.from).group;
  if (it.def.group != null && it.def.group !== g) problem(`flow ${id}`, `says group "${it.def.group}" but its entry ${it.def.from} is in the ${g} group`);
}
const variantsOf = new Map();
for (const [id, it] of items) variantsOf.set(id, list(`${it.kind} ${id} variants`, it.def.variants).flatMap((v, i) => {
  const where = `${it.kind} ${id} variants[${i}]`;
  if (!isObj(v)) { problem(where, 'must be {entry, why}'); return []; }
  keys(where, v, ['entry', 'why']);
  needReason(where, v.why);
  if (!realEntry(where, v.entry)) return [];
  decide(where, v.entry, 'variant', { of: id, why: v.why });
  return [{ entry: v.entry, why: v.why, rank: rankText(v.entry) }];
}));
const skipped = list('skipped', f.skipped).flatMap((s, i) => {
  const where = `skipped[${i}]`;
  if (!isObj(s)) { problem(where, 'must be {entry, rank?, why}'); return []; }
  keys(where, s, ['entry', 'rank', 'why']);
  needReason(`skipped ${s.entry}`, s.why);
  if (!realEntry(where, s.entry)) return [];
  const actual = rankText(s.entry);
  if (s.rank != null && String(s.rank) !== actual) problem(`skipped ${s.entry}`, `says ${s.rank} but ranks ${actual || 'nowhere (not a top-level row)'}`);
  decide(where, s.entry, 'skipped', { why: s.why });
  return [{ entry: s.entry, group: entry.get(s.entry).group, rank: actual, why: s.why }];
});
const promoted = new Set();
const promote = list('promote', f.promote).flatMap((p, i) => {
  const where = `promote[${i}]`;
  if (!isObj(p)) { problem(where, 'must be {entry, why}'); return []; }
  keys(where, p, ['entry', 'why']);
  needReason(`promote ${p.entry}`, p.why);
  if (!realEntry(where, p.entry)) return [];
  if (entry.get(p.entry).group !== 'dev') { problem(`promote ${p.entry}`, `is in the ${entry.get(p.entry).group} group: only dev rows are promoted`); return []; }
  promoted.add(p.entry);
  return [{ entry: p.entry, rank: rankText(p.entry), why: p.why }];
});
if (f.triage != null && !isObj(f.triage)) problem('triage', 'must be {excluded: [...]}');
if (isObj(f.triage)) keys('triage', f.triage, ['excluded']);
const excluded = list('triage.excluded', f.triage?.excluded).flatMap((x, i) => {
  const where = `triage.excluded[${i}]`;
  if (!isObj(x) || typeof x.match !== 'string' || !x.match) { problem(where, 'must be {match, why}'); return []; }
  keys(where, x, ['match', 'why']);
  needReason(`triage.excluded ${x.match}`, x.why);
  return [{ match: x.match, why: x.why, re: globRe(x.match), matched: [] }];
});
const excludedBy = id => excluded.find(x => x.re.test(id));

// out-of-repo claims are checked for shape only and stay unverified; a claim may name the config sites it decides
const outOfRepo = list('outOfRepo', f.outOfRepo).flatMap((x, i) => {
  const where = `outOfRepo[${i}]`;
  if (!isObj(x)) { problem(where, 'must be {claim, evidence, selects?}'); return []; }
  keys(where, x, ['claim', 'evidence', 'selects']);
  needReason(where, x.claim, 'claim');
  if (typeof x.evidence !== 'string' || !x.evidence.trim()) problem(where, 'needs "evidence" (where the claim can be checked)');
  return [{ claim: x.claim, evidence: x.evidence, selects: list(`${where} selects`, x.selects), verified: false }];
});

/* ---------------- hops: existence, groups, lines, citations ---------------- */
const flowFroms = new Map([...items].filter(([, it]) => it.kind === 'flow' && entry.has(it.def.from)).map(([id, it]) => [it.def.from, id]));
const itemGroup = (id, it) => it.kind === 'flow' ? entry.get(it.def.from)?.group : null;
const CITATION_FIELDS = ['test', 'say', 'lines', 'strength'];
const citation = (where, hopSym, c, fields = CITATION_FIELDS) => {
  if (!isObj(c)) { problem(where, 'a citation is {test, say, lines?, strength?}'); return null; }
  keys(where, c, fields);
  needReason(`${where} ${c.test}`, c.say, 'say');
  const t = testById.get(c.test);
  if (!t) { problem(where, `test ${c.test} is not in the code map`); return null; }
  if (c.strength != null && c.strength !== 'direct' && c.strength !== 'reachable') problem(where, `strength must be "direct" or "reachable", not "${c.strength}"`);
  const strength = c.strength === 'reachable' ? 'reachable' : 'direct';
  const link = t.direct.find(l => l.to === hopSym);
  if (t.mocked.includes(hopSym)) problem(where, `test ${c.test} mocks ${hopSym}: a test that replaces a hop cannot pin it`);
  else if (strength === 'direct' && !link) problem(where, `test ${c.test} has no direct link to ${hopSym}${reach.get(c.test)?.has(hopSym) ? ' (it only reaches it: cite it with "strength": "reachable", which narration may not call tested)' : ''}`);
  else if (strength === 'reachable' && !link && !reach.get(c.test)?.has(hopSym)) problem(where, `test ${c.test} does not reach ${hopSym}`);
  const lines = parseLines(`${where} ${c.test}`, c.lines, t.line, t.end);
  return { test: c.test, file: t.file, line: t.line, end: t.end, asserts: t.asserts, assertLines: t.assertLines, lines, say: c.say,
    strength, via: link?.via || null, observed: null };
};
function readHops(it, id) {
  const where = `${it.kind} ${id}`, grp = itemGroup(id, it);
  const raw = list(`${where} hops`, it.def.hops);
  if (!raw.length) problem(where, 'has no hops');
  const seen = new Set();
  return raw.flatMap((h0, i) => {
    const h = typeof h0 === 'string' ? { symbol: h0 } : h0, at = `${where} hop ${i + 1}`;
    if (!isObj(h) || typeof h.symbol !== 'string') { problem(at, 'must be a symbol id or {symbol, …}'); return []; }
    keys(at, h, ['symbol', 'lines', 'pinnedBy', 'exercises', 'uses', 'break']);
    const s = sym.get(h.symbol);
    if (!s) { problem(at, `${h.symbol} is not a symbol in the code map`); return []; }
    if (seen.has(h.symbol)) problem(at, `${h.symbol} is already a hop of this ${it.kind}`);
    seen.add(h.symbol);
    if (s.group === 'test') problem(at, `${h.symbol} is test-group code: tests are cited with pinnedBy, never narrated as hops`);
    else if ((grp === 'eval' || grp === 'dev') && s.group === 'prod') problem(at, `${h.symbol} is production code: an ${grp} flow names the production flow it drives with "exercises" on its own hop instead of re-narrating it`);
    if (h.break != null && typeof h.break !== 'boolean') problem(at, '"break" is true or false');
    return [{ index: i + 1, symbol: h.symbol, name: h.symbol.split(':').slice(1).join(':'), group: s.group, kind: s.kind, file: s.file, start: s.start, end: s.end, sha256: s.sha256,
      lines: parseLines(at, h.lines, s.start, s.end), break: h.break === true, uses: h.uses ?? null, exercises: h.exercises ?? null,
      pinnedBy: list(`${at} pinnedBy`, h.pinnedBy).map((c, j) => citation(`${at} pinnedBy[${j}]`, h.symbol, c)).filter(Boolean) }];
  });
}
const hopsOf = new Map([...items].map(([id, it]) => [id, readHops(it, id)]));
for (const [id, it] of items) if (it.kind === 'core') list(`core ${id} pinnedBy`, it.def.pinnedBy).forEach((c, j) => {
  const where = `core ${id} pinnedBy[${j}]`, hop = isObj(c) && hopsOf.get(id).find(h => h.symbol === c.symbol);
  if (!hop) return problem(where, `${isObj(c) ? c.symbol : c} is not a hop of this core`);
  const x = citation(where, c.symbol, c, ['symbol', ...CITATION_FIELDS]); if (x) hop.pinnedBy.push(x);
});

/* ---------------- connectivity (C3) and dispatch consistency ---------------- */
// the walk trees an item's hops may follow: a flow's own candidate and its variants'; a core's variants' and every
// series flow's (a core is code the flows share)
const treeOf = new Map();
const tree = cid => { if (!treeOf.has(cid)) { const parents = new Map(), children = new Map(), down = new Map(), ids = new Set();
  const add = (m2, a, b) => (m2.get(a) || m2.set(a, new Set()).get(a)).add(b);
  for (const n of r.candidates[cid]?.nodes || []) { ids.add(n.id); if (n.parent) { add(children, n.parent, n.id); add(parents, n.id, n.parent);
    const kk = `${n.parent}>${n.id}`; if (!down.has(kk)) down.set(kk, n.via); } }
  treeOf.set(cid, { id: cid, parents, children, down, ids, nodes: r.candidates[cid]?.nodes || [] }); } return treeOf.get(cid); };
const treesFor = (id, it) => {
  const vs = (variantsOf.get(id) || []).map(v => v.entry);
  const own = it.kind === 'flow' ? [it.def.from] : [...flowFroms.keys()];
  return [...new Set([...own, ...vs])].filter(c => r.candidates[c]).map(tree);
};
// the shortest walk-tree path between two hops, at most MAX_PATH steps: back up the call stack (returns), then down
// (calls). Never down then up: two callers of one shared callee are not connected through it
const treePath = (t, a, b) => {
  if (!t.ids.has(a) || !t.ids.has(b)) return null;
  const key = (id, dn) => `${dn ? 'v' : '^'}${id}`;
  const prev = new Map([[key(a, false), null]]); let frontier = [[a, false]], hit = null;
  for (let d = 0; d < MAX_PATH && frontier.length && !hit; d++) { const next = [];
    for (const [x, dn] of frontier) {
      const moves = [...(dn ? [] : [...(t.parents.get(x) || [])].map(y => [y, false])), ...[...(t.children.get(x) || [])].map(y => [y, true])];
      for (const [y, ydn] of moves) { const k = key(y, ydn); if (prev.has(k)) continue; prev.set(k, key(x, dn)); next.push([y, ydn]); if (y === b && !hit) hit = k; }
    }
    frontier = next; }
  if (!hit) return null;
  const keys = []; for (let k = hit; k != null; k = prev.get(k)) keys.unshift(k);
  const path = keys.map(k => k.slice(1));
  const steps = path.slice(1).map((y, i) => keys[i + 1][0] === 'v' ? { from: path[i], to: y, kind: t.down.get(`${path[i]}>${y}`), down: true } : { from: path[i], to: y, kind: 'return', down: false });
  return { how: 'candidate', candidate: t.id, path, steps };
};
// the shortest directed path over recorded edges of any kind, never into test code; a callback runs where it was handed over
const edgePath = (a, b) => {
  const prev = new Map([[a, null]]); let frontier = [a];
  for (let d = 0; d < MAX_PATH && frontier.length && !prev.has(b); d++) { const next = [];
    for (const x of frontier) {
      const es = [...(out.get(x) || []), ...(handedBy.get(x) || [])];
      for (const e of es) if (!prev.has(e.to) && G(e.to) !== 'test') { prev.set(e.to, { x, e }); next.push(e.to); }
    }
    frontier = next; }
  if (!prev.has(b)) return null;
  const steps = []; for (let y = b; prev.get(y); y = prev.get(y).x) { const { x, e } = prev.get(y);
    steps.unshift({ from: x, to: y, kind: e.kind, rule: e.rule || null, evidence: e.evidence || (e.line != null ? `${sym.get(x)?.file}:${e.line}` : null), site: e.site || null, down: true }); }
  return { how: 'edges', path: [a, ...steps.map(s => s.to)], steps };
};
const linksOf = new Map([...items].map(([id, it]) => [id, list(`${it.kind} ${id} links`, it.def.links).flatMap((l, i) => {
  const where = `${it.kind} ${id} links[${i}]`;
  if (!isObj(l)) { problem(where, 'must be {from, to, kind, evidence}'); return []; }
  keys(where, l, ['from', 'to', 'kind', 'evidence']);
  let ok = true;
  for (const e of ['from', 'to']) if (!sym.has(l[e])) { problem(where, `${e} ${l[e]} is not a symbol in the code map`); ok = false; }
  if (typeof l.kind !== 'string' || !l.kind) { problem(where, 'needs a kind (spawn, http, queue, static, …)'); ok = false; }
  const ev = typeof l.evidence === 'string' && l.evidence.match(/^([^\s:]+):(\d+)(?:-(\d+))?/);
  if (!ev) { problem(where, 'evidence must start with file:line or file:a-b in the repo'); ok = false; }
  else { const n = linesOf(ev[1]), a = Number(ev[2]), b = Number(ev[3] || ev[2]);
    if (n == null) { problem(where, `evidence names ${ev[1]}, which is not a file in the repo`); ok = false; }
    else if (a > b || b > n) { problem(where, `evidence ${ev[1]}:${a}-${b} is past the end of the file (${n} lines)`); ok = false; } }
  return ok ? [{ from: l.from, to: l.to, kind: l.kind, evidence: l.evidence }] : [];
})]));
// a hop on a config alternative that no profile selects is a branch to teach, not the story
const unselected = (hop, trees) => {
  for (const t of trees) for (const d of r.candidates[t.id].dispatch || []) {
    if (!d.targets.includes(hop.symbol) || !d.config || !d.narrowedBy) continue;
    const site = configSite.get(d.narrowedBy), cls = sym.get(hop.symbol)?.cls;
    const alt = site?.alternatives.find(a => a.cls === cls || a.cls === hop.symbol);
    if (!alt || !Object.keys(alt.sel || {}).length || !Object.values(alt.sel).every(v => v === 'no')) continue;
    const claim = outOfRepo.find(o => o.selects.includes(d.narrowedBy));
    if (claim) { hop.selectedBy = { outOfRepo: claim.claim, verified: false }; continue; }
    return `${hop.symbol} is the ${alt.cls.split(':').pop()} alternative at ${d.site}, which no profile selects (${Object.entries(site.decidedByProfile || {}).map(([p, c]) => `${p} → ${String(c).split(':').pop()}`).join(', ')}): teach it instead, or name ${d.narrowedBy} in the "selects" of an outOfRepo claim`;
  }
  return null;
};
for (const [id, it] of items) {
  const hops = hopsOf.get(id), trees = treesFor(id, it), links = linksOf.get(id), where = `${it.kind} ${id}`;
  const restart = new Set([...(it.kind === 'flow' ? [it.def.from] : []), ...(variantsOf.get(id) || []).map(v => v.entry)]);
  let chainStart = 0;
  hops.forEach((h, i) => {
    if (i === 0) { h.connection = { how: it.kind === 'flow' ? 'entry' : 'start', path: [h.symbol], steps: [] };
      if (it.kind === 'flow' && h.symbol !== it.def.from) problem(`${where} hop 1`, `a flow opens on its entry: the first hop must be ${it.def.from}, not ${h.symbol}`);
      return; }
    if (restart.has(h.symbol)) { h.connection = { how: 'variant', path: [h.symbol], steps: [] }; chainStart = i; return; }
    // from the previous hop, else (returning up the narrated stack) the nearest earlier hop that connects; shortest first
    let found = null;
    for (let j = i - 1; j >= chainStart && !found; j--) {
      const a = hops[j].symbol, l = links.find(x => x.from === a && x.to === h.symbol);
      for (const c of [...trees.map(t => treePath(t, a, h.symbol)), edgePath(a, h.symbol),
        l && { how: 'link', path: [a, h.symbol], steps: [{ from: a, to: h.symbol, kind: l.kind, evidence: l.evidence, down: true, declared: true }] }])
        if (c && (!found || c.steps.length < found.steps.length)) found = c;
    }
    if (!found) return problem(`${where}`, `hop ${i}→${i + 1} not connected: ${h.symbol} is not within ${MAX_PATH} calls of ${hops[i - 1].symbol} or an earlier hop (candidate walk, recorded edges or a declared link)`);
    h.connection = found;
    const alt = unselected(h, trees);
    if (alt) problem(`${where} hop ${i + 1}`, alt);
    else if (found.how === 'edges' && found.steps.some(s => s.kind === 'virtual' || s.kind === 'dispatch') && !trees.some(t => t.ids.has(h.symbol)))
      problem(`${where} hop ${i + 1}`, `${h.symbol} is reached only through a dispatch the walk's receiver does not select (${found.steps.find(s => s.kind === 'virtual' || s.kind === 'dispatch').site || 'CHA'}): teach it instead`);
  });
  for (const h of hops) h.crossing = !!h.exercises || (h.connection?.steps || []).some(s => s.down && CROSSING.has(s.kind));
}

/* ---------------- uses, exercises, teach, segments ---------------- */
for (const [id, it] of items) for (const h of hopsOf.get(id)) {
  const at = `${it.kind} ${id} hop ${h.index}`;
  if (h.uses != null && items.get(h.uses)?.kind !== 'core') problem(at, `uses "${h.uses}", which is not a core in this file`);
  if (h.exercises == null) continue;
  const grp = itemGroup(id, it), target = items.get(h.exercises);
  if (grp !== 'eval' && grp !== 'dev') { problem(at, '"exercises" marks the hop of an eval or dev flow that drives a production flow'); continue; }
  if (!target || itemGroup(h.exercises, target) !== 'prod') { problem(at, `exercises "${h.exercises}", which is not a production flow in this file`); continue; }
  const code = new Set([target.def.from, ...(variantsOf.get(h.exercises) || []).map(v => v.entry)].flatMap(c => [...(r.candidates[c]?.ownIds || []), c]));
  for (const x of hopsOf.get(h.exercises)) code.add(x.symbol);
  // how it drives it: the walk's crossing, else a declared link, else a direct call folded as a uses-prod leaf
  const c = r.candidates[it.def.from];
  const cross = (c?.crossings || []).find(x => x.from === h.symbol && code.has(x.to));
  const link = linksOf.get(id).find(l => l.from === h.symbol && code.has(l.to));
  const call = (c?.nodes || []).find(n => n.parent === h.symbol && n.folded === 'uses-prod' && code.has(n.id));
  h.drive = cross ? { kind: cross.kind, to: cross.to, evidence: cross.evidence || null } : link ? { kind: link.kind, to: link.to, evidence: link.evidence }
    : call ? { kind: 'call', to: call.id, evidence: null } : null;
  if (!h.drive) problem(at, `${h.symbol} exercises ${h.exercises}, but it calls none of that flow's code`);
}
const usesGraph = new Map([...items].filter(([, it]) => it.kind === 'core').map(([id]) => [id, hopsOf.get(id).map(h => h.uses).filter(u => items.get(u)?.kind === 'core')]));
const cycle = (id, stack = []) => stack.includes(id) ? [...stack, id] : (usesGraph.get(id) || []).map(u => cycle(u, [...stack, id])).find(Boolean) || null;
for (const id of usesGraph.keys()) { const c = cycle(id); if (c && c[0] === id) problem(`core ${id}`, `uses itself through ${c.join(' → ')}`); }

// a taught branch is narrated with the hop that holds its point: the hop itself, else its nearest narrated ancestor
// in the walk, else the opening hop
const teachHop = (id, it, points) => {
  const hops = hopsOf.get(id), at = new Map(hops.map(h => [h.symbol, h.index]));
  for (const p of points) if (at.has(p)) return at.get(p);
  for (const t of treesFor(id, it)) for (const n of t.nodes) if (points.includes(n.id)) {
    const byId = new Map(t.nodes.map(x => [x.id, x]));
    for (let x = byId.get(n.parent), seen = new Set(); x && !seen.has(x.id); seen.add(x.id), x = byId.get(x.parent)) if (at.has(x.id)) return at.get(x.id);
  }
  return hops[0]?.index ?? 1;
};
const guardEdges = new Map();
for (const e of m.edges) if (e.cfg) guardEdges.set(`${e.from}@${e.line}`, e);
const teachOf = new Map([...items].map(([id, it]) => [id, list(`${it.kind} ${id} teach`, it.def.teach).flatMap((t, i) => {
  const where = `${it.kind} ${id} teach[${i}]`, hops = hopsOf.get(id);
  if (!isObj(t)) { problem(where, 'must be {dispatch|guard, say}'); return []; }
  keys(where, t, ['dispatch', 'guard', 'say']);
  needReason(where, t.say, 'say');
  let target = null, at = null, alternatives = null;
  if (t.dispatch != null) {
    const site = configSite.get(t.dispatch) || (m.factories?.[t.dispatch] && { factory: t.dispatch });
    const ds = (m.dispatchSites || []).find(d => d.site === t.dispatch) || Object.values(r.candidates).flatMap(c => c.dispatch).find(d => d.site === t.dispatch);
    if (!site && !ds) { problem(where, `${t.dispatch} is not a recorded dispatch point (a config site, a factory or a dispatch site)`); return []; }
    target = site ? t.dispatch : t.dispatch.split('@')[0]; at = site ? t.dispatch : ds.from || target;
    alternatives = site && configSite.get(t.dispatch) ? configSite.get(t.dispatch).alternatives.map(a => ({ cls: a.cls, guards: a.guards, sel: a.sel })) : ds?.targets || null;
  } else if (t.guard != null) {
    const g = guardEdges.get(t.guard);
    if (!g) { problem(where, `${t.guard} is not a recorded config guard (<symbol>@<line> of a call under a config read)`); return []; }
    target = g.to; at = g.from; alternatives = [{ to: g.to, guards: g.cfg }];
  } else { problem(where, 'names a "dispatch" point or a "guard"'); return []; }
  return [{ ...(t.dispatch != null ? { dispatch: t.dispatch } : { guard: t.guard }), say: t.say, hop: teachHop(id, it, t.guard != null ? [target, at] : [at, target]), alternatives }];
})]));

const segmentsOf = new Map();
for (const [id, it] of items) {
  if (it.kind !== 'flow' || !r.candidates[it.def.from]) continue;
  const where = `flow ${id} segments`, c = r.candidates[it.def.from], s = it.def.segments ?? {};
  if (!isObj(s)) { problem(where, 'must be {keep, mention, exclude}'); continue; }
  keys(where, s, ['keep', 'mention', 'exclude']);
  const roots = new Map(c.segments.map(x => [x.root, x]));
  const decision = new Map([[it.def.from, { decision: 'entry' }]]);
  const set = (root, d, at) => {
    if (!roots.has(root)) return problem(at, `${root} is not a segment of ${it.def.from} (segments: ${[...roots.keys()].join(', ')})`);
    if (decision.has(root)) return problem(at, `${root} is already ${decision.get(root).decision}`);
    decision.set(root, d);
  };
  list(`${where}.keep`, s.keep).forEach((x, i) => set(x, { decision: 'keep' }, `${where}.keep[${i}]`));
  list(`${where}.mention`, s.mention).forEach((x, i) => { const at = `${where}.mention[${i}]`;
    if (!isObj(x)) return problem(at, 'must be {root, say}'); keys(at, x, ['root', 'say']); needReason(`${at} ${x.root}`, x.say, 'say'); set(x.root, { decision: 'mention', say: x.say }, at); });
  list(`${where}.exclude`, s.exclude).forEach((x, i) => { const at = `${where}.exclude[${i}]`;
    if (!isObj(x)) return problem(at, 'must be {root, why}'); keys(at, x, ['root', 'why']); needReason(`${at} ${x.root}`, x.why); set(x.root, { decision: 'exclude', why: x.why }, at); });
  for (const root of roots.keys()) if (!decision.has(root)) {
    const rule = excludedBy(root);
    if (rule) { rule.matched.push(root); decision.set(root, { decision: 'exclude', why: rule.why, rule: rule.match }); }
    else problem(`flow ${id}`, `segment ${root} (reached from ${roots.get(root).from} by ${roots.get(root).kind}) is untriaged: keep it, mention it with a "say", or exclude it with a "why"`);
  }
  segmentsOf.set(id, c.segments.map(x => ({ root: x.root, from: x.from, kind: x.kind || null, own: x.own, folded: x.folded, ...(decision.get(x.root) || { decision: null }) })));
}

/* ---------------- entry triage (C1) and high-ranked rows (C1′) ---------------- */
const nonTest = m.entries.filter(e => e.group !== 'test');
const triage = nonTest.map(e => {
  const d = decided.get(e.id), c = r.candidates[e.id], parents = (c?.continues || []).filter(p => flowFroms.has(p));
  const rule = excludedBy(e.id);
  let status = null, reason = null, by = null;
  if (d?.status === 'flow') { status = 'flow'; by = d.flow; }
  else if (parents.length) { status = 'continuation'; by = parents.map(p => flowFroms.get(p)).join(', '); }
  else if (d) { status = d.status; reason = d.why; by = d.of || null; }
  else if (rule) { status = 'excluded'; reason = rule.why; by = rule.match; }
  else if (e.group === 'dev' && !promoted.has(e.id) && c?.continues?.length) { status = 'continuation'; by = c.continues.join(', '); reason = 'continues a dev row, filtered with it'; }
  else if (e.group === 'dev' && !promoted.has(e.id)) status = 'dev-filtered';
  if (rule && status === 'excluded') rule.matched.push(e.id);
  return { id: e.id, group: e.group, kind: e.kind, route: e.path ? [e.method, e.path].filter(Boolean).join(' ') : e.key || null, rank: rankOf.get(e.id)?.rank ?? null,
    continues: c?.continues || null, promoted: promoted.has(e.id), status, reason, by };
});
for (const t of triage) if (!t.status) problem(`entry ${t.id}`, `(${t.group}${t.rank ? ` #${t.rank}` : ''}) is untriaged: make it a flow, a variant, skip it with a reason, or exclude it with a reason${t.group === 'eval' ? ' (eval rows are never triaged implicitly)' : t.promoted ? ' (it is promoted)' : ''}`);
for (const x of excluded) if (!x.matched.length) problem(`triage.excluded ${x.match}`, 'matches no entry or segment');

const K_OF = { prod: Math.max(10, k.params.explainTop), eval: Math.max(5, k.params.explainTopEval), dev: 0 };
const highRanked = Object.fromEntries(Object.entries(k.ranked).map(([grp, rows]) => {
  const included = rows.filter(x => flowFroms.has(x.entry)).map(x => x.rank);
  const lowest = included.length ? Math.max(...included) : 0;
  const high = rows.filter(x => x.rank <= K_OF[grp] || x.rank <= lowest).map(x => {
    const d = decided.get(x.entry);
    const status = d ? d.status : null;
    if (!d) problem(`${grp} #${x.rank} ${x.entry}`, `is a high-ranked row (rank <= ${K_OF[grp]}${lowest > K_OF[grp] ? ` or at or above #${lowest}, the lowest-ranked row the series includes` : ''}) and is unexplained: include it, list it as a variant, or skip it with a reason${excludedBy(x.entry) ? ' (an excluded glob does not explain a high-ranked row)' : ''}`);
    return { rank: x.rank, entry: x.entry, status, why: d?.why || null };
  });
  const n = s => high.filter(x => x.status === s).length;
  return [grp, { k: K_OF[grp], lowestIncluded: lowest || null, rows: high, summary: { highRanked: high.length, series: n('flow'), variant: n('variant'), skipped: n('skipped'), unexplained: n(null) } }];
}));

/* ---------------- test configuration ---------------- */
const autouse = new Set((m.fixtures || []).filter(x => x.autouse).map(x => x.id));
const tests = {
  sessionMocks: (m.mocks || []).filter(x => x.scope === 'session').map(x => ({ target: x.target || x.raw, conftest: x.conftest, line: x.line })),
  autouseMocks: (m.mocks || []).filter(x => autouse.has(x.fn)).map(x => ({ target: x.target || x.raw, fixture: x.fn, line: x.line })),
};

/* ---------------- write ---------------- */
const itemOut = (id, it) => {
  const g = it.kind === 'flow' ? itemGroup(id, it) : [...new Set(hopsOf.get(id).map(h => h.group))].sort().join('+') || null;
  const s = series.find(x => x.id === id);
  const e = it.kind === 'flow' ? entry.get(it.def.from) : null;
  return { id, kind: it.kind, title: it.def.title, group: g, why: s?.why ?? null,
    ...(e ? { from: e.id, rank: rankText(e.id), entry: { kind: e.kind, method: e.method, path: e.path, key: e.key, file: e.file, line: e.line } } : {}),
    hops: hopsOf.get(id), segments: segmentsOf.get(id) || [], variants: variantsOf.get(id) || [], teach: teachOf.get(id) || [], links: linksOf.get(id) || [] };
};
const validated = {
  schema: 1, tool: { name: 'apply-flows.mjs' }, ok: problems.length === 0, root: m.root, commit: m.commit, treeHash: m.treeHash,
  inputs: { flows: { file: basename(FLOWS), sha256: sha(F.text) }, candidates: { file: relative(OUT, CANDIDATES), sha256: sha(C.text) },
    codemap: { file: relative(OUT, join(IN, 'codemap.json')), sha256: sha(M.text) }, ranking: { file: relative(OUT, join(IN, 'ranking.json')), sha256: sha(K.text) } },
  params: { explainTop: K_OF.prod, explainTopEval: K_OF.eval, maxPath: MAX_PATH },
  series: series.map(s => { const it = items.get(s.id); return { kind: s.kind, id: s.id, title: it.def.title, why: s.why, rank: it.kind === 'flow' ? rankText(it.def.from) : null }; }),
  flows: [...items].filter(([, it]) => it.kind === 'flow').map(([id, it]) => itemOut(id, it)),
  cores: [...items].filter(([, it]) => it.kind === 'core').map(([id, it]) => itemOut(id, it)),
  skipped, promote, excluded: excluded.map(({ match, why, matched }) => ({ match, why, matched })),
  triage: { entries: triage, testGroupEntries: m.entries.filter(e => e.group === 'test').map(e => e.id), highRanked },
  outOfRepo, tests,
};
const estimate = problems.length ? null : planVideos(validated, {});
writeFileSync(join(OUT, 'flows.md'), renderFlows(validated, problems, estimate, r));
const VALIDATED = join(OUT, 'flows.validated.json');
const byGroup = grp => triage.filter(t => t.group === grp);
const count = (xs, s) => xs.filter(t => t.status === s).length;
const hopsAll = [...hopsOf.values()].flat(), cited = hopsAll.flatMap(h => h.pinnedBy);
for (const [grp, h] of Object.entries(highRanked)) if (h.rows.length) console.log(`[apply-flows] ${grp}: ${h.summary.highRanked} high-ranked · ${h.summary.series} in series · ${h.summary.variant} variant · ${h.summary.skipped} skipped · ${h.summary.unexplained} unexplained`);
console.log(`[apply-flows] ${m.entries.length} entries · prod ${byGroup('prod').length} · eval ${byGroup('eval').length} · dev ${byGroup('dev').length} (${count(byGroup('dev'), 'dev-filtered')} filtered, ${count(byGroup('dev'), 'continuation')} continuations) · ${triage.filter(t => !t.status).length} untriaged · test-group entries: ${validated.triage.testGroupEntries.length} (listed)`);
const segs = [...segmentsOf.values()].flat().filter(x => x.decision !== 'entry');
const decisions = d => segs.filter(x => x.decision === d).length;
console.log(`[apply-flows] segments of kept candidates ${segs.length}: ${decisions('keep')} kept · ${decisions('mention')} mentioned · ${decisions('exclude')} excluded`);
console.log(`[apply-flows] series ${series.length} (${series.filter(s => s.kind === 'flow').length} flows, ${series.filter(s => s.kind === 'core').length} cores) · ${hopsAll.length} hops · ${hopsAll.filter(h => h.crossing).length} crossings · ${cited.length} cited tests (${cited.filter(c => c.strength === 'reachable').length} reachable only)`);
if (problems.length) {
  if (existsSync(VALIDATED)) rmSync(VALIDATED);
  console.error(`[apply-flows] ${problems.length} problem(s); flows.validated.json not written:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.log(`[apply-flows] wrote ${relative(process.cwd(), join(OUT, 'flows.md'))}`);
  process.exit(2);
}
writeFileSync(VALIDATED, JSON.stringify(validated, null, 1) + '\n');
console.log(`[apply-flows] estimate: ${estimate.videos.length} videos, ${estimate.totals.seriesMinutes} min, longest ${estimate.totals.longestVideoMin} min (cap ${estimate.totals.capMinutes})`);
console.log(`[apply-flows] 0 problems · wrote ${relative(process.cwd(), OUT) || '.'}/flows.{validated.json,md}: show the user the approval table in flows.md before approve-flows`);
