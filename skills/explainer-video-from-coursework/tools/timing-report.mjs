/* =============================================================================
   timing-report.mjs — render out/<name>/timing.jsonl into four human-readable views.

   Usage:
     node tools/timing-report.mjs --out out/<name>

   Reads the append-only ledger (one row per attempt) plus the enriched plan for
   titles, then writes:

     out/<name>/timing.csv   — long format, one row per attempt:
        video_title, stage, attempt, seconds, ended_at, note
     out/<name>/timing.md    — one heading per video title, a stage -> seconds table
                               (attempts summed) with a total.
     out/<name>/timing.svg   — static stacked bars (no-JS fallback; opens anywhere).
     out/<name>/timing.html  — interactive Plotly chart, self-contained and offline:
                               the vendored plotly-basic bundle is inlined, so no
                               network is needed to open it.

   All four are derived and regenerable; the ledger is the only source of truth.
   The stage dimension is a *value*, never a column or a hardcoded colour, so
   adding/removing/merging stages changes the legend — not the drawing code.
   ========================================================================== */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const outDir = flag('out');
if (!outDir) { console.error('usage: node tools/timing-report.mjs --out <seriesDir>'); process.exit(1); }

const ledgerPath = join(outDir, 'timing.jsonl');
const planPath = join(outDir, 'plan.enriched.json');

const rows = existsSync(ledgerPath)
  ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
  : [];

const titles = {};
if (existsSync(planPath)) {
  try {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    for (const v of (plan.videos || [])) if (v.index != null) titles[String(v.index)] = v.title;
  } catch { /* plan unreadable — fall back to the raw key as title */ }
}
const titleOf = (video) => titles[video] || video;
const round1 = (n) => String(Math.round(n * 10) / 10);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtDur = (n) => n < 60 ? `${round1(n)}s` : `${Math.floor(n / 60)}m${Math.round(n % 60)}s`;
const STAGE_NAMES = { '3': 'script', '4': 'audio', '4b': 'align', '5': 'scene', '6': 'publish', '7': 'render', '8': 'assemble' };
// Unknown stages (added later) still render, just under their bare token.
const stageLabel = (st) => STAGE_NAMES[st] ? `${st} · ${STAGE_NAMES[st]}` : st;
const PALETTE = ['#4f46e5', '#0ea5e9', '#14b8a6', '#f59e0b', '#ef4444', '#8b5cf6',
                 '#ec4899', '#10b981', '#f97316', '#6366f1', '#a855f7', '#22c55e'];
const TICK_WRAP = 42;   // y-tick labels wrap at this many chars, on word boundaries
const wrapTitle = (t, max = TICK_WRAP) => {
  const safe = esc(t);   // literal < & > must survive Plotly's HTML parsing of tick labels
  const lines = []; let cur = '';
  for (const w of safe.split(/\s+/)) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= max) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > 2) {                 // cap at two lines so row height stays predictable
    const rest = lines.slice(1).join(' ');
    lines.length = 1;
    lines.push(rest.length > max ? rest.slice(0, max - 1) + '…' : rest);
  }
  return lines.join('<br>');
};

const order = [...new Set(rows.map((r) => r.video))];
order.sort((a, b) => {
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
});

/* Shared aggregation: per video, its stages (attempts summed) and total. */
const vids = order.map((video) => {
  const byStage = new Map();
  for (const r of rows) {
    if (r.video !== video) continue;
    const e = byStage.get(r.stage) || { s: 0, n: 0 };
    e.s += r.seconds; e.n += 1; byStage.set(r.stage, e);
  }
  const stages = [...byStage.entries()].map(([st, e]) => [st, e.s, e.n]);
  return { video, title: titleOf(video), stages, total: stages.reduce((a, [, s]) => a + s, 0) };
});
const stageOrder = [];
const seen = new Set();
for (const v of vids) for (const [st] of v.stages) if (!seen.has(st)) { seen.add(st); stageOrder.push(st); }
const colorOf = new Map(stageOrder.map((st, i) => [st, PALETTE[i % PALETTE.length]]));
const maxTotal = Math.max(1, ...vids.map((v) => v.total));

