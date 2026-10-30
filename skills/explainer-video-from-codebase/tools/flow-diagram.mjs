#!/usr/bin/env node
/* =============================================================================
   flow-diagram.mjs — the skeleton of a flow's diagram, generated from the
   validated flows, so its boxes and arrows are the code's and not a guess.

   Usage:
     node tools/flow-diagram.mjs --flows out/<name>/flows.validated.json --as map [--flow <id>]
     node tools/flow-diagram.mjs --flows out/<name>/flows.validated.json --flow <id> --as sequence
     node tools/flow-diagram.mjs --flows out/<name>/flows.validated.json --flow <id> --as exercises

   Prints JSON (design §4.6); the agent adds the layout polish and the beats:
     map        a `diagram` host config: one box per module the hops run through
                (every series item, or one with --flow), its hops as members, an
                arrow per call between modules; `crossings` lists the queue, HTTP
                and spawn hand-offs with their evidence (for banners).
     sequence   `svg` lane params for SceneCore.primitives.sequence: the caller
                (the entry's route, queue key or command) and each module as a
                participant, one message per hop, kind call / queue / http / spawn.
     exercises  a `diagram` host config for an eval or dev flow: its hops as the
                harness lane on the left, each production flow it drives as one
                named box with its video number ("see video 8"), and the crossing
                between them; the production flow is never re-drawn.

   The video number comes from plan.json beside the validated flows when it was
   planned from this exact file, else from the same planner at the default cap.

   Exit: 0 ok · 1 bad flags, unreadable inputs, an unknown flow, or exercises on a
         flow with no `exercises` hop
   ========================================================================== */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { planVideos } from './lib/decompose.mjs';

const fail = (code, msg) => { console.error(`[flow-diagram] ${msg}`); process.exit(code); };

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
const VALUED = new Set(['--flows', '--flow', '--as']);
const flags = new Map();
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) { if (argv[i + 1] == null) fail(1, `${argv[i]} needs a value`); flags.set(argv[i], argv[++i]); }
  else fail(1, `unknown argument ${argv[i]}`);
}
const AS = flags.get('--as');
if (!flags.has('--flows') || !['map', 'sequence', 'exercises'].includes(AS)) fail(1, 'usage: flow-diagram.mjs --flows out/<name>/flows.validated.json --as map|sequence|exercises [--flow <id>]');
if (AS !== 'map' && !flags.has('--flow')) fail(1, `--as ${AS} draws one flow: pass --flow <id>`);
const VALIDATED = resolve(flags.get('--flows')), OUT = dirname(VALIDATED);
const sha = t => createHash('sha256').update(t).digest('hex');
const readText = (f, what) => { try { return readFileSync(f, 'utf8'); } catch (e) { fail(1, `cannot read ${what} ${f}: ${e.message}`); } };
const text = readText(VALIDATED, 'the validated flows');
let v;
try { v = JSON.parse(text); } catch (e) { fail(1, `${VALIDATED} is not valid JSON: ${e.message}`); }
if (v?.schema !== 1 || v.tool?.name !== 'apply-flows.mjs' || v.ok !== true) fail(1, `${VALIDATED} is not a passing apply-flows.mjs output (schema 1)`);
const items = new Map([...v.flows, ...v.cores].map(x => [x.id, x]));
const one = flags.get('--flow');
if (one != null && !items.has(one)) fail(1, `no flow or core "${one}" in ${VALIDATED} (have: ${[...items.keys()].join(', ')})`);

const moduleOf = sym => sym.split(':')[0];
// `pkg.mod.leaf` -> `mod.leaf`; a TS/JS module (a path) -> its last two path parts
const shortName = mod => mod.includes('/') ? mod.split('/').slice(-2).join('/') : mod.split('.').slice(-2).join('.');
const COLOR = { queue: 'hub', http: 'ok', spawn: 'bad' };
const CROSS = new Set(Object.keys(COLOR));
// the call that brings a hop in: the first downward step of its connection (the walk returns up, then calls down)
const callIn = h => (h.connection?.steps || []).find(s => s.down) || null;
const crossKind = h => (h.connection?.steps || []).find(s => s.down && CROSS.has(s.kind))?.kind || null;

