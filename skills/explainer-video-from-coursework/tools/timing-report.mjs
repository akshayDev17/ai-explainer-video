/* =============================================================================
   timing-report.mjs — render out/<name>/timing.jsonl into four human-readable views.

   Usage:
     node tools/timing-report.mjs --out out/<name> [--flat]

   Reads the append-only ledger (one row per attempt) plus the enriched plan for
   titles, then writes:

     out/<name>/timing.csv   — long format, one row per attempt:
        video_title, stage, attempt, seconds, ended_at, note
     out/<name>/timing.md    — one heading per video title, a stage -> seconds table
                               (attempts summed) with a total.
     out/<name>/timing.svg   — static stacked bars (no-JS fallback; opens anywhere).
     out/<name>/timing.html  — interactive Plotly chart, self-contained and offline:
                               the vendored bundle and src/timing-chart.js are inlined.

   Grouping — the plan already groups videos by module (the first path segment of a
   video's first source), so a series of 85 videos is really ~17 modules. When the
   ledger spans more than one module the HTML and SVG show one aggregate bar per
   module and (HTML only) drill into a module's videos on click; with a single module
   grouping would be a pointless extra click, so both render every video instead.
   `--flat` forces the per-video chart regardless.

   All four outputs are derived and regenerable; the ledger is the only source of
   truth. The stage dimension is a *value*, never a column or a hardcoded colour, so
   adding/removing/merging stages changes the legend — not the drawing code.
   ========================================================================== */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const outDir = flag('out');
if (!outDir) { console.error('usage: node tools/timing-report.mjs --out <seriesDir> [--flat]'); process.exit(1); }
const forceFlat = argv.includes('--flat');

const ledgerPath = join(outDir, 'timing.jsonl');
const planPath = join(outDir, 'plan.enriched.json');
const here = dirname(fileURLToPath(import.meta.url));

const rows = existsSync(ledgerPath)
  ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
  : [];

const titles = {};
const planModule = {};
if (existsSync(planPath)) {
  try {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    for (const v of (plan.videos || [])) {
      if (v.index == null) continue;
      titles[String(v.index)] = v.title;
      planModule[String(v.index)] = v.group || ((v.sources && v.sources[0]) || '').split('/')[0];   // a code-flow plan groups by flow
    }
  } catch { /* plan unreadable — fall back to the raw key and a single module */ }
}
const titleOf = (video) => titles[video] || video;
const round1 = (n) => String(Math.round(n * 10) / 10);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtDur = (n) => n < 60 ? `${round1(n)}s` : `${Math.floor(n / 60)}m${Math.round(n % 60)}s`;

const STAGE_NAMES = { '3': 'script', '4': 'audio', '4b': 'align', '5': 'scene', '6': 'publish', '7': 'render', '8': 'assemble' };
const PALETTE = ['#4f46e5', '#0ea5e9', '#14b8a6', '#f59e0b', '#ef4444', '#8b5cf6',
                 '#ec4899', '#10b981', '#f97316', '#6366f1', '#a855f7', '#22c55e'];

/* Module display names: "09-tool-platforms-mcp" → "Tool Platforms MCP". */
const ACRONYM = { mcp: 'MCP', llm: 'LLM', llms: 'LLMs', llmops: 'LLMOps', adk: 'ADK', api: 'API', rag: 'RAG', gcp: 'GCP', ui: 'UI' };
const displayName = (mod) => {
  const s = String(mod || '').replace(/^\d+[-_]/, '');
  if (!s) return '(ungrouped)';
  return s.split(/[-_]/).filter(Boolean)
    .map((w) => ACRONYM[w.toLowerCase()] || (w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
};

const order = [...new Set(rows.map((r) => r.video))];
order.sort((a, b) => {
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
});

/* Per video: its stages (attempts summed), total, and plan index. */
const vids = order.map((video) => {
  const byStage = new Map();
  for (const r of rows) {
    if (r.video !== video) continue;
    const e = byStage.get(r.stage) || { s: 0, n: 0 };
    e.s += r.seconds; e.n += 1; byStage.set(r.stage, e);
  }
  const stages = [...byStage.entries()].map(([st, e]) => [st, e.s, e.n]);
  return {
    video, index: parseInt(video, 10),
    title: titleOf(video),
    stages,
    total: stages.reduce((a, [, s]) => a + s, 0),
  };
});

/* Stage order across the whole ledger (first-seen = pipeline order). */
const stageOrder = [];
for (const v of vids) for (const [st] of v.stages) if (!stageOrder.includes(st)) stageOrder.push(st);
const colorOf = new Map(stageOrder.map((st, i) => [st, PALETTE[i % PALETTE.length]]));
const stageLabel = (st) => STAGE_NAMES[st] ? `${st} · ${STAGE_NAMES[st]}` : st;

/* Group by module. A video with no plan entry lands in '(ungrouped)'. */
const byModule = new Map();
for (const v of vids) {
  const mod = planModule[v.video] || '';
  if (!byModule.has(mod)) byModule.set(mod, []);
  byModule.get(mod).push(v);
}
const modules = [...byModule.entries()]
  .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
  .map(([name, videos]) => ({ name, display: displayName(name), videos }));

const mode = (forceFlat || modules.length <= 1) ? 'flat' : 'grouped';
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
function stageTotals(videos) {
  const byStage = new Map();
  for (const v of videos) {
    for (const [st, sec, n] of v.stages) {
      const e = byStage.get(st) || { s: 0, n: 0 };
      e.s += sec; e.n += n; byStage.set(st, e);
    }
  }
  const stages = [...byStage.entries()].map(([st, e]) => [st, e.s, e.n]);
  return { stages, total: stages.reduce((a, [, s]) => a + s, 0) };
}

function buildSvg(list, title) {
  const L = 20, LABEL = 360, GAP = 12, CHART = 560, RAXIS = 64, R = 16;
  const WIDTH = L + LABEL + GAP + CHART + RAXIS + R;
  const ROW = 26, ROWGAP = 10;
  const TITLE_H = 30, LEGEND_H = 22, AXIS_H = 26;
  const max = Math.max(1, ...list.map((x) => x.total));

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
  const axisTop = rowsTop + list.length * (ROW + ROWGAP);
  const HEIGHT = axisTop + AXIS_H + 16;
  const chartX = L + LABEL + GAP;

  const p = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" `
    + `viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">`);
  p.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  p.push(`<text x="${L}" y="${top + 18}" font-size="18" font-weight="600" fill="#111827">${esc(title)}</text>`);

  if (!list.length) {
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
      + `${fmtDur(max * i / ticks)}</text>`);
  }

  list.forEach((v, i) => {
    const y = rowsTop + i * (ROW + ROWGAP);
    const label = v.title.length > 52 ? v.title.slice(0, 51) + '…' : v.title;
    p.push(`<text x="${L}" y="${y + ROW / 2 + 4}" font-size="12" fill="#111827">${esc(label)}</text>`);
    let bx = chartX;
    for (const [st, sec, attempts] of v.stages) {
      const w = (sec / max) * CHART;
      const tip = `${esc(v.title)} — ${esc(stageLabel(st))}: ${round1(sec)}s${attempts > 1 ? ' (' + attempts + ' attempts)' : ''}`;
      p.push(`<rect x="${bx}" y="${y}" width="${w}" height="${ROW}" rx="2" fill="${colorOf.get(st)}">`
        + `<title>${tip}</title></rect>`);
      bx += w;
    }
    p.push(`<text x="${chartX + (v.total / max) * CHART + 8}" y="${y + ROW / 2 + 4}" `
      + `font-size="11" fill="#374151">${fmtDur(v.total)}</text>`);
  });

  p.push('</svg>');
  return p.join('\n');
}