/* ---- CSV (long format) ---- */
const csvField = (s) => {
  s = s == null ? '' : String(s);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
let csv = 'video_title,stage,attempt,seconds,ended_at,note\n';
for (const r of rows) {
  csv += [titleOf(r.video), r.stage, r.attempt, r.seconds, r.ended_at, r.note ?? '']
    .map(csvField).join(',') + '\n';
}
writeFileSync(join(outDir, 'timing.csv'), csv);

/* ---- MD (grouped by video) ---- */
let md = '# Timing audit\n\n';
if (!rows.length) md += '_No timing rows yet — run stages 3–8 and stamp them._\n';
for (const v of vids) {
  md += `## ${v.title}\n\n| stage | seconds | attempts |\n| --- | --- | --- |\n`;
  let total = 0;
  for (const [s, e, n] of v.stages) { md += `| ${s} | ${round1(e)} | ${n} |\n`; total += e; }
  md += `| **total** | **${round1(total)}** | |\n\n`;
}
writeFileSync(join(outDir, 'timing.md'), md);

/* ---- SVG (static stacked bars, no-JS fallback) ---- */
function buildSvg() {
  const L = 20, LABEL = 360, GAP = 12, CHART = 560, RAXIS = 64, R = 16;
  const WIDTH = L + LABEL + GAP + CHART + RAXIS + R;
  const ROW = 26, ROWGAP = 10;
  const TITLE_H = 30, LEGEND_H = 22, AXIS_H = 26;

  let legendLines = 1, lx = 0;
  for (const st of stageOrder) {
    const w = 16 + 6 + stageLabel(st).length * 7.2;
    if (lx + w > WIDTH - L - R && lx > 0) { legendLines++; lx = 0; }
    lx += w + 16;
  }

  const top = 20;
  const legendTop = top + TITLE_H + 6;
  const chartTop = legendTop + legendLines * LEGEND_H + 14;
  const rowsTop = chartTop + 8;
  const axisTop = rowsTop + vids.length * (ROW + ROWGAP);
  const HEIGHT = axisTop + AXIS_H + 16;
  const chartX = L + LABEL + GAP;

  const p = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" `
    + `viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">`);
  p.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  p.push(`<text x="${L}" y="${top + 18}" font-size="18" font-weight="600" fill="#111827">`
    + `Time per video, by stage</text>`);

  if (!vids.length) {
    p.push(`<text x="${L}" y="${chartTop + 24}" font-size="14" fill="#6b7280">No timing rows yet.</text>`);
    p.push('</svg>');
    return p.join('\n');
  }

  lx = L; let ly = legendTop;
  for (const st of stageOrder) {
    const w = 16 + 6 + stageLabel(st).length * 7.2;
    if (lx + w > WIDTH - R && lx > L) { lx = L; ly += LEGEND_H; }
    p.push(`<rect x="${lx}" y="${ly}" width="14" height="14" rx="3" fill="${colorOf.get(st)}"/>`);
    p.push(`<text x="${lx + 20}" y="${ly + 11}" font-size="12" fill="#374151">${esc(stageLabel(st))}</text>`);
    lx += w + 16;
  }

  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const gx = chartX + CHART * i / ticks;
    p.push(`<line x1="${gx}" y1="${rowsTop - 8}" x2="${gx}" y2="${axisTop - AXIS_H}" stroke="#e5e7eb"/>`);
    const anchor = i === 0 ? 'start' : i === ticks ? 'end' : 'middle';
    p.push(`<text x="${gx}" y="${axisTop}" font-size="11" fill="#6b7280" text-anchor="${anchor}">`
      + `${fmtDur(maxTotal * i / ticks)}</text>`);
  }

  vids.forEach((v, i) => {
    const y = rowsTop + i * (ROW + ROWGAP);
    const label = v.title.length > 52 ? v.title.slice(0, 51) + '…' : v.title;
    p.push(`<text x="${L}" y="${y + ROW / 2 + 4}" font-size="12" fill="#111827">${esc(label)}</text>`);
    let bx = chartX;
    for (const [st, sec, attempts] of v.stages) {
      const w = (sec / maxTotal) * CHART;
      const tip = `${esc(v.title)} — ${esc(stageLabel(st))}: ${round1(sec)}s${attempts > 1 ? ' (' + attempts + ' attempts)' : ''}`;
      p.push(`<rect x="${bx}" y="${y}" width="${w}" height="${ROW}" rx="2" fill="${colorOf.get(st)}">`
        + `<title>${tip}</title></rect>`);
      bx += w;
    }
    p.push(`<text x="${chartX + (v.total / maxTotal) * CHART + 8}" y="${y + ROW / 2 + 4}" `
      + `font-size="11" fill="#374151">${fmtDur(v.total)}</text>`);
  });

  p.push('</svg>');
  return p.join('\n');
}
writeFileSync(join(outDir, 'timing.svg'), buildSvg());