// the video a flow is narrated in: plan.json when planned from this file, else the planner at its default cap
function videoOf(id) {
  const planPath = join(OUT, 'plan.json');
  if (existsSync(planPath)) {
    const plan = JSON.parse(readText(planPath, 'the plan'));
    if (plan.inputs?.validated?.sha256 === sha(text)) return { video: plan.videos.find(x => x.group === id)?.index ?? null, videoFrom: 'plan.json' };
  }
  return { video: planVideos(v, {}).videos.find(x => x.group === id)?.index ?? null, videoFrom: 'estimate (no plan.json from this file)' };
}

// n row positions from top to bottom, one centred row when n is 1
const spread = (n, top, bottom) => Array.from({ length: n }, (_, r) => Math.round(n === 1 ? (top + bottom) / 2 : top + r * (bottom - top) / (n - 1)));
// a grid the agent will re-lay: three columns, rows as needed
const grid = n => {
  const cols = Math.min(3, Math.max(1, n)), rows = Math.ceil(n / cols);
  const xs = cols === 1 ? [960] : cols === 2 ? [600, 1320] : [340, 960, 1580];
  return { columns: Object.fromEntries(xs.map((x, i) => [`c${i}`, { x }])), rows: spread(rows, 260, 940), at: i => ({ column: `c${i % cols}`, row: Math.floor(i / cols) }) };
};

/* ---------------- map ---------------- */
function map() {
  const chosen = one ? [items.get(one)] : v.series.map(s => items.get(s.id));
  const mods = new Map();   // module -> { hops, group }
  const add = h => { const m = moduleOf(h.symbol); if (!mods.has(m)) mods.set(m, { hops: [], group: h.group }); if (!mods.get(m).hops.includes(h.name)) mods.get(m).hops.push(h.name); };
  for (const it of chosen) for (const h of it.hops) add(h);
  const ids = new Map([...mods.keys()].map((m, i) => [m, `m${i}`]));
  const g = grid(mods.size);
  const nodes = [...mods].map(([m, x], i) => ({ id: ids.get(m), kind: 'box', ...g.at(i), label: shortName(m), stereotype: `${m} · ${x.group}`,
    members: x.hops.length > 6 ? [...x.hops.slice(0, 5), `+${x.hops.length - 5} more`] : x.hops }));
  const edges = new Map(), crossings = [];
  for (const it of chosen) for (const h of it.hops) {
    for (const s of (h.connection?.steps || []).filter(s => s.down)) {
      const a = moduleOf(s.from), b = moduleOf(s.to);
      if (!ids.has(a) || !ids.has(b) || a === b) continue;
      const k = `${a}>${b}`;
      if (!edges.has(k) || CROSS.has(s.kind)) edges.set(k, { id: `e${edges.size}`, from: ids.get(a), to: ids.get(b), arrow: true, color: COLOR[s.kind] || 'client' });
      if (CROSS.has(s.kind)) crossings.push({ item: it.id, hop: h.index, from: s.from, to: s.to, kind: s.kind, evidence: s.evidence || null });
    }
    const x = h.exercises ? h.drive : null;
    if (x && ids.has(moduleOf(x.to))) {
      const a = moduleOf(h.symbol), b = moduleOf(x.to);
      edges.set(`${a}>${b}`, { id: '', from: ids.get(a), to: ids.get(b), arrow: true, color: COLOR[x.kind] || 'client' });
      crossings.push({ item: it.id, hop: h.index, from: h.symbol, to: x.to, kind: x.kind, evidence: x.evidence, exercises: h.exercises });
    }
  }
  [...edges.values()].forEach((e, i) => { e.id = `e${i}`; });
  return { host: 'diagram', as: 'map', flow: one || null, items: chosen.map(x => x.id),
    config: { layout: { columns: g.columns, rows: g.rows }, nodes, edges: [...edges.values()] }, crossings };
}

