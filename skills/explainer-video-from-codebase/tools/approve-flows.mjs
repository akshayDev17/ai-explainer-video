#!/usr/bin/env node
/* =============================================================================
   approve-flows.mjs — record the user's approval of a validated flow list.

   Usage:
     node tools/approve-flows.mjs --flows out/<name>/flows.validated.json --by user --note "<the user's words>"

   Run it only after the user said yes to flows.md's approval table as shown
   (design §4.4b): code cannot prove a human said yes, so the skill requires it.
   Writes flows.approved.json beside the validated flows:
     { flowsHash: sha256(flows.validated.json), series, approvedBy, at, note }
   The hash binds the approval to this list: any later edit to flows.json,
   revalidated or not, makes flow-plan refuse until the user approves again.

   Exit: 0 ok · 1 bad flags · 2 the validated flows are missing, invalid, or stale
         (flows.json changed since apply-flows validated it)
   ========================================================================== */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';

const fail = (code, msg) => { console.error(`[approve-flows] ${msg}`); process.exit(code); };

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
const VALUED = new Set(['--flows', '--by', '--note']);
const flags = new Map();
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) { if (argv[i + 1] == null) fail(1, `${argv[i]} needs a value`); flags.set(argv[i], argv[++i]); }
  else fail(1, `unknown argument ${argv[i]}`);
}
const USAGE = 'usage: approve-flows.mjs --flows out/<name>/flows.validated.json --by user --note "<the user\'s words>"';
for (const x of VALUED) if (!String(flags.get(x) ?? '').trim()) fail(1, `${x} is required · ${USAGE}`);
const VALIDATED = resolve(flags.get('--flows')), OUT = dirname(VALIDATED);
const sha = t => createHash('sha256').update(t).digest('hex');

/* ---------------- the validated flows ---------------- */
if (!existsSync(VALIDATED)) fail(2, `${VALIDATED} does not exist: run apply-flows until it exits 0 first`);
const text = readFileSync(VALIDATED, 'utf8');
let v;
try { v = JSON.parse(text); } catch (e) { fail(2, `${VALIDATED} is not valid JSON: ${e.message}`); }
if (v?.schema !== 1 || v.tool?.name !== 'apply-flows.mjs' || v.ok !== true || !Array.isArray(v.series) || !v.series.length)
  fail(2, `${VALIDATED} is not a passing apply-flows.mjs output (schema 1)`);
const flowsFile = join(OUT, v.inputs.flows.file);
if (existsSync(flowsFile) && sha(readFileSync(flowsFile, 'utf8')) !== v.inputs.flows.sha256)
  fail(2, `${v.inputs.flows.file} changed since apply-flows validated it: rerun apply-flows and show the user the new approval table`);

/* ---------------- write ---------------- */
const approval = {
  schema: 1, tool: { name: 'approve-flows.mjs' }, flowsFile: relative(OUT, VALIDATED), flowsHash: sha(text),
  series: v.series.map(({ kind, id, title, why }) => ({ kind, id, title, why })),
  approvedBy: flags.get('--by').trim(), at: new Date().toISOString(), note: flags.get('--note').trim(),
};
writeFileSync(join(OUT, 'flows.approved.json'), JSON.stringify(approval, null, 1) + '\n');
console.log(`[approve-flows] approved by ${approval.approvedBy} at ${approval.at}: ${approval.series.length} items (${approval.series.map(s => s.id).join(', ')})`);
console.log(`[approve-flows] bound to flows.validated.json sha256 ${approval.flowsHash.slice(0, 12)}… · wrote ${relative(process.cwd(), join(OUT, 'flows.approved.json'))}`);