/* ---- HTML (interactive Plotly, self-contained + offline) ---- */
function buildHtml() {
  if (!vids.length) {
    return '<!doctype html><html><head><meta charset="utf-8"></head><body>'
      + '<p>No timing rows yet.</p></body></html>';
  }
  const titlesArr = vids.map((v) => v.title);
  const traces = stageOrder.map((st) => ({
    type: 'bar',
    orientation: 'h',
    name: stageLabel(st),
    y: titlesArr,
    x: vids.map((v) => { const e = v.stages.find(([s]) => s === st); return e ? e[1] : 0; }),
    marker: { color: colorOf.get(st) },
  }));
  const data = JSON.stringify(traces);
  // The title is an HTML <h1> above the chart, not a Plotly title: Plotly anchors the
  // title to the container top and the legend to the plot top, so with a short plot
  // they collide. Reserving pixels here covers only the legend and half a tick label.
  const labelHalf = 8, legendH = 22, gap = 12;
  const topPad = labelHalf + gap + legendH;
  const ROW_H = 34;                                  // fits a two-line wrapped label
  const H = Math.min(4000, Math.max(420, vids.length * ROW_H + topPad + 50));
  const plotH = Math.max(60, H - topPad - 50);
  const layout = JSON.stringify({
    barmode: 'stack',
    hovermode: 'closest',
    xaxis: { title: 'seconds', zeroline: true, gridcolor: '#e5e7eb' },
    yaxis: {
      automargin: true,
      tickmode: 'array',
      ticks: 'outside', ticklen: 16, tickcolor: '#cbd5e1',   // breathing room before the axis
      tickvals: titlesArr,                          // clean titles — hover reads these
      ticktext: titlesArr.map((t) => wrapTitle(t)), // wrapped + HTML-escaped, axis only
    },
    height: H,
    margin: { l: 340, r: 60, t: topPad, b: 50 },
    hoverlabel: { namelength: -1 },
    legend: {
      orientation: 'h', yanchor: 'bottom',
      y: 1 + (labelHalf + gap) / plotH,             // clears the first label's upper half
      x: 0, xanchor: 'left', traceorder: 'normal',
    },
  });
  const bundle = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'plotly-basic.min.js'), 'utf8');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>timing</title>
<style>
  body { margin:0; font-family:system-ui,-apple-system,'Segoe UI',sans-serif; color:#111827; background:#fff; }
  h1 { font-size:17px; font-weight:600; margin:14px 16px 0; }
  #chart { width:100%; }
</style>
</head><body>
<h1>Time per video, by stage</h1>
<div id="chart"></div>
<script>${bundle}</script>
<script>
Plotly.newPlot('chart', ${data}, ${layout}, { displaylogo: false });
</script>
</body></html>`;
}
writeFileSync(join(outDir, 'timing.html'), buildHtml());

console.log(`[timing] ${rows.length} row(s) across ${order.length} video(s)`);
console.log(`[out] ${join(outDir, 'timing.csv')}`);
console.log(`[out] ${join(outDir, 'timing.md')}`);
console.log(`[out] ${join(outDir, 'timing.svg')}`);
console.log(`[out] ${join(outDir, 'timing.html')}`);
