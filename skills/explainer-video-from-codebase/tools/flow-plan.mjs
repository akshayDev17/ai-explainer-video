#!/usr/bin/env node
/* =============================================================================
   flow-plan.mjs — turn an approved, validated flow list into a video plan in
   the coursework plan's shape, so the per-video stages 3–8 run unchanged.

   Usage:
     node tools/flow-plan.mjs --flows out/<name>/flows.validated.json [--max-min 25] [--estimate] [--force]

   Refuses (exit 5) unless flows.approved.json beside it carries the sha256 of
   this flows.validated.json, and flows.json has not changed since it was
   validated: no plan, and so no script, exists before the user approves the
   list, and any later edit needs a new approval. --estimate prints the plan
   without writing it and without an approval (the approval table's estimate).

   The plan: one overview video, then each series flow and core in series order,
   split under the cap (lib/decompose.mjs). Each video carries `group` (its flow
   or core id), `sections` ("<file> :: <symbol> @L<start>", what a script's
   `covers` must name) and `sectionSpans` with each hop's cited tests. The plan
   lists `forms` (overview, flow, core) for apply-enrichment, and the approval.
   Coverage (C4): every kept hop is assigned to exactly one video.

   Exit: 0 ok · 1 bad flags or unreadable input · 2 an orphaned hop or a video over
         the cap · 4 would overwrite the plan an enriched plan was built from ·
         5 no matching approval
   ========================================================================== */
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, sep, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { MODEL, planVideos } from './lib/decompose.mjs';

const fail = (code, msg) => { console.error(`[flow-plan] ${msg}`); process.exit(code); };

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
const VALUED = new Set(['--flows', '--max-min']), BOOL = new Set(['--estimate', '--force']);
const flags = new Map();
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) { if (argv[i + 1] == null) fail(1, `${argv[i]} needs a value`); flags.set(argv[i], argv[++i]); }
  else if (BOOL.has(argv[i])) flags.set(argv[i], true);
  else fail(1, `unknown argument ${argv[i]}`);
}
if (!flags.has('--flows')) fail(1, 'usage: flow-plan.mjs --flows out/<name>/flows.validated.json [--max-min 25] [--estimate] [--force]');
const maxMin = flags.has('--max-min') ? Number(flags.get('--max-min')) : 25, minMin = 2.5;
if (!(maxMin > 0)) fail(1, '--max-min must be a positive number of minutes');
const VALIDATED = resolve(flags.get('--flows')), OUT = dirname(VALIDATED);
const sha = t => createHash('sha256').update(t).digest('hex');
let text, v;
try { text = readFileSync(VALIDATED, 'utf8'); v = JSON.parse(text); } catch (e) { fail(1, `cannot read the validated flows ${VALIDATED}: ${e.message}`); }
if (v?.schema !== 1 || v.tool?.name !== 'apply-flows.mjs' || v.ok !== true) fail(1, `${VALIDATED} is not a passing apply-flows.mjs output (schema 1)`);
if (v.root && existsSync(v.root)) { const root = realpathSync(v.root), o = realpathSync(OUT); if (o === root || o.startsWith(root + sep)) fail(1, `refusing to write inside the repo: ${OUT}`); }
const estimate = flags.has('--estimate');

/* ---------------- the approval (design §4.4b) ---------------- */
const APPROVED = join(OUT, 'flows.approved.json');
let approval = null;
const refuse = msg => estimate ? console.log(`[flow-plan] estimate only: ${msg}`) : fail(5, `${msg}\n  Show the user the approval table in flows.md and, on their explicit yes, run approve-flows. No plan was written.`);
const flowsFile = join(OUT, v.inputs.flows.file);
if (existsSync(flowsFile) && sha(readFileSync(flowsFile, 'utf8')) !== v.inputs.flows.sha256)
  refuse(`${v.inputs.flows.file} changed since apply-flows validated it: rerun apply-flows; the edited list needs a new approval.`);
else if (!existsSync(APPROVED)) refuse('no flows.approved.json: the user has not approved this flow list.');
else {
  try { approval = JSON.parse(readFileSync(APPROVED, 'utf8')); } catch (e) { refuse(`flows.approved.json is not valid JSON: ${e.message}`); }
  if (approval && approval.flowsHash !== sha(text)) {
    refuse(`flows.approved.json approves a different flow list (sha256 ${String(approval.flowsHash).slice(0, 12)}…, this one is ${sha(text).slice(0, 12)}…): the list changed after the approval.`);
    approval = null;
  }
}

/* ---------------- plan ---------------- */
const p = planVideos(v, { maxMin, minMin });
const plan = {
  generatedFrom: flags.get('--flows'), kind: 'codebase', root: v.root, commit: v.commit, treeHash: v.treeHash,
  model: { ...MODEL, maxVideoMin: maxMin, minVideoMin: minMin },
  forms: ['overview', 'flow', 'core'],
  approval: approval && { by: approval.approvedBy, at: approval.at, note: approval.note, flowsHash: approval.flowsHash },
  inputs: { ...v.inputs, validated: { file: relative(OUT, VALIDATED), sha256: sha(text) } },
  totals: p.totals, coverage: p.coverage, orphans: p.orphans, capViolations: p.capViolations,
  outOfRepo: v.outOfRepo, tests: v.tests, videos: p.videos,
};