const svgList = mode === 'grouped'
  ? modules.map((m) => ({ title: m.display, ...stageTotals(m.videos) }))
  : vids.map((v) => ({ title: v.title, stages: v.stages, total: v.total }));
const svgTitle = mode === 'grouped' ? 'Time per module, by stage' : 'Time per video, by stage';
writeFileSync(join(outDir, 'timing.svg'), buildSvg(svgList, svgTitle));

/* ---- HTML (interactive Plotly, self-contained + offline) ---- */
function buildHtml() {
  if (!vids.length) {
    return '<!doctype html><html><head><meta charset="utf-8"></head>'
      + '<body style="font-family:system-ui,sans-serif"><p>No timing rows yet.</p></body></html>';
  }
  const vendor = readFileSync(join(here, '..', 'vendor', 'plotly-basic.min.js'), 'utf8');
  const chartJs = readFileSync(join(here, '..', 'src', 'timing-chart.js'), 'utf8');

  const htmlModules = modules.map((m) => ({
    name: m.name,
    display: m.display,
    videos: m.videos.map((v) => ({
      index: v.index,
      title: v.title,
      stages: Object.fromEntries(v.stages.map(([st, sec]) => [st, sec])),
    })),
  }));
  // escaping "</" keeps a title containing "</script>" from closing the tag
  const data = JSON.stringify({ mode, stages: stageOrder.map((k) => [k, STAGE_NAMES[k] || '']), modules: htmlModules })
    .replace(/<\//g, '<\\/');

  const body = mode === 'grouped'
    ? `<h1>Time per module</h1>
<div id="timing-chart"></div>
<p class="hint">Click a module bar to break it down by video.</p>
<div id="timing-detail-wrap" hidden>
  <h2 id="timing-detail-title"></h2>
  <p class="hint"><a href="#" id="all-modules">&uarr; all modules</a></p>
  <div id="timing-detail"></div>
</div>`
    : `<h1>Time per video, by stage</h1>
<div id="timing-chart"></div>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>timing audit</title>
<style>
  body { margin:0; padding:0 16px 40px; background:#fff; color:#111827;
         font-family:system-ui,-apple-system,'Segoe UI',sans-serif; }
  #timing-chart, #timing-detail { width:100%; }
  h1 { font-size:17px; font-weight:600; margin:14px 0 0; }
  h2 { font-size:15px; font-weight:600; margin:22px 0 0; }
  .hint { font-size:11px; color:#6b7280; margin:6px 0 0; }
  .hint a { color:#4f46e5; text-decoration:none; }
  .hint a:hover { text-decoration:underline; }
</style>
</head><body>
${body}
<script>${vendor}</script>
<script>window.TIMING_DATA = ${data};</script>
<script>${chartJs}</script>
</body></html>`;
}
writeFileSync(join(outDir, 'timing.html'), buildHtml());

console.log(`[timing] ${rows.length} row(s) · ${order.length} video(s) · ${modules.length} module(s) · ${mode}`);
console.log(`[out] ${join(outDir, 'timing.csv')}`);
console.log(`[out] ${join(outDir, 'timing.md')}`);
console.log(`[out] ${join(outDir, 'timing.svg')}`);
console.log(`[out] ${join(outDir, 'timing.html')}`);
