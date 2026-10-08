#!/usr/bin/env node
/* =============================================================================
   apply-enrichment.mjs — deterministic merge of agent judgment into a plan.

   WHY THIS EXISTS, AND WHY IT IS NOT AN API CALL
   ----------------------------------------------
   Naming videos, choosing their visual form, and pruning redundant overview
   videos is JUDGMENT. The host agent is already an LLM sitting in the loop with
   the plan, the sources and the user's stated preferences — so it does the
   judging and writes `enrichment.json`.

   This script does what code should: merge, validate, and report. It never
   guesses. If the agent is unavailable, nothing happens and the deterministic
   plan still stands.

   THE TITLE CONTRACT (what the agent must produce)
   ------------------------------------------------
   One entry per video, each a real title — descriptive, unique, and written
   for a human scrolling YouTube, not a directory name. `apply-enrichment`
   enforces the floor: it rejects empty titles, placeholders ("Part N"),
   ellipses, directory-slug titles ("load-balancing"), and duplicates.

   CURATION (skip / merge)
   ------------------------
   A deterministic planner cannot tell an overview page from real content, so it
   plans both. The agent decides, and records the decision instead of letting it
   be implicit:
     { "index": 33, "skip": true, "why": "phase index — content lives in #34/#35" }
     { "index": 33, "mergeInto": 35, "why": "fold the 'why this phase' prose" }
   Both require a stated reason. Skip drops the video and records its sections;
   mergeInto folds the video's sections and words into the target. Neither is
   silent — both land in `plan.removed` with the reason.

   Usage:
     node tools/apply-enrichment.mjs --plan out/<name>/plan.json \
                                     --enrichment out/<name>/enrichment.json
   ========================================================================== */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? d : argv[i + 1];
};
const PLAN = flag('plan');
const ENR = flag('enrichment');
if (!PLAN || !ENR) {
  console.error('usage: node tools/apply-enrichment.mjs --plan <plan.json> --enrichment <enrichment.json>');
  process.exit(1);
}
for (const p of [PLAN, ENR]) if (!existsSync(p)) { console.error('not found: ' + p); process.exit(1); }

const plan = JSON.parse(readFileSync(PLAN, 'utf8'));
const enrichment = JSON.parse(readFileSync(ENR, 'utf8'));
const OUT_DIR = dirname(PLAN);

const FORMS = ['concept', 'diagram', 'code', 'refactor', 'catalogue'];
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)+$/;   // "load-balancing" — a dir slug, not a title
const problems = [];
const changes = [];
const byIndex = new Map((enrichment.videos || []).map(v => [Number(v.index), v]));
const ids = new Set(plan.videos.map(v => v.index));

// ---------- pass 1: read curation intent (skip / mergeInto), validate it ----
const skipSet = new Set();
const mergeMap = new Map();   // srcIndex -> targetIndex
for (const v of plan.videos) {
  const e = byIndex.get(v.index);
  if (!e) continue;
  const skip = !!e.skip;
  const merge = e.mergeInto != null ? Number(e.mergeInto) : null;
  if (skip && merge != null) problems.push(`video ${v.index}: both skip and mergeInto set — choose one`);
  if (skip) {
    if (!String(e.why || '').trim()) problems.push(`video ${v.index}: skip requires a stated reason ("why")`);
    skipSet.add(v.index);
  }
  if (merge != null) {
    if (!String(e.why || '').trim()) problems.push(`video ${v.index}: mergeInto requires a stated reason ("why")`);
    mergeMap.set(v.index, merge);
  }
}
for (const [src, tgt] of mergeMap) {
  if (src === tgt) problems.push(`video ${src}: mergeInto must target a different video`);
  else if (!ids.has(tgt)) problems.push(`video ${src}: mergeInto references ${tgt}, which is not in the plan`);
  else if (skipSet.has(tgt)) problems.push(`video ${src}: mergeInto target ${tgt} is itself skipped`);
  else if (mergeMap.has(tgt)) problems.push(`video ${src}: mergeInto target ${tgt} is itself merged — chains unsupported`);
}

// ---------- pass 2: title + form, for the videos that survive --------------
const seenTitles = new Map();   // title -> index (uniqueness among survivors)
plan.videos.forEach(v => {
  const e = byIndex.get(v.index);
  v.before = { title: v.title, form: v.form };
  if (!e) { problems.push(`video ${v.index}: no enrichment entry`); return; }
  const removed = skipSet.has(v.index) || mergeMap.has(v.index);

  if (!removed) {
    // --- title ---
    const t = String(e.title || '').trim();
    if (!t) problems.push(`video ${v.index}: empty title`);
    else if (t.length > 70) problems.push(`video ${v.index}: title too long (${t.length}): "${t}"`);
    else if (/\.\.\.|…/.test(t)) problems.push(`video ${v.index}: title contains an ellipsis: "${t}"`);
    else if (/^part\s+\d+$/i.test(t)) problems.push(`video ${v.index}: title is a placeholder: "${t}"`);
    else if (SLUG_RE.test(t)) problems.push(`video ${v.index}: title "${t}" is a directory slug — write a real title`);
    else if (seenTitles.has(t)) problems.push(`video ${v.index}: duplicate title "${t}" (already used by video ${seenTitles.get(t)})`);
    else { v.title = t; seenTitles.set(t, v.index); }

    // --- form ---
    const f = String(e.form || '').trim();
    if (!FORMS.includes(f)) problems.push(`video ${v.index}: form "${f}" not in [${FORMS.join(', ')}]`);
    else v.form = f;
  }

  v.formWhy = e.why ? String(e.why) : v.formWhy;

  if (v.before.title !== v.title || v.before.form !== v.form) {
    changes.push({ index: v.index, from: v.before, to: { title: v.title, form: v.form } });
  }
});

