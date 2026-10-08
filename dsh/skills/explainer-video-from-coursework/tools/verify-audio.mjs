#!/usr/bin/env node
/* =============================================================================
   verify-audio.mjs — does the finished video's audio actually match the
   narration track, sample for sample?

   RMS was not good enough. Speech sits at a roughly constant level, so a part
   playing the WRONG slice of narration can still have a similar RMS. The only
   reliable question is: if you subtract one from the other, how much energy is
   left?

     residual = sqrt( sum((a-n)^2) / sum(a^2) )

   Matching content -> residual is near zero (only codec noise).
   Wrong slice     -> residual approaches ~1.4 (two unrelated signals).

   Usage:
     node tools/verify-audio.mjs --video out/<name>/<NN>/<output>.mp4 \
                                 --narration out/<name>/<NN>/narration.wav [--max 0.25]
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { requireCmd } from './env.mjs';

requireCmd('ffmpeg');

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? d : argv[i + 1];
};
const VIDEO = flag('video');
const NARR = flag('narration');
const MAX = parseFloat(flag('max', '0.25'));
const SR = 22050;

if (!VIDEO || !NARR || !existsSync(VIDEO) || !existsSync(NARR)) {
  console.error('usage: node tools/verify-audio.mjs --video <mp4> --narration <wav> [--max 0.25]');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'va-'));
const raw = (src, out, extra = []) => {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src, ...extra,
    '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(SR), '-ac', '1', out]);
};
const aPath = join(dir, 'a.raw'), nPath = join(dir, 'n.raw');
try {
  raw(VIDEO, aPath, ['-vn']);
  raw(NARR, nPath);
  const A = readFileSync(aPath), N = readFileSync(nPath);

  // compare only where the narration has any energy; lead-in silence would
  // otherwise dominate and flatter the result
  const samples = Math.floor(Math.min(A.length, N.length) / 2);
  let num = 0, den = 0;
  const win = Math.round(SR * 0.5);
  const active = [];
  for (let s = 0; s < samples; s += win) {
    let e = 0;
    for (let i = s; i < Math.min(s + win, samples); i++) {
      const v = N.readInt16LE(i * 2);
      e += v * v;
    }
    active.push(e);
  }
  const eMax = Math.max(...active) || 1;
  for (let s = 0; s < samples; s++) {
    if (active[Math.floor(s / win)] < eMax * 0.002) continue;   // skip near-silence
    const av = A.readInt16LE(s * 2), nv = N.readInt16LE(s * 2);
    num += (av - nv) * (av - nv);
    den += nv * nv;
  }
  const residual = den > 0 ? Math.sqrt(num / den) : NaN;
  const ok = residual <= MAX;
  console.log(`  residual (difference energy / signal energy): ${residual.toFixed(4)}   (max ${MAX})`);
  console.log(ok
    ? '  ✓ finished audio matches the narration'
    : '  ✗ finished audio does NOT match the narration — a part is playing the wrong slice');
  rmSync(dir, { recursive: true, force: true });
  process.exit(ok ? 0 : 2);
} catch (e) {
  rmSync(dir, { recursive: true, force: true });
  console.error('[verify-audio] failed:', e.message.split('\n')[0]);
  process.exit(1);
}
