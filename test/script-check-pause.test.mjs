// script-check's pause rule (design §5.5, ADR-008): narration is the reading time, and a pause prompt is the rare
// exception for a block that must be read whole. Active only when a segment carries `pause`: the prompt is spoken,
// dwells 0 < dwell <= 2 s (counted in the estimate), and a fourth prompt is an error that forces a split.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, scratch, cleanup } from './helpers.mjs';

const TOOL = join(ROOT, 'skills', 'explainer-video-from-coursework', 'tools', 'script-check.mjs');
const TMP = scratch();
after(() => cleanup(TMP));
let n = 0;
const words = k => Array.from({ length: k }, (_, i) => `word${i}`).join(' ') + '.';
const plain = i => ({ key: `s${i}`, style: 'calm', visual: 'the hop on screen', covers: [`x :: y @L${i}`], text: words(30) });
const paused = (i, dwell = 2) => ({ ...plain(i), text: `${words(23)} Pause the video and read this block.`, pause: { dwell }, pad: dwell });
const check = (segments, ...flags) => {
  const f = join(TMP, `script${n++}.json`);
  writeFileSync(f, JSON.stringify({ videoIndex: 3, title: 'A hop', segments }));
  return spawnSync(process.execPath, [TOOL, '--script', f, ...flags], { encoding: 'utf8' });
};

test('up to three pause prompts pass, and their dwell is counted in the estimate', () => {
  const r = check([plain(1), paused(2), paused(3, 1.5), paused(4, 0.5)]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /pauses {7}: 3 prompt\(s\), 4\.0s of dwell \(in est\. video\)/);
  // 120 words is 0.86 min of video; with 6 s of dwell it is 0.96, over a 0.9 min cap
  const capped = [plain(1), paused(2), paused(3), paused(4)];
  assert.equal(check(capped.map(s => ({ ...s, pause: undefined, pad: undefined })), '--max-min', '0.9').status, 0);
  const over = check(capped, '--max-min', '0.9');
  assert.equal(over.status, 2);
  assert.match(over.stdout, /estimated 1\.0 min exceeds the 0\.9 min cap/);
});

test('a fourth pause prompt is an error that forces a split', () => {
  const r = check([paused(1), paused(2), paused(3), paused(4)]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /4 pause prompts \(max 3\) — a video that asks for that much silent reading must be split/);
});

test('a pause segment must say "pause" and dwell more than 0 and at most 2 seconds', () => {
  const silent = check([{ ...paused(1), text: words(30) }]);
  assert.equal(silent.status, 2);
  assert.match(silent.stdout, /segment 1 \(s1\): a pause segment's narration must say "pause"/);
  for (const pause of [{ dwell: 2.5 }, { dwell: 0 }, { dwell: '2' }, true]) {
    const r = check([{ ...paused(1), pause }]);
    assert.equal(r.status, 2, JSON.stringify(pause));
    assert.match(r.stdout, /pause\.dwell must be a number of seconds, 0 < dwell <= 2/);
  }
});

test('a pause segment\'s pad is its dwell: a longer hold, or none, is an error', () => {
  for (const pad of [6, undefined, 1]) {
    const r = check([plain(1), { ...paused(2), pad }]);
    assert.equal(r.status, 2, String(pad));
    assert.match(r.stdout, /segment 2 \(s2\): pause\.dwell 2s is realised as the segment's pad, which is .* — set "pad": 2/);
  }
});

test('without a pause segment the rule is inert: no pause line in the report', () => {
  const r = check([plain(1), { ...plain(2), text: `${words(20)} We pause here only in passing.` }]);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /pauses/);
});
