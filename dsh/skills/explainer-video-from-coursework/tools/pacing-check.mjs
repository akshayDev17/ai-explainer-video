#!/usr/bin/env node
/* =============================================================================
   pacing-check.mjs — does the SCENE give the NARRATION room to breathe?

   The coverage check stops content being dropped. This stops content being
   RUSHED. A scene can cover every source section and still be unwatchable
   because it gives 41 seconds of narration a 30-second stage.

   It enforces two independent things:
     1. BUDGET    scene duration must fit the narration (with visual overhead)
     2. READABILITY  line reveal must sit in a human reading band

   Both are computed with the same dwell model the renderer uses, so the check
   and the render cannot disagree.

   Usage:
     node tools/pacing-check.mjs --scene out/<name>/<NN>/scenes/<key>.js \
                                 --timeline out/<name>/<NN>/timeline.json \
                                 [--segment <key>]
   ========================================================================== */

import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { WPM as DEFAULT_WPM, EXPANSION as DEFAULT_EXPANSION } from './model.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};

const WPM = parseFloat(flag('wpm', DEFAULT_WPM));
const EXPANSION = parseFloat(flag('expansion', DEFAULT_EXPANSION));
const MIN_RATE = parseFloat(flag('min-rate', '0.45'));   // lines/sec — below = sluggish
const MAX_RATE = parseFloat(flag('max-rate', '1.60'));   // lines/sec — above = unreadable

const scenePath = flag('scene');
if (!scenePath || !existsSync(scenePath)) {
  console.error('usage: node tools/pacing-check.mjs --scene <scene-config.js> [--script <script.json>] [--segment <key>]');
  process.exit(1);
}

/* ---- load a browser-style config in node ---- */
global.window = {};
await import(pathToFileURL(resolve(scenePath)).href);
const cfg = global.window.SCENE_CONFIG;
if (!cfg) { console.error('config did not set window.SCENE_CONFIG'); process.exit(1); }

const errors = [];
const warnings = [];

/* ---- dwell model (must mirror scene-code.js) ---- */
const DWELL_BASE = 0.28, DWELL_PER_CHAR = 0.038;
function naturalReveal(lines, rev) {
  if (rev.stagger != null) {
    return { total: (lines.length - 1) * rev.stagger, perLine: lines.map(() => rev.stagger) };
  }
  const base = (rev.dwell && rev.dwell.base) != null ? rev.dwell.base : DWELL_BASE;
  const perChar = (rev.dwell && rev.dwell.perChar) != null ? rev.dwell.perChar : DWELL_PER_CHAR;
  const speed = rev.speed || 1;
  const perLine = lines.map(l => (base + l.length * perChar) / speed);
  return { total: perLine.reduce((a, b) => a + b, 0), perLine };
}

/* ---- resolve the measured timeline FIRST: the diagram renderer takes its
   duration from it, and "segment@offset" beats need it resolved ---- */
const scriptPath = flag('script');
const timelinePath = flag('timeline');
const segmentKeyForTotal = flag('segment', cfg.scriptSegment);

let SCENES = {};
let TL_TOTAL = null;
let WINDOWS = {};
if (timelinePath && existsSync(timelinePath)) {
  const tl0 = JSON.parse(readFileSync(timelinePath, 'utf8'));
  TL_TOTAL = tl0.total;
  WINDOWS = tl0.windows || {};
  (tl0.segments || []).forEach(sg => { SCENES[sg.key] = { start: sg.start, end: sg.end, dur: sg.duration }; });
}
// The code renderer declares `total` in its config. A segment scene takes its
// duration from that segment's WINDOW in the finished video — not the whole
// timeline, which would compare one scene against every other scene combined.
const segWindow = WINDOWS[segmentKeyForTotal];
const TOTAL = cfg.total != null ? cfg.total : (segWindow ? segWindow.dur : TL_TOTAL);
if (TOTAL == null) { console.error('no scene total: neither config.total nor timeline.total is set'); process.exit(1); }

/* Everything below works in WINDOW-RELATIVE seconds: 0 is the start of this
   segment's window, TOTAL is its end. A config timing like "seg@4.6" is relative
   to the segment's narration, which begins LEAD seconds into the window. Mixing
   absolute and relative in the event set is what used to make the dead-air check
   measure the lead-in and inter-segment gaps instead of in-scene quiet. */
