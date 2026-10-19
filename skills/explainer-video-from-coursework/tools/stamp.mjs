/* =============================================================================
   stamp.mjs — append one per-video stage timing row to out/<name>/timing.jsonl.

   Usage:
     node tools/stamp.mjs begin --out out/<name> --video <NN> --stage <n> [--note s]
     node tools/stamp.mjs end   --out out/<name> --video <NN> --stage <n> [--note s]

   A stage spans many turns and several processes, so its duration cannot be read
   directly: `begin` writes a throwaway start marker, `end` reads it, subtracts,
   appends one row, and deletes the marker. The marker never enters the ledger.

   One row per attempt, in long format — the stage dimension lives in the `stage`
   value, never in a column name — so stages can be added, renamed, or merged
   without ever changing the file's shape.

     { video, stage, attempt, seconds, ended_at, note }

   `attempt` is 1-based and auto-increments: it counts the rows already recorded for
   this (video, stage) and adds one, so a retry becomes attempt 2 with no bookkeeping.
   ========================================================================== */

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };

const STAGES = new Set(['3', '4', '4b', '5', '6', '7', '8']);
const outDir = flag('out');
const video = flag('video');
const stage = flag('stage');
const note = flag('note', null);

const die = (msg) => { console.error('[stamp] ' + msg); process.exit(1); };

if (!cmd || !['begin', 'end'].includes(cmd))
  die('usage: stamp.mjs <begin|end> --out <seriesDir> --video <NN> --stage <n> [--note s]');
if (!outDir) die('missing --out <seriesDir>');
if (!video) die('missing --video <NN> (the bare plan index)');
if (!stage || !STAGES.has(stage)) die(`--stage must be one of ${[...STAGES].join(', ')}`);

mkdirSync(outDir, { recursive: true });
const stampsDir = join(outDir, '.stamps');
const marker = join(stampsDir, `${video}.${stage}.start`);
const ledger = join(outDir, 'timing.jsonl');

if (cmd === 'begin') {
  mkdirSync(stampsDir, { recursive: true });
  if (existsSync(marker))
    console.error(`[stamp] overwriting an existing start marker for video ${video} stage ${stage} — did a previous \`end\` never run?`);
  writeFileSync(marker, String(Date.now()));
  console.log(`[stamp] begin video ${video} stage ${stage}`);
} else {
  if (!existsSync(marker))
    die(`no start marker for video ${video} stage ${stage} — run \`begin\` first`);
  const startMs = Number(readFileSync(marker, 'utf8').trim());
  const seconds = Math.round((Date.now() - startMs) / 100) / 10; // one decimal
  let attempt = 1;
  if (existsSync(ledger)) {
    const prior = readFileSync(ledger, 'utf8').split('\n').filter(Boolean);
    attempt = prior.reduce((n, line) => {
      try { const r = JSON.parse(line); return (r.video === video && r.stage === stage) ? n + 1 : n; }
      catch { return n; }
    }, 0) + 1;
  }
  const row = { video, stage, attempt, seconds, ended_at: new Date().toISOString(), note };
  appendFileSync(ledger, JSON.stringify(row) + '\n');
  unlinkSync(marker);
  console.log(`[stamp] video ${video} stage ${stage} attempt ${attempt} = ${seconds}s`);
}
