/* =============================================================================
   scene-core.js — generic animated-diagram interpreter.

   Consumes a declarative scene config and renders it. The animation is a PURE
   FUNCTION of time: nothing accumulates between frames, so frames may be
   rendered in any order, in parallel, or re-rendered after an edit.

   Contract with the host page:
     window.SceneCore.createScene({ svg, config, timeline }) -> { renderAt(t) }

   The config vocabulary is deliberately small:
     layout   columns + rows (the grid nodes sit on)
     nodes    groups of nodes by kind (client | server | hub)
     edges    connections between node groups / nodes
     flows    packets travelling routes, with rotation + exclusion rules
     pings    health-check probes along edges
     rules    time windows that change node/edge state
     banners  transient pills / glyphs (badges, question marks)
     overlays title card, header, stage badge, progress, cards, closing line
   ========================================================================== */
(function () {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';

  /* ---------------- pure math ---------------- */
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, p) => a + (b - a) * p;
  const seg = (t, a, b) => clamp01((t - a) / (b - a || 1e-6));
  const easeOut = p => 1 - Math.pow(1 - p, 3);
  const easeIO = p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const backOut = p => { const c = 1.70158, c3 = c + 1; return 1 + c3 * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };
  const fadeIn = (t, a, b) => easeOut(seg(t, a, b));
  const fadeOut = (t, a, b) => 1 - easeIO(seg(t, a, b));
  const win = (t, a, b, r) => clamp01((t - (a - r)) / r) * clamp01(((b + r) - t) / r);
  const inWindow = (t, r) => t >= r.from && t < (r.until == null ? Infinity : r.until);

  /* ---------------- svg helpers ---------------- */
  function el(tag, attrs, parent) {
    const n = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function txt(x, y, str, attrs, parent) {
    const n = el('text', Object.assign({ x: x, y: y }, attrs || {}), parent);
    n.textContent = str;
    return n;
  }
  const set = (node, attrs) => { for (const k in attrs) node.setAttribute(k, attrs[k]); };
  const curve = (x1, y1, x2, y2, bend) => {
    const dx = (x2 - x1) * (bend == null ? 0.5 : bend);
    return 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + dx) + ' ' + y1 + ', ' + (x2 - dx) + ' ' + y2 + ', ' + x2 + ' ' + y2;
  };

  const DEFAULT_PALETTE = {
    bg1: '#080e1a', bg2: '#0e1728', grid: '#182742', gridSoft: '#111d33',
    client: '#38bdf8', clientFill: '#0b2133',
    hub: '#fbbf24', hubFill: '#2a1e07',
    ok: '#34d399', okFill: '#07251d',
    bad: '#fb7185', badFill: '#2c0f17',
    text: '#e8eefc', muted: '#93a7c8', bad2: '#5d6f8c', hair: '#22334f',
  };

  const BANNER_BG = { bad: '#2c0f17', ok: '#07251d', hub: '#2a1e07', client: '#0b2133', muted: '#111d33', text: '#111d33' };

  const KIND_DEFAULTS = {
    client: { w: 150, h: 92, accent: 'client', fill: 'clientFill' },
    server: { w: 190, h: 118, accent: 'ok', fill: 'okFill' },
    hub: { w: 252, h: 172, accent: 'hub', fill: 'hubFill' },
    // Generic UML-ish class box: name, optional «stereotype», divider, members.
    // Height is derived from the member count unless an explicit size is given.
    box: { w: 470, h: 132, accent: 'client', fill: 'clientFill' },
  };

  /* ---------------- factory ---------------- */
  /**
   * Resolve "scene@offset" strings to absolute seconds, recursively.
   *
   * Beats are expressed RELATIVE to a scene start (e.g. "problem@4.6") so the
   * choreography stays locked to the narration. Hardcoded absolute seconds
   * silently drift the moment the audio is re-recorded with different pacing.
   */
  function deepResolve(value, scenes) {
    if (typeof value === 'string') {
      const m = /^([a-z][a-z0-9-]*)@(-?[0-9.]+)$/.exec(value);
      if (m && scenes[m[1]]) return +(scenes[m[1]].start + parseFloat(m[2])).toFixed(4);
      return value;
    }
    if (Array.isArray(value)) return value.map(v => deepResolve(v, scenes));
    if (value && typeof value === 'object') {
      const out = {};
      for (const k in value) out[k] = deepResolve(value[k], scenes);
      return out;
    }
    return value;
  }

  function createScene(opts) {
    const svg = opts.svg;
    const TL = opts.timeline;
    const scenes = TL.scenes;
    const cfg = deepResolve(opts.config, scenes);
    const P = Object.assign({}, DEFAULT_PALETTE, cfg.palette || {});
    const W = (cfg.meta && cfg.meta.width) || TL.width;
    const H = (cfg.meta && cfg.meta.height) || TL.height;

    /* ---- defs ---- */
    const defs = el('defs', {}, svg);
    const bgGrad = el('linearGradient', { id: 'bgGrad', x1: '0', y1: '0', x2: '0', y2: '1' }, defs);
    el('stop', { offset: '0%', 'stop-color': P.bg2 }, bgGrad);
    el('stop', { offset: '100%', 'stop-color': P.bg1 }, bgGrad);
    const mkGlow = (id, dev) => {
      const f = el('filter', { id: id, x: '-120%', y: '-120%', width: '340%', height: '340%' }, defs);
      el('feGaussianBlur', { stdDeviation: dev, result: 'b' }, f);
      const m = el('feMerge', {}, f);
      el('feMergeNode', { in: 'b' }, m);
      el('feMergeNode', { in: 'SourceGraphic' }, m);
    };
    // one arrow marker per palette colour (context-stroke is not universally safe)
    const ARROW_IDS = {};
    ['client', 'ok', 'hub', 'bad', 'bad2', 'muted', 'text'].forEach(k => {
      const id = 'arrow-' + k;
      const m = el('marker', { id: id, viewBox: '0 0 10 10', refX: '9', refY: '5',
        markerWidth: '6', markerHeight: '6', orient: 'auto' }, defs);
      el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: P[k] }, m);
      ARROW_IDS[k] = id;
    });
    mkGlow('softGlow', '14');
    mkGlow('glow', '6');

    el('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#bgGrad)' }, svg);
    const grid = el('g', { opacity: 0.5 }, svg);
    for (let x = 0; x <= W; x += 60) el('line', { x1: x, y1: 0, x2: x, y2: H, stroke: x % 300 === 0 ? P.grid : P.gridSoft, 'stroke-width': 1 }, grid);
    for (let y = 0; y <= H; y += 60) el('line', { x1: 0, y1: y, x2: W, y2: y, stroke: y % 300 === 0 ? P.grid : P.gridSoft, 'stroke-width': 1 }, grid);

    const world = el('g', {}, svg);
    const edgesG = el('g', {}, world);
    const pingG = el('g', {}, world);
    const packetG = el('g', {}, world);
    const nodesG = el('g', {}, world);
    const fxG = el('g', {}, world);
    const chromeG = el('g', {}, svg);
    const overlayG = el('g', {}, svg);

    /* ---- resolve layout ---- */
    const rows = cfg.layout.rows;
    const colX = id => cfg.layout.columns[id].x;
    const colY = (id, row) => (cfg.layout.columns[id].y != null ? cfg.layout.columns[id].y : rows[row]);

    /* ---- instantiate nodes ---- */
    const nodes = {};      // id -> instance
    const groups = {};     // groupId -> [ids]

    (cfg.nodes || []).forEach(nd => {
      const kind = nd.kind;
      const kd = Object.assign({}, KIND_DEFAULTS[kind] || {}, nd.size || {});
      if (kind === 'box' && !nd.size) {
        kd.h = 76 + ((nd.members || []).length) * 28 + (nd.stereotype ? 22 : 0);
      }
      const rowsList = nd.rows || [nd.row == null ? 0 : nd.row];
      // A single-row node keeps its own id ("hub"); multi-row nodes get suffixes
      // ("clients#0"). Otherwise rules/edges that reference the bare id never match.
      const ids = nd.ids || (rowsList.length === 1 ? [nd.id] : rowsList.map((r, i) => nd.id + '#' + i));
      groups[nd.id] = ids;
      rowsList.forEach((row, i) => {
        const id = ids[i];
        const x = nd.x != null ? nd.x : colX(nd.column);
        const y = nd.y != null ? nd.y : colY(nd.column, row);
        const accent = P[nd.accent || kd.accent];
        const fill = P[nd.fill || kd.fill];
        const g = el('g', { opacity: 0 }, nodesG);
        const inst = { id: id, kind: kind, x: x, y: y, g: g, w: kd.w, h: kd.h, accent: accent, fill: fill, label: (nd.labels && nd.labels[i]) || nd.label || id, sub: nd.sub };

        // halo (arrival glow)
        inst.halo = el('rect', { x: x - kd.w / 2 - 10, y: y - kd.h / 2 - 10, width: kd.w + 20, height: kd.h + 20, rx: 24, fill: 'none', stroke: accent, 'stroke-width': 4, opacity: 0, filter: 'url(#softGlow)' }, g);
        inst.rect = el('rect', { x: x - kd.w / 2, y: y - kd.h / 2, width: kd.w, height: kd.h, rx: 18, fill: fill, stroke: accent, 'stroke-width': 2.5 }, g);

        // kind glyph + labels
        const ic = el('g', {}, g);
        inst.ic = ic;
        if (kind === 'client') {
          el('rect', { x: x - 56, y: y - 20, width: 52, height: 40, rx: 6, fill: 'none', stroke: accent, 'stroke-width': 2.5 }, ic);
          el('line', { x1: x - 56, y1: y - 8, x2: x - 4, y2: y - 8, stroke: accent, 'stroke-width': 2.5 }, ic);
          el('circle', { cx: x - 50, cy: y - 14, r: 2.4, fill: accent }, ic);
          el('circle', { cx: x - 42, cy: y - 14, r: 2.4, fill: accent }, ic);
          txt(x + 26, y + 8, nd.label || 'User', { fill: P.text, 'font-size': 23, 'font-weight': 700, 'text-anchor': 'middle' }, g);
          inst.subEl = txt(x, y + kd.h / 2 + 30, (nd.sub || '').replace('{n}', String(i + 1)), { fill: P.muted, 'font-size': 18, 'text-anchor': 'middle' }, g);
        } else if (kind === 'server') {
          inst.bars = [];
          for (let k = 0; k < 3; k++) inst.bars.push(el('rect', { x: x - 34, y: y - 40 + k * 19, width: 60, height: 13, rx: 4, fill: 'none', stroke: accent, 'stroke-width': 2.2 }, ic));
          inst.leds = [];
          for (let k = 0; k < 3; k++) inst.leds.push(el('circle', { cx: x + 38, cy: y - 33.5 + k * 19, r: 3.2, fill: accent }, ic));
          inst.labelEl = txt(x, y + 38, inst.label, { fill: P.text, 'font-size': 24, 'font-weight': 700, 'text-anchor': 'middle' }, g);
          inst.statusEl = txt(x, y + kd.h / 2 + 30, 'healthy', { fill: P.ok, 'font-size': 18, 'font-weight': 600, 'text-anchor': 'middle' }, g);
          // fail marker
          const mark = el('g', { opacity: 0 }, g);
          el('circle', { cx: x + kd.w / 2 - 4, cy: y - kd.h / 2 + 4, r: 20, fill: '#2c0f17', stroke: P.bad, 'stroke-width': 2.5 }, mark);
          el('line', { x1: x + kd.w / 2 - 14, y1: y - kd.h / 2 - 6, x2: x + kd.w / 2 + 6, y2: y - kd.h / 2 + 14, stroke: P.bad, 'stroke-width': 3.6, 'stroke-linecap': 'round' }, mark);
          el('line', { x1: x + kd.w / 2 + 6, y1: y - kd.h / 2 - 6, x2: x + kd.w / 2 - 14, y2: y - kd.h / 2 + 14, stroke: P.bad, 'stroke-width': 3.6, 'stroke-linecap': 'round' }, mark);
          inst.mark = mark;
          // queue chips
          inst.queue = [];
          for (let k = 0; k < (nd.queue || 6); k++) inst.queue.push(el('rect', { x: x - kd.w / 2 - 42, y: y + 46 - k * 19, width: 26, height: 13, rx: 3.5, fill: P.bad, opacity: 0 }, g));
          inst.queueLabel = txt(x - kd.w / 2 - 29, y + 78, '', { fill: P.bad, 'font-size': 15, 'font-weight': 700, 'text-anchor': 'middle' }, g);
        } else if (kind === 'hub') {
          el('circle', { cx: x - 58, cy: y - 28, r: 6.5, fill: accent }, ic);
          for (let k = -1; k <= 1; k++) {
            const ty = y - 28 + k * 30;
            el('path', { d: 'M ' + (x - 46) + ' ' + (y - 28) + ' C ' + (x - 16) + ' ' + (y - 28) + ', ' + (x - 16) + ' ' + ty + ', ' + (x + 14) + ' ' + ty, fill: 'none', stroke: accent, 'stroke-width': 2.6, 'stroke-linecap': 'round' }, ic);
            el('circle', { cx: x + 20, cy: ty, r: 5.2, fill: accent }, ic);
          }
          inst.labelEl = txt(x, y + 44, nd.label || '', { fill: P.text, 'font-size': 26, 'font-weight': 700, 'text-anchor': 'middle' }, g);
          inst.subEl = txt(x, y - kd.h / 2 - 20, nd.sub || '', { fill: P.muted, 'font-size': 17, 'text-anchor': 'middle' }, g);
        } else if (kind === 'box') {
          const hasStereo = !!nd.stereotype;
          if (hasStereo) {
            txt(x, y - kd.h / 2 + 28, nd.stereotype, { fill: P.muted, 'font-size': 16, 'font-style': 'italic', 'text-anchor': 'middle' }, g);
          }
          const nameY = y - kd.h / 2 + (hasStereo ? 58 : 40);
          inst.labelEl = txt(x, nameY, inst.label, { fill: P.text, 'font-size': 27, 'font-weight': 700, 'text-anchor': 'middle' }, g);
          const divY = nameY + 15;
          el('line', { x1: x - kd.w / 2 + 16, y1: divY, x2: x + kd.w / 2 - 16, y2: divY, stroke: accent, 'stroke-width': 1.5, opacity: 0.45 }, g);
          inst.memberEls = (nd.members || []).map((m, k) =>
            txt(x - kd.w / 2 + 24, divY + 30 + k * 28, m,
              { fill: P.muted, 'font-size': 21, 'font-family': 'SF Mono, Menlo, Consolas, monospace' }, g));
          if (nd.sub) inst.subEl = txt(x, y + kd.h / 2 + 32, nd.sub, { fill: P.muted, 'font-size': 19, 'text-anchor': 'middle' }, g);
          // fail marker — same affordance servers have, so rules.failMarker works
          // for class diagrams too (the LSP "broken Penguin" beat depends on it)
          const bx = x + kd.w / 2, by = y - kd.h / 2;
          const mark = el('g', { opacity: 0 }, g);
          el('circle', { cx: bx - 4, cy: by + 4, r: 20, fill: '#2c0f17', stroke: P.bad, 'stroke-width': 2.5 }, mark);
          el('line', { x1: bx - 14, y1: by - 6, x2: bx + 6, y2: by + 14, stroke: P.bad, 'stroke-width': 3.6, 'stroke-linecap': 'round' }, mark);
          el('line', { x1: bx + 6, y1: by - 6, x2: bx - 14, y2: by + 14, stroke: P.bad, 'stroke-width': 3.6, 'stroke-linecap': 'round' }, mark);
          inst.mark = mark;
        }
        nodes[id] = inst;
      });
    });

    const expand = ref => (groups[ref] ? groups[ref].slice() : [ref]);

    /* ---- instantiate edges ---- */
    const edges = [];   // {id, fromId, toId, el, len}
    function addEdges(spec) {
      const fromIds = expand(spec.from);
      const toIds = expand(spec.to);
      const bend = spec.bend == null ? 0.5 : spec.bend;
      fromIds.forEach(f => {
        toIds.forEach(t => {
          const a = nodes[f], b = nodes[t];
          if (!a || !b) return;
          const ax = a.x + (a.w / 2) * (b.x > a.x ? 1 : -1);
          const bx = b.x - (b.w / 2) * (b.x > a.x ? 1 : -1);
          const p = el('path', { d: curve(ax, a.y, bx, b.y, bend), fill: 'none', stroke: P[spec.color || 'ok'], 'stroke-width': spec.width || 3, 'stroke-linecap': 'round', opacity: 0 }, edgesG);
          if (spec.arrow) p.setAttribute('marker-end', 'url(#' + (ARROW_IDS[spec.color || 'ok'] || ARROW_IDS.ok) + ')');
          edges.push({ id: spec.id, fromId: f, toId: t, el: p, len: 0, key: spec.id + ':' + f + '>' + t, spec: spec });
        });
      });
    }
    (cfg.edges || []).forEach(addEdges);

    const edgeFor = (id, fromId, toId) => edges.find(e => e.id === id && (!fromId || e.fromId === fromId) && (!toId || e.toId === toId));
    const edgesOf = id => edges.filter(e => e.id === id);
    const geo = e => { if (!e.len) e.len = e.el.getTotalLength(); return e.len; };
    const pointOn = (e, u) => { const L = geo(e); const p = e.el.getPointAtLength(L * clamp01(u)); return { x: p.x, y: p.y }; };

    /* ---- fx primitives ---- */
    const banners = (cfg.banners || []).map(b => {
      const g = el('g', { opacity: 0 }, fxG);
      if (b.type === 'pill') {
        const col = P[b.color || 'bad'];
        const bg = BANNER_BG[b.color || 'bad'] || '#2c0f17';
        // width follows the text so short notes do not sit in a huge pill
        const wpx = b.width || Math.max(180, Math.round(b.text.length * 11.5) + 56);
        const hpx = b.size || 46;
        el('rect', { x: -wpx / 2, y: -hpx / 2, width: wpx, height: hpx, rx: hpx / 2, fill: bg, stroke: col, 'stroke-width': 2 }, g);
        txt(0, b.size ? 8 : 7, b.text, { fill: col, 'font-size': b.fontSize || 21, 'font-weight': 700, 'text-anchor': 'middle', 'letter-spacing': b.tracking == null ? 0.4 : b.tracking }, g);
      } else {
        txt(0, 0, b.text, { fill: P[b.color || 'hub'], 'font-size': b.size || 156, 'font-weight': 800, 'text-anchor': 'middle', filter: 'url(#glow)' }, g);
      }
      return { spec: b, el: g };
    });

    // arrival rings + served counters per node that appears as a flow target
    const targetIds = new Set();
    (cfg.flows || []).forEach(f => (f.targets || []).forEach(t => targetIds.add(t)));

    const rings = {}, counters = {};
    Array.from(targetIds).forEach(id => {
      const n = nodes[id]; if (!n) return;
      rings[id] = el('circle', { cx: n.x, cy: n.y, r: 58, fill: 'none', stroke: P.ok, 'stroke-width': 3, opacity: 0 }, fxG);
      if (cfg.overlays && cfg.overlays.counters !== false) {
        counters[id] = txt(n.x + n.w / 2 + 40, n.y + 9, '0', { fill: P.ok, 'font-size': 27, 'font-weight': 800, 'text-anchor': 'start', opacity: 0 }, fxG);
      }
    });

    // pools
    const POOL = cfg.poolSize || 44;
    const packets = [];
    for (let i = 0; i < POOL; i++) packets.push(el('circle', { cx: -200, cy: -200, r: 7.5, fill: P.client, opacity: 0 }, packetG));
    const PINGPOOL = cfg.pingPoolSize || 20;
    const pingDots = [];
    for (let i = 0; i < PINGPOOL; i++) pingDots.push(el('circle', { cx: -200, cy: -200, r: 4.8, fill: P.client, opacity: 0 }, pingG));

    /* ---- chrome ---- */
    const OV = cfg.overlays || {};
    let header = null, stageBadge = null, stageText = null, stageRect = null, progBar = null, titleCard = null, cardsG = null, cardEls = [], finalG = null;
    const headerFade = OV.headerFrom != null ? [OV.headerFrom, OV.headerFrom + 1.0] : null;

    if (OV.header !== false) {
      header = el('g', { opacity: 0 }, chromeG);
      el('circle', { cx: 74, cy: 62, r: 9, fill: P.hub }, header);
      txt(96, 70, OV.headerText || '', { fill: P.text, 'font-size': 25, 'font-weight': 700 }, header);
    }
    if (OV.stageBadge !== false) {
      stageBadge = el('g', { opacity: 0 }, chromeG);
      // Width is only a default: the pill re-measures and re-centres itself for each
      // stage name (see the render loop), so a long label widens the pill instead of
      // spilling out of it. The right edge stays pinned at W - 74.
      stageRect = el('rect', { x: W - 366, y: 38, width: 292, height: 50, rx: 25, fill: '#0f1c31', stroke: P.hair, 'stroke-width': 1.5 }, stageBadge);
      stageText = txt(W - 220, 70, '', { fill: P.hub, 'font-size': 22, 'font-weight': 700, 'text-anchor': 'middle', 'letter-spacing': '0.8' }, stageBadge);
    }
    if (OV.progress !== false) {
      el('rect', { x: 0, y: H - 6, width: W, height: 6, fill: '#0d1728' }, chromeG);
      progBar = el('rect', { x: 0, y: H - 6, width: 0, height: 6, fill: P.hub, opacity: 0.85 }, chromeG);
    }

    const ovG = el('g', {}, overlayG);
    if (OV.title) {
      titleCard = el('g', { opacity: 0 }, ovG);
      txt(W / 2, OV.title.y || 452, OV.title.text, { fill: P.text, 'font-size': OV.title.size || 96, 'font-weight': 800, 'text-anchor': 'middle', 'letter-spacing': '-1.5' }, titleCard);
      if (OV.title.sub) txt(W / 2, (OV.title.y || 452) + 70, OV.title.sub, { fill: P.muted, 'font-size': 31, 'text-anchor': 'middle' }, titleCard);
      const rule = el('rect', { x: W / 2, y: (OV.title.y || 452) + 112, width: 0, height: 4, rx: 2, fill: P.hub }, titleCard);
      titleCard._rule = rule;
      // miniature teaser diagram
      if (OV.title.teaser) {
        const t = el('g', { opacity: 0.95 }, titleCard);
        const cy = OV.title.teaserY || 700;
        for (let k = -1; k <= 1; k++) {
          el('circle', { cx: W / 2 - 300, cy: cy + k * 46, r: 11, fill: 'none', stroke: P.client, 'stroke-width': 2.6 }, t);
          el('circle', { cx: W / 2 + 300, cy: cy + k * 46, r: 11, fill: 'none', stroke: P.ok, 'stroke-width': 2.6 }, t);
          el('path', { d: 'M ' + (W / 2 - 288) + ' ' + (cy + k * 46) + ' C ' + (W / 2 - 140) + ' ' + (cy + k * 46) + ', ' + (W / 2 - 140) + ' ' + cy + ', ' + (W / 2 - 30) + ' ' + cy, fill: 'none', stroke: P.client, 'stroke-width': 2, opacity: 0.45 }, t);
          el('path', { d: 'M ' + (W / 2 + 30) + ' ' + cy + ' C ' + (W / 2 + 140) + ' ' + cy + ', ' + (W / 2 + 140) + ' ' + (cy + k * 46) + ', ' + (W / 2 + 288) + ' ' + (cy + k * 46), fill: 'none', stroke: P.ok, 'stroke-width': 2, opacity: 0.45 }, t);
        }
        el('rect', { x: W / 2 - 28, y: cy - 16, width: 56, height: 32, rx: 9, fill: P.hubFill, stroke: P.hub, 'stroke-width': 2.4 }, t);
      }
    }
    if (OV.cards) {
      cardsG = el('g', { opacity: 0 }, ovG);
      OV.cards.items.forEach((it, i) => {
        const cx = W / 2 + (i - (OV.cards.items.length - 1) / 2) * (OV.cards.spacing || 470);
        const cy = OV.cards.y || 560;
        const g = el('g', { opacity: 0 }, cardsG);
        const col = P[it.color || 'client'];
        el('rect', { x: cx - 205, y: cy - 100, width: 410, height: 200, rx: 22, fill: '#0d1a2e', stroke: col, 'stroke-width': 2.5 }, g);
        el('circle', { cx: cx, cy: cy - 34, r: 26, fill: 'none', stroke: col, 'stroke-width': 3 }, g);
        txt(cx, cy - 25, String(i + 1), { fill: col, 'font-size': 28, 'font-weight': 800, 'text-anchor': 'middle' }, g);
        txt(cx, cy + 30, it.label, { fill: P.text, 'font-size': 29, 'font-weight': 700, 'text-anchor': 'middle' }, g);
        if (it.sub) txt(cx, cy + 68, it.sub, { fill: P.muted, 'font-size': 20, 'text-anchor': 'middle' }, g);
        cardEls.push(g);
      });
    }
    let chipsG = null, chipEls = [], codaEl = null;
    if (OV.chips) {
      chipsG = el('g', { opacity: 0 }, ovG);
      const items = OV.chips.items || [];
      const gap = OV.chips.gap == null ? 22 : OV.chips.gap;
      const widths = items.map(t => Math.max(150, Math.round(t.length * 12.5) + 46));
      const totalW = widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1);
      let cx = W / 2 - totalW / 2;
      items.forEach((label, i) => {
        const wpx = widths[i], y = OV.chips.y || 560;
        const g = el('g', { opacity: 0 }, chipsG);
        el('rect', { x: cx, y: y - 30, width: wpx, height: 60, rx: 30,
          fill: P[OV.chips.color || 'client'] === P.client ? '#0b2133' : '#111d33',
          stroke: P[OV.chips.color || 'client'], 'stroke-width': 2 }, g);
        txt(cx + wpx / 2, y + 9, label, { fill: P.text, 'font-size': 22, 'font-weight': 600, 'text-anchor': 'middle' }, g);
        chipEls.push({ el: g, order: i });
        cx += wpx + gap;
      });
      if (OV.chips.coda) {
        codaEl = txt(W / 2, OV.chips.codaY || (OV.chips.y || 560) + 150, OV.chips.coda,
          { fill: P.hub, 'font-size': 40, 'font-weight': 800, 'text-anchor': 'middle', opacity: 0 }, ovG);
      }
    }

    if (OV.finalLine) {
      finalG = el('g', { opacity: 0 }, ovG);
      txt(W / 2, OV.finalLine.y || 508, OV.finalLine.big, { fill: P.text, 'font-size': OV.finalLine.size || 84, 'font-weight': 800, 'text-anchor': 'middle' }, finalG);
      if (OV.finalLine.small) txt(W / 2, (OV.finalLine.y || 508) + 72, OV.finalLine.small, { fill: P.hub, 'font-size': 30, 'font-weight': 700, 'text-anchor': 'middle', 'letter-spacing': '1.2' }, finalG);
    }

    /* =========================================================================
       Rules resolution
       ========================================================================= */
    const R = cfg.rules || {};
    // Only nodes named in a state rule get state colouring. Without this, clients
    // and hubs inherit "healthy green" and lose their own accent colour.
    const stateful = new Set((R.nodeStates || []).map(r => r.target));
    const stateAt = (nodeId, t) => {
      const list = R.nodeStates || [];
      let cur = null;
      for (const r of list) if (r.target === nodeId && inWindow(t, r)) cur = r;
      return cur;
    };
    const activeRule = (key, nodeId, t) => {
      const list = R[key] || [];
      let hit = null;
      for (const r of list) if (r.target === nodeId && inWindow(t, r)) hit = r;
      return hit;
    };
    const edgeDisabled = (e, t) =>
      (R.edgeDisable || []).some(r => r.id === e.id && r.toId === e.toId && inWindow(t, r));

    /* =========================================================================
       Flows
       ========================================================================= */
    function flowPackets(flow, t) {
      const out = [];
      const interval = flow.interval, travel = flow.travel;
      const until = flow.until == null ? Infinity : flow.until;
      const maxK = flow.maxPackets || 260;
      for (let k = 0; k < maxK; k++) {
        const T = flow.from + k * interval;
        if (T > until) break;
        if (T > t + 0.001) break;
        const p = (t - T) / travel;
        if (p < -0.05 || p > 1.3) continue;
        let ti;
        if (flow.strategy === 'rotate') {
          const targets = (flow.targets || []).filter(id => !(flow.exclude || []).some(r => r.target === id && T >= r.from && T < r.until));
          const order = targets.length ? targets : (flow.targets || []);
          ti = order[k % order.length];
        } else {
          ti = (flow.targets || [])[0];
        }
        const srcs = expand(flow.source);
        const si = srcs[k % srcs.length];
        out.push({ flow: flow, k: k, T: T, p: p, si: si, ti: ti, visible: p >= 0 && p <= 1 });
      }
      return out;
    }

    function allPackets(t) {
      let out = [];
      (cfg.flows || []).forEach(f => { out = out.concat(flowPackets(f, t)); });
      return out;
    }

    function servedCounts(t) {
      const counts = {};
      Array.from(targetIds).forEach(id => (counts[id] = 0));
      (cfg.flows || []).forEach(flow => {
        if (flow.count === false) return;
        const until = flow.until == null ? Infinity : flow.until;
        for (let k = 0; k < (flow.maxPackets || 260); k++) {
          const T = flow.from + k * flow.interval;
          if (T > until || T > t) break;
          if (t < T + flow.travel) continue;
          let ti;
          if (flow.strategy === 'rotate') {
            const targets = (flow.targets || []).filter(id => !(flow.exclude || []).some(r => r.target === id && T >= r.from && T < r.until));
            const order = targets.length ? targets : (flow.targets || []);
            ti = order[k % order.length];
          } else ti = (flow.targets || [])[0];
          if (counts[ti] != null) counts[ti]++;
        }
      });
      return counts;
    }

    /* =========================================================================
       render(t)
       ========================================================================= */
    let prevStage = null;

    function render(t) {
      const pk = allPackets(t);

      // arrival glow per target
      const ARR = {};
      pk.forEach(q => {
        const key = q.flow.route === 'via-hub' ? q.ti : q.ti;
        const age = t - (q.T + q.flow.travel);
        if (age >= 0 && age < 1.15) ARR[key] = Math.max(ARR[key] || 0, 1 - age / 1.15);
      });

      // world dimming during a designated scene
      const dim = OV.dimDuring ? OV.dimDuring : null;
      let outroMix = 0;
      if (dim && scenes[dim]) outroMix = easeIO(seg(t, scenes[dim].start + (OV.dimDelay || 0.35), scenes[dim].start + (OV.dimDelay || 0.35) + 1.15));
      set(world, { opacity: (1 - (OV.dimAmount == null ? 0.84 : OV.dimAmount) * outroMix).toFixed(3) });
      set(grid, { opacity: (0.5 * (1 - 0.6 * outroMix)).toFixed(3) });

      // ---- nodes ----
      for (const id in nodes) {
        const n = nodes[id];
        const rev = (cfg.reveal || {})[id];
        let op = 1;
        if (rev) op = fadeIn(t, rev[0], rev[1]);
        // nodes can also retire — a "before" box dissolving as its replacement appears
        const hid = (cfg.hide || {})[id];
        if (hid) op *= fadeOut(t, hid[0], hid[1]);
        const st = stateAt(id, t);
        const state = st ? st.state : 'ok';
        const isStateful = stateful.has(id);
        const accent = isStateful
          ? (state === 'ok' ? P.ok : state === 'warn' ? P.hub : P.bad)
          : n.accent;
        const fill = isStateful
          ? (state === 'ok' ? P.okFill : state === 'warn' ? P.hubFill : P.badFill)
          : n.fill;
        const ov = activeRule('overload', id, t);
        const overload = ov ? win(t, ov.from, ov.until, ov.ramp || 1.0) : 0;
        const shake = overload * Math.sin(t * 34) * 3.2;
        let tf = '';
        if ((cfg.popReveal || []).indexOf(id) >= 0 && rev) {
          const pop = backOut(seg(t, rev[0], rev[1]));
          tf += 'translate(' + n.x + ' ' + n.y + ') scale(' + (0.55 + 0.45 * pop).toFixed(4) + ') translate(' + (-n.x) + ' ' + (-n.y) + ') ';
        }
        tf += 'translate(' + shake.toFixed(2) + ', 0)';
        set(n.g, { opacity: op.toFixed(3), transform: tf });
        set(n.rect, { stroke: accent, fill: fill });
        if (n.ic) set(n.ic, { opacity: state === 'bad' && n.kind !== 'client' ? 0.55 : 0.95 });
        if (n.bars) n.bars.forEach(b => set(b, { stroke: accent }));
        if (n.leds) n.leds.forEach((l, k) => set(l, { fill: accent, opacity: (0.45 + 0.55 * Math.abs(Math.sin(t * 3 + k))).toFixed(2) }));
        if (n.statusEl) {
          let text = 'healthy', fill2 = P.ok;
          if (state === 'bad') { text = (st && st.status) || 'unhealthy'; fill2 = P.bad; }
          else if (state === 'warn') { text = (st && st.status) || 'failing…'; fill2 = P.hub; }
          else if (overload > 0.05) { text = 'cpu maxed'; fill2 = P.bad; }
          n.statusEl.textContent = text;
          set(n.statusEl, { fill: fill2, opacity: (0.55 + 0.45 * op).toFixed(3) });
        }
        if (n.mark) {
          const mr = activeRule('failMarker', id, t);
          set(n.mark, { opacity: mr ? win(t, mr.from, mr.until, 0.35).toFixed(3) : 0 });
        }
        if (n.queue) {
          n.queue.forEach((q, k) => set(q, { opacity: (clamp01(overload * n.queue.length - k) * 0.9).toFixed(3) }));
          if (n.queueLabel) {
            set(n.queueLabel, { opacity: overload > 0.3 ? 0.95 : 0 });
            n.queueLabel.textContent = overload > 0.3 ? (ov && ov.label) || 'queue' : '';
          }
        }
        if (n.halo) {
          const g = ARR[id] || 0;
          set(n.halo, { opacity: (g * 0.85 * op).toFixed(3), stroke: accent });
        }
      }

      // ---- edges ----
      edges.forEach(e => {
        const drawSpec = (cfg.draw || {})[e.id];
        let draw = 1;
        if (drawSpec) {
          // stagger along whichever end of the edge varies
          const members = expand(drawSpec.order || e.spec.from);
          let idx = members.indexOf(e.fromId);
          if (idx < 0) idx = members.indexOf(e.toId);
          if (idx < 0) idx = 0;
          draw = fadeIn(t, drawSpec.at[0] + idx * (drawSpec.stagger || 0), drawSpec.at[1] + idx * (drawSpec.stagger || 0));
        }
        const dis = edgeDisabled(e, t);
        const fadeSpec = (cfg.edgeFade || {})[e.id];
        const alive = fadeSpec
          ? (fadeSpec.length > 2
              ? lerp(fadeSpec[2], 1, fadeOut(t, fadeSpec[0], fadeSpec[1]))
              : fadeOut(t, fadeSpec[0], fadeSpec[1]))
          : 1;
        const L = geo(e);
        set(e.el, {
          'stroke-dasharray': dis ? '9 11' : L,
          'stroke-dashoffset': dis ? 0 : (L * (1 - draw)).toFixed(2),
          opacity: (0.92 * draw * alive).toFixed(3),
          stroke: dis ? P.bad2 : (e.spec.disabledColor ? P[e.spec.disabledColor] : P[e.spec.color || 'ok']),
        });
      });

      // ---- packets ----
      let used = 0;
      for (const q of pk) {
        if (!q.visible || used >= POOL) continue;
        const node = packets[used++];
        const flow = q.flow;
        let pos;
        if (flow.route === 'via-hub') {
          const split = flow.split == null ? 0.42 : flow.split;
          const inE = edgeFor(flow.inEdge, q.si, flow.hub);
          const outE = edgeFor(flow.outEdge, flow.hub, q.ti);
          if (q.p <= split && inE) pos = pointOn(inE, q.p / split);
          else if (outE) pos = pointOn(outE, (q.p - split) / (1 - split));
        } else {
          const e = edgeFor(flow.edge, q.si, q.ti);
          if (e) pos = pointOn(e, q.p);
        }
        if (!pos) { used--; continue; }
        const bad = stateAt(q.ti, t) && stateAt(q.ti, t).state === 'bad';
        const split = flow.split == null ? 0.42 : flow.split;
        const overloaded = flow.route !== 'via-hub' && t > 12 && q.p > 0.78;
        set(node, {
          cx: pos.x.toFixed(1), cy: pos.y.toFixed(1),
          fill: bad || overloaded ? P.bad : flow.route === 'via-hub' ? (q.p > split ? P.ok : P.client) : P.client,
          opacity: 0.98,
        });
      }
      for (let i = used; i < POOL; i++) set(packets[i], { opacity: 0, cx: -200, cy: -200 });

      // ---- pings ----
      let pu = 0;
      (cfg.pings || []).forEach(ps => {
        const travel = ps.travel || 0.85;
        for (let k = 0; k < (ps.maxPackets || 60); k++) {
          const T = ps.from + k * ps.interval;
          if (T > t + 0.001) break;
          const p = (t - T) / travel;
          if (p < 0 || p > 1.35) continue;
          (ps.targets || []).forEach(tid => {
            if (pu >= PINGPOOL) return;
            const node = pingDots[pu++];
            const e = edgeFor(ps.edge, ps.hub, tid);
            if (!e) return;
            const pos = pointOn(e, p);
            const bad = stateAt(tid, T + travel) && stateAt(tid, T + travel).state === 'bad';
            const fade = clamp01(1 - Math.abs(p - 0.5) * 1.4);
            set(node, { cx: pos.x.toFixed(1), cy: pos.y.toFixed(1), r: 4.8, fill: bad ? P.bad : P.client, opacity: (p <= 1 ? fade * 0.85 : 0).toFixed(3) });
          });
        }
      });
      for (let i = pu; i < PINGPOOL; i++) set(pingDots[i], { opacity: 0, cx: -200, cy: -200 });

      // ---- rings + counters ----
      const counts = OV.counters === false ? {} : servedCounts(t);
      const showCounters = OV.countersAt ? win(t, OV.countersAt[0], OV.countersAt[1], 0.8) : 0;
      Array.from(targetIds).forEach(id => {
        const n = nodes[id]; if (!n) return;
        const g = ARR[id] || 0;
        const st = stateAt(id, t);
        const bad = st && st.state === 'bad';
        if (rings[id]) set(rings[id], { r: lerp(58, 108, 1 - g).toFixed(1), opacity: (g * 0.8 * (bad ? 0 : 1)).toFixed(3), stroke: bad ? P.bad : P.ok });
        if (counters[id]) {
          counters[id].textContent = String(counts[id] || 0);
          set(counters[id], { opacity: (showCounters * (bad ? 0.45 : 0.95)).toFixed(3), fill: bad ? P.bad : P.ok });
        }
      });

      // ---- banners ----
      banners.forEach(b => {
        const sp = b.spec;
        const o = win(t, sp.from, sp.until, sp.ramp || 0.7) * (sp.pulse ? (0.75 + 0.25 * Math.sin(t * sp.pulse)) : 1);
        let bx = 0, by = 0;
        if (sp.anchor && nodes[sp.anchor]) {
          const n = nodes[sp.anchor];
          bx = n.x + (sp.offset ? sp.offset[0] : 0);
          by = n.y + (sp.offset ? sp.offset[1] : 0);
        } else if (sp.at) { bx = sp.at[0]; by = sp.at[1]; }
        if (sp.wobble) by += Math.sin(t * sp.wobble) * 2.2;
        if (sp.float) by += Math.sin(t * sp.float) * 8;
        set(b.el, { opacity: o.toFixed(3), transform: 'translate(' + bx.toFixed(1) + ' ' + by.toFixed(1) + ')' });
      });

      // ---- chrome ----
      if (header) {
        let o = 1;
        if (headerFade) o = fadeIn(t, headerFade[0], headerFade[1]);
        if (OV.headerUntil) o *= fadeOut(t, OV.headerUntil[0], OV.headerUntil[1]);
        set(header, { opacity: (o * 0.95).toFixed(3) });
      }
      let active = null;
      for (const k in scenes) if (t >= scenes[k].start) active = k;
      // Before the first scene begins (e.g. during the lead-in silence) no scene
      // is active yet. The load-balancer project never hit this because its first
      // scene started at 0; a measured timeline starts at the narration, not 0.
      if (active === null) active = Object.keys(scenes)[0];
      if (stageBadge) {
        const sc = scenes[active];
        const lt = t - sc.start;
        const name = (OV.stageNames || {})[active];
        const o = name ? clamp01(lt / 0.3) * clamp01((sc.dur - lt) / 0.3) * 0.98 : 0;
        if (active !== prevStage) {
        stageText.textContent = name || '';
        prevStage = active;
        if (stageRect) {
          const label = name || '';
          // textW measures the glyphs; SVG letter-spacing adds 0.8px per character.
          const textPx = label ? textW(label, 22, 700) + label.length * 0.8 : 0;
          const wpx = Math.max(292, Math.round(textPx) + 56);
          const bx = W - 74 - wpx;
          set(stageRect, { x: bx.toFixed(1), width: wpx });
          set(stageText, { x: (bx + wpx / 2).toFixed(1) });
        }
      }
        set(stageBadge, { opacity: o.toFixed(3), transform: 'translate(0 ' + ((1 - o) * 10).toFixed(2) + ')' });
      }
      if (progBar) set(progBar, { width: (W * clamp01(t / TL.total)).toFixed(1) });

      // ---- overlays ----
      if (titleCard && OV.title) {
        const a = OV.title.from, b = OV.title.until;
        const tcIn = fadeIn(t, a + 0.35, a + 1.35);
        const tcOut = fadeOut(t, b - 0.5, b + 0.15);
        set(titleCard, { opacity: (t < b ? tcIn * tcOut : 0).toFixed(3), transform: 'translate(0 ' + ((1 - tcIn) * 26).toFixed(2) + ')' });
        if (titleCard._rule) {
          const p = fadeIn(t, a + 0.9, a + 1.7);
          set(titleCard._rule, { width: (260 * p).toFixed(1), x: (W / 2 - 130 * p).toFixed(1) });
        }
      }
      if (cardsG && OV.cards) {
        const oB = scenes[OV.cards.scene || 'outro'].start;
        set(cardsG, { opacity: fadeIn(t, oB + (OV.cards.inAt == null ? 0.9 : OV.cards.inAt), oB + (OV.cards.inAt == null ? 0.9 : OV.cards.inAt) + 0.7).toFixed(3) });
        cardEls.forEach((g, i) => {
          const a = oB + (OV.cards.inAt == null ? 1.0 : OV.cards.inAt + 0.1) + i * (OV.cards.stagger || 1.75);
          const o = fadeIn(t, a, a + 0.6) * fadeOut(t, oB + (OV.cards.outAt || 6.9), oB + (OV.cards.outAt || 6.9) + 0.6);
          set(g, { opacity: o.toFixed(3), transform: 'translate(0 ' + ((1 - fadeIn(t, a, a + 0.6)) * 22).toFixed(2) + ')' });
        });
      }
      if (chipsG && OV.chips) {
        const oB = scenes[OV.chips.scene || 'outro'].start;
        const inAt = OV.chips.at == null ? 1.0 : OV.chips.at;
        set(chipsG, { opacity: fadeIn(t, oB + inAt - 0.6, oB + inAt).toFixed(3) });
        chipEls.forEach(c => {
          const a = oB + inAt + c.order * (OV.chips.stagger || 0.5);
          const o = fadeIn(t, a, a + 0.5) * fadeOut(t, oB + (OV.chips.outAt || 6.5), oB + (OV.chips.outAt || 6.5) + 0.5);
          set(c.el, { opacity: o.toFixed(3), transform: 'translate(0 ' + ((1 - fadeIn(t, a, a + 0.5)) * 16).toFixed(1) + ')' });
        });
        if (codaEl) {
          const ca = oB + (OV.chips.codaAt == null ? 5.0 : OV.chips.codaAt);
          set(codaEl, { opacity: fadeIn(t, ca, ca + 0.7).toFixed(3), transform: 'translate(0 ' + ((1 - fadeIn(t, ca, ca + 0.7)) * 14).toFixed(1) + ')' });
        }
      }
      if (finalG && OV.finalLine) {
        const oB = scenes[OV.finalLine.scene || 'outro'].start;
        const at = OV.finalLine.at == null ? 7.6 : OV.finalLine.at;
        set(finalG, { opacity: fadeIn(t, oB + at, oB + at + 0.6).toFixed(3), transform: 'translate(0 ' + ((1 - fadeIn(t, oB + at, oB + at + 0.6)) * 20).toFixed(2) + ')' });
      }
    }

    render(0);
    return { renderAt: render, nodes: nodes, edges: edges };
  }

  /* =========================================================================
     Primitives — the library (stage 5's floor)

     Each primitive is a PURE function of time:  prim(parent, params, t) -> void
     It draws the frame for `t` into `parent` and returns; nothing accumulates,
     so frames may be rendered in any order. `at` is the beat's start and `dur`
     its reveal length, in seconds — the beat layer maps authored beats onto them.

     Usage (the open `svg` lane):
       window.SCENE_CONFIG = { renderAt: function (t, svg) {
         SceneCore.primitives.chart(svg, { type: 'pie', x: 960, y: 520, radius: 220,
           at: 0, data: [{ label: 'A', value: 3 }, { label: 'B', value: 1 }] }, t);
       } };
     ========================================================================== */

  const pal = over => Object.assign({}, DEFAULT_PALETTE, over || {});
  const prog = (t, at, dur) => easeOut(clamp01((t - (at || 0)) / (dur || 0.001)));

  /* exact text widths without a DOM round-trip */
  let _mctx = null;
  function textW(s, size, weight, family) {
    if (!_mctx) _mctx = document.createElement('canvas').getContext('2d');
    _mctx.font = (weight || 400) + ' ' + size + 'px ' +
      (family || '"Helvetica Neue", Helvetica, Arial, sans-serif');
    return _mctx.measureText(s).width;
  }
  const arrowHead = (g, x, y, ang, color, op) =>
    el('path', { d: 'M -10 -6 L 0 0 L -10 6 Z', fill: color,
      transform: 'translate(' + x + ' ' + y + ') rotate(' + ang + ')', opacity: op }, g);

  /* --- pie wedge with a progressive sweep --- */
  function sectorPath(cx, cy, r, a0, a1, p) {
    const span = (a1 - a0) * p;
    if (span <= 0.0001) return '';
    const end = a0 + span;
    const large = span > Math.PI ? 1 : 0;
    return 'M ' + cx + ' ' + cy +
      ' L ' + (cx + Math.cos(a0) * r) + ' ' + (cy + Math.sin(a0) * r) +
      ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' +
      (cx + Math.cos(end) * r) + ' ' + (cy + Math.sin(end) * r) + ' Z';
  }

  /* ---- chart: pie | bar ------------------------------------------------- */
  function primChart(parent, params, t) {
    const C = pal(params.palette);
    const at = params.at || 0;
    if (t < at) return;
    const p = prog(t, at, params.dur == null ? 1.0 : params.dur);
    const data = (params.data || []).filter(d => d.value > 0);
    if (!data.length) return;
    const total = data.reduce((a, d) => a + d.value, 0) || 1;
    const col = d => C[d.color || 'client'];

    if ((params.type || 'pie') === 'pie') {
      const cx = params.x, cy = params.y, r = params.radius == null ? 200 : params.radius;
      const lp = clamp01((p - 0.55) / 0.45);
      let a0 = -Math.PI / 2;                       /* start at 12 o'clock */
      data.forEach(d => {
        const a1 = a0 + (d.value / total) * Math.PI * 2;
        el('path', { d: sectorPath(cx, cy, r, a0, a1, p), fill: col(d),
          opacity: 0.88, stroke: C.bg1, 'stroke-width': 3 }, parent);
        if (params.labels !== false) {
          const mid = (a0 + a1) / 2, right = Math.cos(mid) >= 0;
          const lx = cx + Math.cos(mid) * (r + 26);
          const ly = cy + Math.sin(mid) * (r + 26);
          txt(lx, ly + 8, d.label, { fill: C.text, 'font-size': 22, 'font-weight': 700,
            'text-anchor': right ? 'start' : 'end', opacity: lp.toFixed(3) }, parent);
          txt(lx, ly + 34, Math.round((d.value / total) * 100) + '%',
            { fill: C.muted, 'font-size': 18, 'text-anchor': right ? 'start' : 'end',
              opacity: lp.toFixed(3) }, parent);
        }
        a0 = a1;
      });
      if (params.title) txt(cx, cy - r - 36, params.title,
        { fill: C.muted, 'font-size': 25, 'text-anchor': 'middle' }, parent);
      return;
    }

    const x = params.x, y = params.y, w = params.w, h = params.h;
    const max = Math.max.apply(null, data.map(d => d.value).concat([1]));
    const slot = w / data.length;
    const bw = Math.min(slot * 0.55, params.barW == null ? 90 : params.barW);
    el('line', { x1: x, y1: y + h, x2: x + w, y2: y + h, stroke: C.hair, 'stroke-width': 2 }, parent);
    data.forEach((d, i) => {
      const bx = x + slot * i + (slot - bw) / 2;
      const bh = (d.value / max) * (h - 20) * p;
      el('rect', { x: bx, y: y + h - bh, width: bw, height: bh, rx: 8,
        fill: col(d), opacity: 0.88 }, parent);
      txt(bx + bw / 2, y + h + 32, d.label,
        { fill: C.muted, 'font-size': 20, 'text-anchor': 'middle' }, parent);
      txt(bx + bw / 2, y + h - bh - 16, String(d.value),
        { fill: C.text, 'font-size': 22, 'font-weight': 700, 'text-anchor': 'middle',
          opacity: clamp01((p - 0.6) / 0.4).toFixed(3) }, parent);
    });
    if (params.title) txt(x + w / 2, y - 26, params.title,
      { fill: C.muted, 'font-size': 25, 'text-anchor': 'middle' }, parent);
  }

  /* ---- hub-and-spoke: a centre with N surrounding boxes + emanations ----- */
  function primHubSpoke(parent, params, t) {
    const C = pal(params.palette);
    const at = params.at || 0;
    if (t < at) return;
    const cx = params.x, cy = params.y;
    const R = params.radius == null ? 330 : params.radius;
    const spokes = params.spokes || [];
    const n = spokes.length || 1;
    const hubW = params.hubW == null ? 270 : params.hubW;
    const hubH = params.hubH == null ? 112 : params.hubH;
    const sw = params.spokeW == null ? 230 : params.spokeW;
    const sh = params.spokeH == null ? 96 : params.spokeH;
    const stagger = params.stagger == null ? 0.3 : params.stagger;
    const hp = prog(t, at, params.dur == null ? 0.6 : params.dur);
    const step = (Math.PI * 2) / n;

    spokes.forEach((s, i) => {
      const a = -Math.PI / 2 + i * step;
      const sx = cx + Math.cos(a) * R, sy = cy + Math.sin(a) * R;
      const sp = prog(t, at + 0.5 + i * stagger, 0.7);
      if (sp <= 0) return;
      const col = C[s.color || 'client'];
      const x0 = cx + Math.cos(a) * (hubW / 2), y0 = cy + Math.sin(a) * (hubH / 2);
      const x1 = sx - Math.cos(a) * (sw / 2), y1 = sy - Math.sin(a) * (sh / 2);
      const ang = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
      el('line', { x1: x0, y1: y0, x2: x0 + (x1 - x0) * sp, y2: y0 + (y1 - y0) * sp,
        stroke: col, 'stroke-width': 3, opacity: 0.85, 'stroke-linecap': 'round' }, parent);
      if (sp > 0.9) arrowHead(parent, x1, y1, ang, col, ((sp - 0.9) / 0.1).toFixed(3));
      el('rect', { x: sx - sw / 2, y: sy - sh / 2, width: sw, height: sh, rx: 14,
        fill: C[s.fill || 'okFill'], stroke: col, 'stroke-width': 2.5, opacity: sp.toFixed(3) }, parent);
      txt(sx, sy + 9, s.label || ('S' + (i + 1)),
        { fill: C.text, 'font-size': 24, 'font-weight': 700, 'text-anchor': 'middle', opacity: sp.toFixed(3) }, parent);
      if (s.sub) txt(sx, sy + sh / 2 + 28, s.sub,
        { fill: C.muted, 'font-size': 18, 'text-anchor': 'middle', opacity: sp.toFixed(3) }, parent);
    });

    el('rect', { x: cx - hubW / 2, y: cy - hubH / 2, width: hubW, height: hubH, rx: 18,
      fill: C.hubFill, stroke: C.hub, 'stroke-width': 3, opacity: hp.toFixed(3) }, parent);
    txt(cx, cy + 10, params.label || 'Hub',
      { fill: C.text, 'font-size': 30, 'font-weight': 800, 'text-anchor': 'middle', opacity: hp.toFixed(3) }, parent);
    if (params.sub) txt(cx, cy - hubH / 2 - 24, params.sub,
      { fill: C.muted, 'font-size': 20, 'text-anchor': 'middle', opacity: hp.toFixed(3) }, parent);
  }

  /* ---- loop-flow: N nodes in a cycle, with packets circulating ---------- */
  function primLoopFlow(parent, params, t) {
    const C = pal(params.palette);
    const at = params.at || 0;
    const nodes = params.nodes || [];
    if (t < at || nodes.length < 2) return;
    const n = nodes.length;
    const p = prog(t, at, params.dur == null ? 1.0 : params.dur);
    const closed = params.loop !== false;
    const edgeCount = closed ? n : n - 1;

    let gx = 0, gy = 0;
    nodes.forEach(nd => { gx += nd.x; gy += nd.y; });
    gx /= n; gy /= n;
    const bow = params.bow == null ? 0.2 : params.bow;

    const quads = [];
    for (let i = 0; i < edgeCount; i++) {
      const a = nodes[i], b = nodes[(i + 1) % n];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const qx = mx + (mx - gx) * bow * 2, qy = my + (my - gy) * bow * 2;
      quads.push({ a: a, b: b, qx: qx, qy: qy });
      const ep = prog(t, at + i * (params.edgeStagger == null ? 0.18 : params.edgeStagger), 0.5);
      if (ep > 0) el('path', { d: 'M ' + a.x + ' ' + a.y + ' Q ' + qx + ' ' + qy + ' ' + b.x + ' ' + b.y,
        fill: 'none', stroke: C[params.edgeColor || 'ok'], 'stroke-width': 3,
        opacity: (0.8 * ep).toFixed(3), 'stroke-linecap': 'round' }, parent);
    }

    if (params.packets !== false && p > 0.2) {
      const K = params.packetCount == null ? 3 : params.packetCount;
      const lap = params.lap == null ? 6 : params.lap;
      for (let k = 0; k < K; k++) {
        const f = ((((t - at) / lap) + k / K) % 1 + 1) % 1;
        const seg = f * edgeCount;
        const q = quads[Math.floor(seg) % edgeCount];
        if (!q) continue;
        const u = seg - Math.floor(seg), iu = 1 - u;
        el('circle', { cx: iu * iu * q.a.x + 2 * iu * u * q.qx + u * u * q.b.x,
          cy: iu * iu * q.a.y + 2 * iu * u * q.qy + u * u * q.b.y,
          r: params.dot == null ? 9 : params.dot,
          fill: C[params.dotColor || 'client'], opacity: 0.95 }, parent);
      }
    }

    const nw = params.nodeW == null ? 210 : params.nodeW;
    const nh = params.nodeH == null ? 96 : params.nodeH;
    nodes.forEach((nd, i) => {
      const np = prog(t, at + i * (params.nodeStagger == null ? 0.15 : params.nodeStagger), 0.5);
      if (np <= 0) return;
      el('rect', { x: nd.x - nw / 2, y: nd.y - nh / 2, width: nw, height: nh, rx: 14,
        fill: C[nd.fill || 'okFill'], stroke: C[nd.color || 'ok'], 'stroke-width': 2.5,
        opacity: np.toFixed(3) }, parent);
      txt(nd.x, nd.y + 9, nd.label || ('N' + (i + 1)),
        { fill: C.text, 'font-size': 24, 'font-weight': 700, 'text-anchor': 'middle', opacity: np.toFixed(3) }, parent);
    });
  }

  /* ---- timeline: tracks, events, and happens-before arrows -------------- */
  function primTimeline(parent, params, t) {
    const C = pal(params.palette);
    const at = params.at || 0;
    if (t < at) return;
    const x = params.x, y = params.y, w = params.w;
    const tracks = params.tracks || [];
    const laneH = params.laneH == null ? 120 : params.laneH;

    tracks.forEach((tr, i) => {
      const ly = y + i * laneH;
      el('line', { x1: x, y1: ly, x2: x + w, y2: ly, stroke: C.hair, 'stroke-width': 2 }, parent);
      el('circle', { cx: x, cy: ly, r: 6, fill: C[tr.color || 'muted'] }, parent);
      txt(x - 24, ly + 8, tr.label || ('P' + (i + 1)),
        { fill: C.text, 'font-size': 24, 'font-weight': 700, 'text-anchor': 'end' }, parent);
    });

    const marks = [];
    (params.events || []).forEach((ev, i) => {
      const ex = x + ev.at * w, ey = y + (ev.track || 0) * laneH;
      const ep = prog(t, at + 0.3 + i * (params.eventStagger == null ? 0.25 : params.eventStagger), 0.4);
      marks.push({ x: ex, y: ey });
      if (ep <= 0) return;
      const col = C[ev.color || 'client'];
      const r = params.markR == null ? 11 : params.markR;
      el('circle', { cx: ex, cy: ey, r: (r * ep).toFixed(2), fill: col, opacity: 0.95 }, parent);
      if (ev.label) txt(ex, ey - r - 18, ev.label,
        { fill: C.text, 'font-size': 20, 'font-weight': 700, 'text-anchor': 'middle', opacity: ep.toFixed(3) }, parent);
    });

    (params.arrows || []).forEach((ar, i) => {
      const a = marks[ar.from], b = marks[ar.to];
      if (!a || !b) return;
      const ap = prog(t, at + 0.9 + i * (params.arrowStagger == null ? 0.3 : params.arrowStagger), 0.6);
      if (ap <= 0) return;
      const lift = params.arrowLift == null ? 52 : params.arrowLift;
      const qx = (a.x + b.x) / 2, qy = Math.min(a.y, b.y) - lift;
      const col = C[ar.color || 'hub'];
      /* stop short of the target marker, or the head lands on top of it */
      const back = (params.markR == null ? 11 : params.markR) + 10;
      const chord = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const u = ap * Math.max(0.05, 1 - back / chord), iu = 1 - u;
      const ex = iu * iu * a.x + 2 * iu * u * qx + u * u * b.x;
      const ey = iu * iu * a.y + 2 * iu * u * qy + u * u * b.y;
      el('path', { d: 'M ' + a.x + ' ' + a.y + ' Q ' + qx + ' ' + qy + ' ' + ex + ' ' + ey,
        fill: 'none', stroke: col, 'stroke-width': 3, opacity: 0.9, 'stroke-linecap': 'round' }, parent);
      if (ap > 0.97) arrowHead(parent, ex, ey, Math.atan2(ey - qy, ex - qx) * 180 / Math.PI,
        col, ((ap - 0.97) / 0.03).toFixed(3));
      if (ar.label) txt(qx, (a.y + b.y) / 2 - lift + 10, ar.label,
        { fill: C.muted, 'font-size': 19, 'text-anchor': 'middle', opacity: ap.toFixed(3) }, parent);
    });

    if (params.axisLabel) txt(x + w / 2, y + tracks.length * laneH + 28, params.axisLabel,
      { fill: C.muted, 'font-size': 20, 'text-anchor': 'middle' }, parent);
  }

  /* ---- equation: a small TeX subset ------------------------------------- */
  const MATH_MACROS = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η',
    theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
    rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
    Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒',
    le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡',
    times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', propto: '∝',
    in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩', emptyset: '∅',
    sum: '∑', prod: '∏', int: '∫', partial: '∂', nabla: '∇', infty: '∞',
    forall: '∀', exists: '∃', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
    langle: '⟨', rangle: '⟩', dots: '…', ldots: '…', cdots: '⋯',
    iff: '⇔', implies: '⟹', therefore: '∴', because: '∵', qed: '∎',
  };

  /* binary relations/operators get thin space either side, TeX-style */
  const RELATIONS = '=<>≤≥≠≈≡→←↔⇒⇔∈∉⊂⊆∪∩±∓×÷·∝';

  function parseMath(src) {
    let i = 0;
    const isLetter = c => /[A-Za-z]/.test(c);
    const isWord = c => /[A-Za-z0-9.]/.test(c);
    function braced() {
      i++;
      const items = seq();
      if (src[i] === '}') i++;
      return items;
    }
    function single() { return src[i] === '{' ? braced() : atom(); }
    function macro() {
      i++;
      if (!isLetter(src[i])) { const ch = src[i++]; return [{ k: 'run', s: ch }]; }
      let m = '';
      while (i < src.length && isLetter(src[i])) m += src[i++];
      if (m === 'frac') return [{ k: 'frac', num: single(), den: single() }];
      if (m === 'sqrt') return [{ k: 'sqrt', body: single() }];
      if (m === 'text' || m === 'mathrm' || m === 'operatorname') {
        return [{ k: 'run', s: single().map(x => x.s || '').join('') }];
      }
      if (m === 'left' || m === 'right') return [];
      if (m === 'mathbb' || m === 'mathbf' || m === 'mathit') return single();
      return [{ k: 'run', s: MATH_MACROS[m] != null ? MATH_MACROS[m] : m }];
    }
    function atom() {
      const c = src[i];
      if (c === '\\') return macro();
      if (c === '{') return braced();
      if (isWord(c)) {
        let s = '';
        while (i < src.length && isWord(src[i])) s += src[i++];
        return [{ k: 'run', s: s }];
      }
      i++;
      return [{ k: 'run', s: c }];
    }
    function seq() {
      const items = [];
      while (i < src.length && src[i] !== '}') {
        if (src[i] === '^' || src[i] === '_') {
          const which = src[i++], arg = single();
          items.push({ k: 'script', base: { k: 'run', s: '' },
            sup: which === '^' ? arg : null, sub: which === '_' ? arg : null });
          continue;
        }
        const at = atom();
        let sup = null, sub = null;
        while (src[i] === '^' || src[i] === '_') {
          const which = src[i++], arg = single();
          if (which === '^') sup = arg; else sub = arg;
        }
        if (sup || sub) {
          items.push.apply(items, at.slice(0, -1));
          items.push({ k: 'script', base: at[at.length - 1], sup: sup, sub: sub });
        } else items.push.apply(items, at);
      }
      return items;
    }
    return seq();
  }

  function mathAtom(it, size) {
    if (it.k === 'run') {
      const isRel = it.s.length === 1 && RELATIONS.indexOf(it.s) >= 0;
      const pad = isRel ? size * 0.17 : 0;
      const w = textW(it.s, size) + pad * 2;
      return { w: w, asc: size * 0.75, desc: size * 0.25,
        draw: function (x, base, g, color) {
          txt(x + pad, base, it.s, { fill: color, 'font-size': size }, g);
        } };
    }
    if (it.k === 'frac') {
      const num = mathBox(it.num, size * 0.82), den = mathBox(it.den, size * 0.82);
      const pad = size * 0.2, gap = size * 0.26;
      const w = Math.max(num.w, den.w) + pad * 2;
      return { w: w, asc: gap / 2 + num.asc + num.desc, desc: gap / 2 + den.asc + den.desc,
        draw: function (x, base, g, color) {
          num.draw(x + (w - num.w) / 2, base - gap / 2 - num.desc, g, color);
          den.draw(x + (w - den.w) / 2, base + gap / 2 + den.asc, g, color);
          el('line', { x1: x + pad * 0.35, y1: base, x2: x + w - pad * 0.35, y2: base,
            stroke: color, 'stroke-width': Math.max(1.5, size * 0.045) }, g);
        } };
    }
    if (it.k === 'script') {
      const base = mathAtom(it.base, size);
      const ss = size * 0.66;
      const sup = it.sup ? mathBox(it.sup, ss) : null;
      const sub = it.sub ? mathBox(it.sub, ss) : null;
      const lift = size * 0.42, drop = size * 0.18;
      return { w: base.w + Math.max(sup ? sup.w : 0, sub ? sub.w : 0),
        asc: Math.max(base.asc, sup ? lift + sup.asc + sup.desc : 0),
        desc: Math.max(base.desc, sub ? drop + sub.asc + sub.desc : 0),
        draw: function (x, b, g, color) {
          base.draw(x, b, g, color);
          if (sup) sup.draw(x + base.w, b - lift - sup.desc, g, color);
          if (sub) sub.draw(x + base.w, b + drop + sub.asc, g, color);
        } };
    }
    const inner = mathBox(it.body, size);
    const hook = size * 0.5, pad = size * 0.1;
    const w = inner.w + hook + pad * 2;
    const asc = inner.asc + size * 0.18, desc = inner.desc;
    return { w: w, asc: asc, desc: desc,
      draw: function (x, base, g, color) {
        const top = base - inner.asc - size * 0.06;
        el('path', { d: 'M ' + x + ' ' + (base - size * 0.16) +
          ' L ' + (x + hook * 0.4) + ' ' + (base + size * 0.08) +
          ' L ' + (x + hook * 0.78) + ' ' + top +
          ' L ' + (x + w) + ' ' + top,
          fill: 'none', stroke: color, 'stroke-width': Math.max(1.5, size * 0.05),
          'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
        inner.draw(x + hook + pad, base, g, color);
      } };
  }

  function mathBox(items, size) {
    const parts = (items || []).map(it => mathAtom(it, size));
    const w = parts.reduce((a, b) => a + b.w, 0);
    return { w: w,
      asc: Math.max.apply(null, parts.map(b => b.asc).concat([0])),
      desc: Math.max.apply(null, parts.map(b => b.desc).concat([0])),
      draw: function (x, base, g, color) {
        let cx = x;
        parts.forEach(b => { b.draw(cx, base, g, color); cx += b.w; });
      } };
  }

  function primEquation(parent, params, t) {
    const C = pal(params.palette);
    const at = params.at || 0;
    if (t < at) return;
    const size = params.size == null ? 46 : params.size;
    const p = prog(t, at, params.dur == null ? 0.8 : params.dur);
    const box = mathBox(parseMath(params.tex || ''), size);
    const centred = params.x == null;
    const x = centred ? (params.cx == null ? 960 : params.cx) - box.w / 2 : params.x;
    const base = params.y == null ? 540 : params.y;
    const g = el('g', { opacity: p.toFixed(3) }, parent);
    box.draw(x, base, g, C[params.color || 'text']);
    if (params.label) txt(params.cx == null ? 960 : params.cx, base + box.desc + 48, params.label,
      { fill: C.muted, 'font-size': 21, 'text-anchor': 'middle', opacity: p.toFixed(3) }, parent);
  }

  window.SceneCore = {
    createScene: createScene,
    primitives: {
      chart: primChart,
      hubSpoke: primHubSpoke,
      loopFlow: primLoopFlow,
      timeline: primTimeline,
      equation: primEquation,
    },
  };
})();