const leadFor = k => (SCENES[k] && WINDOWS[k]) ? +(SCENES[k].start - WINDOWS[k].start).toFixed(3) : 0;
const LEAD = leadFor(segmentKeyForTotal);
const R = v => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const m = /^([a-z][a-z0-9-]*)@(-?[0-9.]+)$/.exec(v);
    if (m && SCENES[m[1]]) return +(leadFor(m[1]) + parseFloat(m[2])).toFixed(3);
  }
  return v;
};
const asNum = v => (typeof v === 'number' ? v : null);

console.log(`\n${scenePath}`);
console.log('─'.repeat(60));
console.log(`  scene total          : ${TOTAL}s${cfg.total == null ? '  (from the measured timeline)' : '  (declared in config)'}`);

/* ---- 1. readability of each reveal ---- */
(cfg.acts || []).filter(a => a.op === 'reveal').forEach(act => {
  const panel = (cfg.panels || []).find(p => p.id === act.panel);
  if (!panel) return;
  const n = naturalReveal(panel.lines, act);
  const rate = panel.lines.length / n.total;
  const end = (act.from || 0) + n.total;
  const flagTxt = rate > MAX_RATE ? '  ✗ too fast to read' : rate < MIN_RATE ? '  ⚠ sluggish' : '  ✓ readable';
  console.log(`  reveal ${String(act.panel).padEnd(7)} : ${String(panel.lines.length).padStart(2)} lines, natural ${n.total.toFixed(1)}s  →  ${rate.toFixed(2)} lines/sec${flagTxt}`);
  console.log(`                       runs ${(act.from || 0).toFixed(1)}s → ${end.toFixed(1)}s`);

  if (rate > MAX_RATE) errors.push(`reveal "${act.panel}" is ${rate.toFixed(2)} lines/sec (max ${MAX_RATE}) — viewers cannot read that fast`);
  if (rate < MIN_RATE) warnings.push(`reveal "${act.panel}" is ${rate.toFixed(2)} lines/sec (min ${MIN_RATE}) — may drag`);
  if (end > TOTAL) errors.push(`reveal "${act.panel}" finishes at ${end.toFixed(1)}s, past the ${TOTAL}s scene end`);
});

/* ---- 2. does the scene fit the narration? ---- */
const segmentKey = flag('segment', cfg.scriptSegment);
let measured = null;
if (timelinePath && existsSync(timelinePath)) {
  const tl = JSON.parse(readFileSync(timelinePath, 'utf8'));
  measured = (tl.segments || []).find(s => s.key === segmentKey);
}

if (measured) {
  // MEASURED audio beats an estimate — never tune a scene to a wpm guess when
  // the real waveform exists.
  const need = measured.duration;
  const ratio = TOTAL / need;
  console.log(`  narration "${segmentKey}"  : MEASURED ${need.toFixed(2)}s  (${measured.words} words, ${(measured.words / need * 60).toFixed(0)} wpm actual)`);
  console.log(`  scene vs need        : ${TOTAL}s / ${need.toFixed(2)}s = ${(ratio * 100).toFixed(0)}%`);
  if (ratio < 1.0) errors.push(`scene is ${TOTAL}s but the measured narration is ${need.toFixed(2)}s — audio would be cut off`);
  else if (ratio > 1.6) warnings.push(`scene is ${TOTAL}s vs ${need.toFixed(2)}s of narration — a lot of dead air`);
  else console.log('  ✓ scene fits the measured audio');
} else if (scriptPath && existsSync(scriptPath) && segmentKey) {
  const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
  const seg = script.segments.find(s => s.key === segmentKey);
  if (!seg) {
    warnings.push(`segment "${segmentKey}" not found in script — budget check skipped`);
  } else {
    const words = seg.text.split(/\s+/).filter(Boolean).length;
    const narrSec = (words / WPM) * 60;
    const needSec = narrSec * EXPANSION;
    const ratio = TOTAL / needSec;
    console.log(`  narration "${segmentKey}"  : ${words} words → ${narrSec.toFixed(1)}s ESTIMATED → ${needSec.toFixed(1)}s with overhead`);
    console.log(`  scene vs need        : ${TOTAL}s / ${needSec.toFixed(1)}s = ${(ratio * 100).toFixed(0)}%   (estimate — pass --timeline for measured)`);
    if (ratio < 0.9) {
      errors.push(`scene is ${TOTAL}s but "${segmentKey}" needs ${needSec.toFixed(1)}s — ${((1 - ratio) * 100).toFixed(0)}% too fast`);
    } else if (ratio > 1.6) {
      warnings.push(`scene is ${TOTAL}s vs ${needSec.toFixed(1)}s needed — a lot of dead air`);
    } else {
      console.log('  ✓ scene gives the narration room');
    }
  }
} else if (!scriptPath && !timelinePath) {
  console.log('  (no --script/--timeline given — budget check skipped)');
}

