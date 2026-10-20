/* =============================================================================
   timing-chart.js — browser side of the timing audit.

   `tools/timing-report.mjs` sets window.TIMING_DATA and inlines this file (plus
   Plotly) into timing.html, so the page is self-contained and opens with no
   network. Shape of the data:

     { mode: 'flat' | 'grouped',
       stages: [['3', 'script'], …],
       modules: [{ name, display, videos: [{ index, title, stages: { '<stage>': secs } }] }] }

   mode 'flat'    — every video on one stacked-bar chart. Used when the series
                    spans a single module, where grouping would be a pointless
                    extra click.
   mode 'grouped' — one aggregate bar per module (summed across its videos), click
                    a bar to break that module down by video. Used as soon as a
                    series spans more than one module, which is the case that made
                    a single 85-row chart unusable.

   Layout notes, all learned the hard way:
     · the <h1>/<h2> titles are HTML, not Plotly titles — a Plotly title anchors to
       the container while the legend anchors to the plot, so on short charts they
       collide;
     · the legend is placed with yanchor:'bottom' at a pixel offset converted into
       plot fractions, after reserving room for half a tick label;
     · rows are 34px so a two-line wrapped label does not collide with its
       neighbour, and wrapping is capped at two lines;
     · labels are pushed off the axis with `ticks:'outside'` + `ticklen`, since
       cartesian axes have no tick-label padding property.
   ========================================================================== */
(function () {
  const D = window.TIMING_DATA;
  if (!D || !window.Plotly) return;

  const STAGES = D.stages || [];
  const COLORS = ['#4f46e5', '#0ea5e9', '#14b8a6', '#f59e0b', '#ef4444', '#8b5cf6',
                  '#ec4899', '#10b981', '#f97316', '#6366f1', '#a855f7', '#22c55e'];
  const stageName = {}, colorOf = {};
  STAGES.forEach(([k, n], i) => { stageName[k] = n; colorOf[k] = COLORS[i % COLORS.length]; });
  const label = (k) => k + ' · ' + (stageName[k] || '');

  const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rev = (a) => a.slice().reverse();
  const round1 = (n) => Math.round(n * 10) / 10;

  function wrap(t, max) {
    const words = escHtml(t).split(/\s+/);
    const lines = []; let cur = '';
    for (const w of words) {
      if (!cur) cur = w;
      else if ((cur + ' ' + w).length <= max) cur += ' ' + w;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    if (lines.length > 2) {                 // cap at two lines so rows stay predictable
      const rest = lines.slice(1).join(' ');
      lines.length = 1;
      lines.push(rest.length > max ? rest.slice(0, max - 1) + '…' : rest);
    }
    return lines.join('<br>');
  }

  function tracesFor(videos) {
    return STAGES.map(([k]) => ({
      type: 'bar', orientation: 'h', name: label(k),
      y: videos.map((v) => v.title),
      x: videos.map((v) => round1(v.stages[k] || 0)),
      marker: { color: colorOf[k] },
      hovertemplate: '%{y}<br>' + label(k) + ': %{x:.1f}s<extra></extra>',
    }));
  }

  function aggTraces(rows) {
    return STAGES.map(([k]) => ({
      type: 'bar', orientation: 'h', name: label(k),
      y: rows.map((r) => r.title),
      x: rows.map((r) => round1(r.stages[k] || 0)),
      customdata: rows.map((r) => r.count),
      marker: { color: colorOf[k] },
      hovertemplate: '%{y}<br>' + label(k) + ': %{x:.1f}s<br>%{customdata} video(s)<extra></extra>',
    }));
  }

  function layoutFor(rows, wrapMax) {
    const legendH = 22, labelHalf = 8, gap = 12;
    const topPad = labelHalf + gap + legendH;
    const b = 40, rowH = 34;
    const h = Math.max(200, rows.length * rowH + topPad + b);
    const plotH = Math.max(48, h - topPad - b);
    return {
      barmode: 'stack', hovermode: 'closest',
      xaxis: { title: { text: 'seconds', font: { size: 11 } }, gridcolor: '#eceff3', zeroline: true },
      yaxis: {
        automargin: true, tickmode: 'array',
        ticks: 'outside', ticklen: 16, tickcolor: '#cbd5e1',
        tickvals: rows.map((r) => r.title),
        ticktext: rows.map((r) => wrap(r.title, wrapMax || 42)),
        tickfont: { size: 11 },
      },
      height: h,
      margin: { l: 0, r: 24, t: topPad, b },
      showlegend: true,
      legend: {
        orientation: 'h', yanchor: 'bottom',
        y: 1 + (labelHalf + gap) / plotH,
        x: 0, xanchor: 'left', traceorder: 'normal', font: { size: 11 },
      },
      hoverlabel: { namelength: -1 },
    };
  }

  const CONFIG = { displaylogo: false, responsive: true };

  function renderFlat() {
    const all = [];
    for (const m of (D.modules || [])) for (const v of (m.videos || [])) all.push(v);
    all.sort((a, b) => a.index - b.index);
    const vs = rev(all);                      // plan order reads top-down
    Plotly.newPlot('timing-chart', tracesFor(vs), layoutFor(vs, 42), CONFIG);
  }

  function renderGrouped() {
    const rows = rev((D.modules || []).map((m) => {
      const stages = {};
      for (const [k] of STAGES) stages[k] = m.videos.reduce((a, v) => a + (v.stages[k] || 0), 0);
      return { title: m.display, stages, count: m.videos.length, videos: m.videos };
    }));
    const el = document.getElementById('timing-chart');
    Plotly.newPlot(el, aggTraces(rows), layoutFor(rows, 30), CONFIG);
    el.on('plotly_click', (e) => {
      const name = e.points[0].y;
      const m = (D.modules || []).find((x) => x.display === name);
      if (m) showDetail(m);
    });
  }

  function showDetail(m) {
    const wrapEl = document.getElementById('timing-detail-wrap');
    if (!wrapEl) return;
    document.getElementById('timing-detail-title').textContent =
      m.display + ' — ' + m.videos.length + ' video' + (m.videos.length === 1 ? '' : 's');
    const vs = rev(m.videos.slice().sort((a, b) => a.index - b.index));
    Plotly.react('timing-detail', tracesFor(vs), layoutFor(vs, 46), CONFIG);
    wrapEl.hidden = false;
    wrapEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const reset = document.getElementById('all-modules');
  if (reset) {
    reset.onclick = (e) => {
      e.preventDefault();
      const w = document.getElementById('timing-detail-wrap');
      if (w) w.hidden = true;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  }

  if (D.mode === 'grouped') renderGrouped(); else renderFlat();
})();