const cite = t => `${t.strength === 'reachable' ? 'reachable from' : 'pinned by'} \`${t.test.split(':').pop()}\` (${t.file}:${t.assertLines.join(',')}): ${t.say}${t.strength === 'reachable' ? ' (reachable only: never "pinned" or "tested")' : ''}`;
const L = [];
L.push(`# ${(v.root || '').split('/').pop()} — code-flow video plan`, '');
L.push(plan.approval ? `Approved by **${plan.approval.by}** at ${plan.approval.at}: "${plan.approval.note}" (flows.validated.json sha256 ${plan.approval.flowsHash.slice(0, 12)}…)`
  : '**Estimate only: this flow list is not approved.** No plan is written until the user approves it.', '');
L.push('> Every constant in this estimate except the narration pace (WPM, EXPANSION) is **uncalibrated**: ' +
  `frame ${MODEL.frame}, hop ${MODEL.hopBase} + ${MODEL.wpl} words per narrated line (≤ ${MODEL.lineCap}), crossing ${MODEL.boundary}, taught branch ${MODEL.branch}, ` +
  `cited test ${MODEL.test} (≤ ${MODEL.maxTests} per video), overview ${MODEL.overview} words. The pilot measures them.`, '');
L.push(`## ${p.totals.videos} videos, ${p.totals.seriesMinutes} min (longest ${p.totals.longestVideoMin} min, cap ${maxMin} min)`, '');
L.push('| # | Title | Form | Group | Hops | Crossings | Branches | Cited tests | Words | Min |', '|---|---|---|---|---|---|---|---|---|---|');
for (const x of p.videos) L.push(`| ${x.index} | ${x.title} | \`${x.form}\` | ${x.group} | ${x.evidence.hops ?? '—'} | ${x.evidence.crossings ?? '—'} | ${x.evidence.branches ?? '—'} | ${x.evidence.citedTests ?? '—'} | ${x.words} | ${x.minutes} |`);
L.push('', '## Sections per video', '', 'A script covers each of its video\'s sections by name in `covers`.', '');
for (const x of p.videos) {
  L.push(`### ${x.index}. ${x.title}`, '', `${x.form} · ${x.formWhy}`, '');
  for (const s of x.sectionSpans) L.push(`- \`${s.id}\`${s.pinnedBy?.length ? ` — ${s.pinnedBy.map(cite).join('; ')}` : ''}`);
  for (const t of x.teach || []) L.push(`- teach \`${t.dispatch || t.guard}\`: ${t.say}`);
  L.push('');
}
L.push('## Coverage (C4)', '', `${p.coverage.length} hops · ${p.coverage.length - p.orphans.length} assigned to exactly one video · **${p.orphans.length} orphaned**`);
for (const o of p.orphans) L.push(`- ⚠️ ${o.item} hop ${o.hop}: ${o.symbol}`);
for (const c of p.capViolations) L.push(`- ⚠️ video ${c.index} is ${c.minutes} min, over the ${maxMin} min cap: a hop is never split; raise --max-min or narrate fewer lines`);
if (v.outOfRepo.length) L.push('', '## Out-of-repo claims (unverified)', '', ...v.outOfRepo.map(o => `- ${o.claim} — ${o.evidence}`));
L.push('');
const md = L.join('\n');

if (estimate) { console.log(md); process.exit(p.orphans.length || p.capViolations.length ? 2 : 0); }

/* ---------------- model guard: an enriched plan is keyed by video index ---------------- */
const ENRICHED = join(OUT, 'plan.enriched.json');
if (existsSync(ENRICHED)) {
  let prev = null;
  try { prev = JSON.parse(readFileSync(ENRICHED, 'utf8')); } catch { prev = null; }
  const why = [];
  if (prev?.treeHash !== v.treeHash) why.push('the code map tree');
  if (prev?.inputs?.candidates?.sha256 !== v.inputs.candidates.sha256) why.push('candidates.json');
  if (prev?.inputs?.flows?.sha256 !== v.inputs.flows.sha256) why.push('flows.json');
  if (prev?.approval?.flowsHash !== approval.flowsHash || prev?.approval?.at !== approval.at) why.push('the approval');
  if (prev?.model?.maxVideoMin !== maxMin) why.push(`the cap (${prev?.model?.maxVideoMin} → ${maxMin} min)`);
  if (why.length && !flags.has('--force')) fail(4, `plan.enriched.json was built from a different plan (${why.join(', ')} changed): enrichment is keyed by video index, so re-planning would repoint every curated title. Rerun with --force, then rerun apply-enrichment.`);
  if (why.length) console.error(`[flow-plan] --force: overwriting the plan behind plan.enriched.json (${why.join(', ')} changed); rerun apply-enrichment`);
}
writeFileSync(join(OUT, 'plan.json'), JSON.stringify(plan, null, 2));
writeFileSync(join(OUT, 'plan.md'), md);
console.log(md);
console.log(`[out] ${join(OUT, 'plan.json')}`);
console.log(`[out] ${join(OUT, 'plan.md')}`);
if (p.orphans.length || p.capViolations.length) { console.log(`\n⚠️  ${p.orphans.length} orphaned hop(s), ${p.capViolations.length} video(s) over the cap`); process.exitCode = 2; }