/* ---- 3. beats: does each beat get the time it declared it needs? ----
   The author declares visual beats, each with a minimum dwell. The narration
   supplies its own MEASURED duration. A beat resolves to
   max(narration, visual_min) — so a beat whose minimum exceeds the time available
   is a SHORTFALL, and a shortfall is a prompt, not a failure: hold the frame, pad
   the audio gap, or extend the narration. A beat that cannot fit inside its
   segment at all is a genuine error. */
const BEATS = Array.isArray(global.window.SCENE_BEATS) ? global.window.SCENE_BEATS.slice() : null;
if (BEATS && BEATS.length && measured) {
  const narr = measured.duration;
  const pad = measured.pad || 0;
  /* a beat can occupy the whole window — narration, the declared `pad` hold, and
     the built-in inter-segment gap */
  const winEnd = TOTAL - LEAD;
  BEATS.sort((a, b) => (a.at || 0) - (b.at || 0));
  const last = BEATS[BEATS.length - 1];
  const visualNeed = (last.at || 0) + (last.min || 0);
  console.log(`  beats                : ${BEATS.length} declared · visual needs ${visualNeed.toFixed(1)}s · narration ${narr.toFixed(2)}s${pad > 0 ? ' + ' + pad + 's hold' : ''} (window ${winEnd.toFixed(2)}s)`);

  const shortfalls = [];
  BEATS.forEach((b, i) => {
    const at = b.at || 0, min = b.min || 0, end = at + min;
    const next = BEATS[i + 1];
    if (end > winEnd + 0.001) {
      errors.push(`beat "${b.id}" ends at ${end.toFixed(1)}s, past the ${winEnd.toFixed(2)}s window — add \`pad\` to the segment or shorten it`);
      return;
    }
    if (next && end > (next.at || 0) + 0.001) {
      shortfalls.push({ id: b.id, need: min, have: (next.at || 0) - at });
      return;
    }
    if (end > narr + 0.001) {
      if (b.hold) warnings.push(`beat "${b.id}" runs ${(end - narr).toFixed(1)}s past the narration — declared hold`);
      else shortfalls.push({ id: b.id, need: min, have: narr - at });
    }
  });

  if (shortfalls.length) {
    console.log(`  shortfalls           : ${shortfalls.length} — hold the frame, pad the audio gap, or extend the narration`);
    shortfalls.forEach(s => console.log(`     · "${s.id}" needs ${s.need.toFixed(1)}s, has ${s.have.toFixed(1)}s  (+${(s.need - s.have).toFixed(1)}s)`));
  } else {
    console.log('  ✓ every beat has the time it declared it needs');
  }
} else if (BEATS && BEATS.length) {
  console.log('  beats                : declared, but no measured narration — beat check skipped');
}

/* ---- 4. is anything still HAPPENING? ----
   The first two checks passed on a cut with 7.3 seconds of dead air at the end,
   because both only looked at RATES. A scene can be perfectly paced and still
   finish with a static card sitting there. This asks the question directly:
   what is the longest stretch with no visual state change? */