/* ---------------- sequence ---------------- */
function callerLabel(it) {
  const e = it.entry;
  if (!e) return { label: 'caller', sub: it.kind === 'core' ? 'shared code: called from several flows' : null };
  if (e.kind === 'http') return { label: `${e.method} ${e.path}`, sub: 'HTTP request' };
  if (e.kind === 'ui-route') return { label: e.path, sub: 'page in the browser' };
  if (e.kind === 'queue-consumer' || e.kind === 'scheduled') return { label: e.key, sub: e.kind === 'scheduled' ? 'schedule' : 'queue message' };
  if (e.kind === 'main' || e.kind === 'cli') return { label: e.file, sub: 'command line' };
  return { label: e.kind, sub: e.file };
}
function sequence() {
  const it = items.get(one);
  const parts = [{ id: 'caller', ...callerLabel(it) }];
  const pid = new Map();
  const part = mod => { if (!pid.has(mod)) { pid.set(mod, `p${pid.size}`); parts.push({ id: pid.get(mod), label: shortName(mod), sub: shortName(mod) === mod ? null : mod }); } return pid.get(mod); };
  const messages = [];
  const entryKind = it.entry?.kind === 'http' ? 'http' : it.entry?.kind === 'queue-consumer' ? 'queue' : 'call';
  for (const h of it.hops) {
    const to = part(moduleOf(h.symbol)), c = callIn(h);
    const from = c ? part(moduleOf(c.from)) : 'caller';
    messages.push({ from, to, label: h.name, kind: crossKind(h) || (c ? 'call' : entryKind), hop: h.index, via: Math.max(0, (h.connection?.steps || []).filter(s => s.down).length - 1) });
  }
  for (const h of it.hops.filter(x => x.exercises)) {
    const tgt = items.get(h.exercises), vid = videoOf(h.exercises);
    const id = `flow:${h.exercises}`;
    if (!parts.some(p => p.id === id)) parts.push({ id, label: tgt.title, sub: vid.video ? `see video ${vid.video}` : 'a production flow' });
    messages.push({ from: part(moduleOf(h.symbol)), to: id, label: `drives ${h.exercises}`, kind: h.drive.kind, hop: h.index, via: 0 });
  }
  return { host: 'svg', as: 'sequence', flow: it.id, primitive: 'sequence',
    params: { x: 160, y: 170, w: 1600, h: 800, at: 0, participants: parts, messages } };
}

/* ---------------- exercises ---------------- */
// how an eval or dev hop drives the production flow it names is apply-flows' `drive`: {kind, to, evidence}
function exercises() {
  const it = items.get(one);
  const drives = it.hops.filter(h => h.exercises);
  if (!drives.length) fail(1, `${one} has no hop that exercises a production flow: --as exercises draws an eval or dev flow's hand-off`);
  const targets = [...new Set(drives.map(h => h.exercises))];
  const ys = spread(Math.max(it.hops.length, targets.length), 220, 900);
  const links = drives.map(h => ({ hop: h.index, symbol: h.symbol, target: h.exercises, targetTitle: items.get(h.exercises).title, ...videoOf(h.exercises), ...h.drive }));
  const nodes = [
    ...it.hops.map((h, i) => ({ id: `h${h.index}`, kind: 'box', column: 'harness', row: i, label: h.name, stereotype: `${it.group} · hop ${h.index}`, size: { w: 420, h: 96 } })),
    ...targets.map((t, i) => { const l = links.find(x => x.target === t); return { id: `flow:${t}`, kind: 'box', column: 'production', row: i, label: t, stereotype: 'production flow', members: [l.video ? `see video ${l.video}` : 'not in this series'], sub: items.get(t).title }; }),
  ];
  const edges = links.map((l, i) => ({ id: `x${i}`, from: `h${l.hop}`, to: `flow:${l.target}`, arrow: true, color: COLOR[l.kind] || 'client' }));
  return { host: 'diagram', as: 'exercises', flow: it.id, exercises: links,
    config: { layout: { columns: { harness: { x: 440 }, production: { x: 1420 } }, rows: ys }, nodes, edges } };
}

console.log(JSON.stringify(AS === 'map' ? map() : AS === 'sequence' ? sequence() : exercises(), null, 2));