// a video must not silently vanish from the enrichment
for (const i of byIndex.keys()) {
  if (!ids.has(i)) problems.push(`enrichment references video ${i}, which is not in the plan`);
}

// ---------- apply merges: fold sections + words into the target -------------
const byId = new Map(plan.videos.map(v => [v.index, v]));
const model = plan.model || { wpm: 153, expansion: 1.1 };
for (const [src, tgt] of mergeMap) {
  const s = byId.get(src), t = byId.get(tgt);
  if (!s || !t) continue;
  t.sections = (t.sections || []).concat(s.sections || []);
  t.sectionSpans = (t.sectionSpans || []).concat(s.sectionSpans || []);
  t.words = (t.words || 0) + (s.words || 0);
  t.seconds = Math.round((t.words / model.wpm) * 60 * model.expansion);
  t.minutes = +(t.seconds / 60).toFixed(1);
}

// ---------- remove skipped / merged videos, recording what happened ---------
const removed = [];
plan.videos = plan.videos.filter(v => {
  const e = byIndex.get(v.index);
  const skip = skipSet.has(v.index);
  const merge = mergeMap.has(v.index);
  if (skip || merge) {
    removed.push({
      index: v.index,
      title: v.before.title,
      action: skip ? 'skip' : `mergeInto ${mergeMap.get(v.index)}`,
      reason: e && e.why ? String(e.why) : null,
      sections: v.sections || [],
    });
    return false;
  }
  return true;
});

// ---------- recompute totals that curation changed --------------------------
plan.totals.videos = plan.videos.length;
plan.totals.seriesMinutes = +plan.videos.reduce((a, v) => a + v.minutes, 0).toFixed(1);
plan.totals.longestVideoMin = Math.max(...plan.videos.map(v => v.minutes));

plan.enrichment = {
  source: 'host-agent judgment (' + ENR + ')',
  seriesNote: enrichment.seriesNote || null,
  revised: changes.length,
  removed,
  validationProblems: problems,
};

writeFileSync(join(OUT_DIR, 'plan.enriched.json'), JSON.stringify(plan, null, 2));

/* ---------------- report ---------------- */
const L = [];
L.push(`# ${plan.generatedFrom} — enriched plan`, '');
if (plan.enrichment.seriesNote) L.push(`> ${plan.enrichment.seriesNote}`, '');
L.push(`${plan.totals.videos} videos · ${plan.totals.seriesMinutes} min · longest ${plan.totals.longestVideoMin} min (cap ${plan.totals.capMinutes}) · **${changes.length} revised**${removed.length ? ` · ${removed.length} removed` : ''}`, '');
L.push('| # | Title | Form | Min | Previously |');
L.push('|---|---|---|---|---|');
plan.videos.forEach(v => {
  const wasT = v.before.title === v.title ? '—' : `"${v.before.title}"`;
  const wasF = v.before.form === v.form ? '' : ` _(form: ${v.before.form})_`;
  L.push(`| ${v.index} | **${v.title}** | \`${v.form}\` | ${v.minutes} | ${wasT}${wasF} |`);
});
L.push('', '### Why each form', '');
plan.videos.forEach(v => L.push(`- **${v.index}. ${v.title}** → \`${v.form}\` — ${v.formWhy}`));
if (removed.length) {
  L.push('', '### Removed by curation', '');
  removed.forEach(r => L.push(`- **${r.index}. ${r.before || r.title}** → ${r.action} — ${r.reason || '(no reason)'}`));
}
L.push('', '### Coverage (carried from the deterministic planner)', '');
L.push(`${plan.coverage.length} headings · ${plan.orphans.length} orphaned`);
L.push(plan.orphans.length ? '⚠️ orphans present' : '✅ No orphans — every content-bearing heading is assigned to a video or is a navigation heading.');
if (problems.length) {
  L.push('', '### ⚠️ Validation problems', '');
  problems.forEach(p => L.push(`- ${p}`));
}
writeFileSync(join(OUT_DIR, 'plan.enriched.md'), L.join('\n') + '\n');

console.log(L.slice(0, 18).join('\n'));
console.log(`\n[out] ${join(OUT_DIR, 'plan.enriched.json')}`);
console.log(`[out] ${join(OUT_DIR, 'plan.enriched.md')}`);
if (problems.length) { console.log(`\n⚠️  ${problems.length} validation problem(s)`); process.exitCode = 2; }