const MAX_QUIET = parseFloat(flag('max-quiet', '3.5'));
{
  const events = new Set([0, TOTAL]);
  (cfg.acts || []).forEach(a => {
    if (a.from != null) events.add(a.from);
    if (a.to != null && (a.op === 'show' || a.op === 'layout')) events.add(a.to);
    if (a.op === 'reveal') {
      const p = (cfg.panels || []).find(x => x.id === a.panel);
      if (p) {
        // every line fading in is its own state change — a 20s reveal is not one
        // quiet gap, it is 22 events. Modelling it coarsely reports false dead air.
        let acc = a.from;
        naturalReveal(p.lines, a).perLine.forEach(d => { events.add(+acc.toFixed(3)); acc += d; });
        events.add(+acc.toFixed(3));
      }
    }
  });
  (cfg.notes || []).forEach(n => { events.add(R(n.from)); if (n.to != null) events.add(R(n.to)); });

  // --- diagram renderer vocabulary: reveal / hide / draw / banners ---
  Object.values(cfg.reveal || {}).forEach(([a, b]) => { [R(a), R(b)].forEach(x => asNum(x) != null && events.add(asNum(x))); });
  Object.values(cfg.hide || {}).forEach(([a, b]) => { [R(a), R(b)].forEach(x => asNum(x) != null && events.add(asNum(x))); });
  Object.values(cfg.draw || {}).forEach(d => { if (d.at) [R(d.at[0]), R(d.at[1])].forEach(x => asNum(x) != null && events.add(asNum(x))); });
  (cfg.banners || []).forEach(b => { const f = asNum(R(b.from)); if (f != null) events.add(f); const u = asNum(R(b.until)); if (u != null) events.add(u); });

  // declared beats are visual activity: their [at, at+min] spans are state changes,
  // and the span itself counts as "not silent" for the dead-air gap below.
  const beatSpans = (BEATS || []).map(b => {
    const s = LEAD + (b.at || 0), e = LEAD + (b.at || 0) + (b.min || 0);
    if (s <= TOTAL) events.add(+s.toFixed(3));
    if (e <= TOTAL) events.add(+e.toFixed(3));
    return [s, e];
  });

  const times = [...events].filter(t => t <= TOTAL).sort((a, b) => a - b);

  /* Dead air is NO VISUAL CHANGE **and** NO NARRATION.
     A note sitting still while the voice explains is normal; a static frame in
     silence is the thing that feels like a hang. So subtract the narration
     windows from each gap and only measure what is genuinely quiet. */
  /* not-silent = narration ∪ the declared beat spans, all window-relative */
  const narrWindows = (measured && segWindow)
    ? [[LEAD, +(LEAD + measured.duration).toFixed(3)]].concat(beatSpans)
    : [];
  const silentPortion = (a, b) => {
    let segs = [[a, b]];
    for (const [s, e] of narrWindows) {
      const next = [];
      for (const [x, y] of segs) {
        if (e <= x || s >= y) { next.push([x, y]); continue; }
        if (s > x) next.push([x, Math.min(s, y)]);
        if (e < y) next.push([Math.max(e, x), y]);
      }
      segs = next;
    }
    return segs.reduce((acc, [x, y]) => acc + Math.max(0, y - x), 0);
  };

  let maxGap = 0, gapAt = 0;
  for (let i = 1; i < times.length; i++) {
    const g = silentPortion(times[i - 1], times[i]);
    if (g > maxGap) { maxGap = g; gapAt = times[i - 1]; }
  }
  const tail = silentPortion(times[times.length - 2], times[times.length - 1]);

  console.log(`  dead air      : longest ${maxGap.toFixed(1)}s with no visual change AND no narration (at ${gapAt.toFixed(1)}s)`);
  console.log(`                  ending holds a static frame in silence for ${tail.toFixed(1)}s`);
  if (maxGap > MAX_QUIET) {
    errors.push(`dead air: nothing changes on screen and nothing is said for ${maxGap.toFixed(1)}s starting at ${gapAt.toFixed(1)}s (max ${MAX_QUIET}s)`);
  }
}

if (warnings.length) {
  console.log(`\n  ⚠ ${warnings.length} warning(s):`);
  warnings.forEach(w => console.log(`     - ${w}`));
}
if (errors.length) {
  console.log(`\n  ✗ ${errors.length} error(s):`);
  errors.forEach(e => console.log(`     - ${e}`));
} else {
  console.log('\n  ✓ pacing is sound');
}
process.exitCode = errors.length ? 2 : 0;
