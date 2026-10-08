/* =============================================================================
   scene-code.js — code + refactor renderers.

   Two renderers, one core:
     • CODE      a single file on screen, revealed line by line, with line focus
     • REFACTOR  the same panel splitting into BEFORE / AFTER, so a transformation
                 is shown rather than described

   They share everything except the number of panels, which is why they live in
   one module: the "refactor" view is a code view that happens to have two panels
   and a layout that moves them apart.

   Like the diagram renderer, renderAt(t) is a PURE FUNCTION of time.

   Contract: window.CodeScenes.create({ root, config }) -> { renderAt(t) }
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------- math ---------------- */
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, p) => a + (b - a) * p;
  const seg = (t, a, b) => clamp01((t - a) / (b - a || 1e-6));
  const easeOut = p => 1 - Math.pow(1 - p, 3);
  const easeIO = p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const fadeIn = (t, a, b) => easeOut(seg(t, a, b));
  const fadeOut = (t, a, b) => 1 - easeIO(seg(t, a, b));
  const inWin = (t, a, b) => t >= a && t < (b == null ? Infinity : b);

  /* ---------------- syntax highlighting ----------------
     A deliberately small Java/C-like tokenizer. No dependency, and it only has
     to handle the curated snippets we author — not arbitrary source. */
  const LANGS = {
    java: {
      keywords: new Set(['class','interface','implements','extends','public','private','protected','static','final','void','new','if','else','return','this','abstract','package','import','throws','throw','enum','super']),
      types: new Set(['String','double','int','boolean','long','float','Object','List','Map']),
      comment: /^\/\/.*|^\/\*[\s\S]*?\*\//,
    },
    python: {
      keywords: new Set(['def','class','return','if','elif','else','for','while','import','from','as','with','try','except','raise','lambda','None','True','False','self','yield','pass','in','not','and','or']),
      types: new Set(['int','str','float','bool','list','dict','set','tuple']),
      comment: /^#.*/,
    },
  };

  function tokenize(line, lang) {
    const L = LANGS[lang] || LANGS.java;
    const out = [];
    let i = 0;
    while (i < line.length) {
      const rest = line.slice(i);
      let m;
      if ((m = L.comment.exec(rest))) { out.push(['c', m[0]]); i += m[0].length; continue; }
      if ((m = /^"(?:[^"\\]|\\.)*"|^'(?:[^'\\]|\\.)*'/.exec(rest))) { out.push(['s', m[0]]); i += m[0].length; continue; }
      if ((m = /^[A-Za-z_$][\w$]*/.exec(rest))) {
        const w = m[0];
        const kind = L.keywords.has(w) ? 'k' : L.types.has(w) ? 't' : (/^[A-Z]/.test(w) ? 't' : (rest[w.length] === '(' ? 'f' : 'p'));
        out.push([kind, w]); i += w.length; continue;
      }
      if ((m = /^\d+(?:\.\d+)?/.exec(rest))) { out.push(['n', m[0]]); i += m[0].length; continue; }
      if ((m = /^[{}()[\];,.]/.exec(rest))) { out.push(['u', m[0]]); i += 1; continue; }
      out.push(['p', rest[0]]); i += 1;
    }
    return out;
  }

  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function highlight(line, lang) {
    return tokenize(line, lang).map(([k, txt]) => `<span class="t-${k}">${esc(txt)}</span>`).join('');
  }

  /* ---------------- factory ---------------- */
  function create(opts) {
    const root = opts.root;
    const cfg = opts.config;
    const W = (cfg.meta && cfg.meta.width) || 1920;
    const H = (cfg.meta && cfg.meta.height) || 1080;
    const TOTAL = cfg.total;

    root.innerHTML = '';

    /* --- background grid --- */
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.style.position = 'absolute'; svg.style.inset = '0';
    const grid = document.createElementNS(NS, 'g');
    grid.setAttribute('opacity', '0.5');
    for (let x = 0; x <= W; x += 60) {
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', x); l.setAttribute('y1', 0); l.setAttribute('x2', x); l.setAttribute('y2', H);
      l.setAttribute('stroke', x % 300 === 0 ? '#182742' : '#111d33'); l.setAttribute('stroke-width', 1);
      grid.appendChild(l);
    }
    for (let y = 0; y <= H; y += 60) {
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', 0); l.setAttribute('y1', y); l.setAttribute('x2', W); l.setAttribute('y2', y);
      l.setAttribute('stroke', y % 300 === 0 ? '#182742' : '#111d33'); l.setAttribute('stroke-width', 1);
      grid.appendChild(l);
    }
    svg.appendChild(grid);
    root.appendChild(svg);

    /* --- chrome --- */
    const chrome = document.createElement('div');
    chrome.className = 'chrome';
    chrome.innerHTML =
      `<div class="hdr"><span class="hdr-dot"></span><span>${esc((cfg.chrome && cfg.chrome.header) || '')}</span></div>` +
      `<div class="stage-badge" id="stageBadge"></div>` +
      `<div class="prog"><div class="prog-fill" id="progFill"></div></div>`;
    root.appendChild(chrome);

    /* --- panels --- */
    const panelWrap = document.createElement('div');
    panelWrap.className = 'panel-wrap';
    root.appendChild(panelWrap);

    const panels = {};
    (cfg.panels || []).forEach(p => {
      const el = document.createElement('div');
      el.className = `panel accent-${p.accent || 'ok'}`;
      const lines = p.lines.map((ln, i) =>
        `<div class="ln" data-i="${i}"><span class="num">${i + 1}</span><span class="txt">${highlight(ln, p.lang || 'java')}</span></div>`
      ).join('');
      el.innerHTML =
        `<div class="card">` +
        `<div class="tab"><span class="dot"></span><span class="fname">${esc(p.file || '')}</span>` +
        (p.badge ? `<span class="badge">${esc(p.badge)}</span>` : '') + `</div>` +
        `<div class="code">${lines}</div></div>`;
      panelWrap.appendChild(el);
      panels[p.id] = { spec: p, el, lineEls: Array.from(el.querySelectorAll('.ln')), w: 0, h: 0 };
    });

    // natural size, measured once so layouts can centre panels exactly
    Object.values(panels).forEach(p => {
      p.el.style.transform = 'none';
      const r = p.el.getBoundingClientRect();
      p.w = r.width; p.h = r.height;
    });

    /* --- annotation notes --- */
    const noteWrap = document.createElement('div');
    noteWrap.className = 'note-wrap';
    root.appendChild(noteWrap);
    const notes = {};
    (cfg.notes || []).forEach(n => {
      const el = document.createElement('div');
      el.className = `note note-${n.accent || 'hub'}`;
      el.innerHTML = esc(n.text);
      el.style.left = n.at[0] + 'px';
      el.style.top = n.at[1] + 'px';
      noteWrap.appendChild(el);
      notes[n.id] = { spec: n, el };
    });

    // line text lengths, measured once — used for weighted reveal timing
    Object.values(panels).forEach(p => {
      p.lineLens = p.lineEls.map(el => {
        const t = el.querySelector('.txt');
        return t ? t.textContent.length : 0;
      });
    });

    /* --- acts, normalised --- */
    const acts = cfg.acts || [];
    const actOf = (op, panel) => acts.filter(a => a.op === op && (!panel || a.panel === panel));

    /**
     * Per-line reveal offsets.
     *
     * A uniform stagger gives a blank line the same screen time as a 60-character
     * statement, which reads as a race. Real dwell is proportional to what is on
     * the line: a base cost for the eye to land, plus a cost per character.
     */
    function revealOffsets(p, rev) {
      if (rev.stagger != null) {
        return { starts: p.lineEls.map((_, i) => i * rev.stagger), natural: (p.lineEls.length - 1) * rev.stagger };
      }
      const base = rev.dwell && rev.dwell.base != null ? rev.dwell.base : 0.28;
      const perChar = rev.dwell && rev.dwell.perChar != null ? rev.dwell.perChar : 0.038;
      const speed = rev.speed || 1;
      const starts = [];
      let acc = 0;
      p.lineLens.forEach(len => { starts.push(acc); acc += (base + len * perChar) / speed; });
      return { starts, natural: acc };
    }

    const initOf = id => (cfg.initLayout && cfg.initLayout[id]) || { cx: W / 2, cy: H / 2, scale: 1 };

    /** Pure: interpolate through the ordered layout acts. No mutation between frames. */
    const layoutAt = (panelId, t) => {
      const ls = acts.filter(a => a.op === 'layout' && a.panel === panelId);
      const init = initOf(panelId);
      let cur = init;
      for (let i = 0; i < ls.length; i++) {
        const a = ls[i];
        if (t < a.from) break;
        const from = i === 0 ? init : ls[i - 1].to;
        const k = easeIO(seg(t, a.from, a.to));
        cur = {
          cx: lerp(from.cx, a.to.cx, k),
          cy: lerp(from.cy, a.to.cy, k),
          scale: lerp(from.scale, a.to.scale, k),
        };
      }
      return cur;
    };

    /* ---------------- render(t) ---------------- */
    let prevStage = null;

    function render(t) {
      /* panels */
      Object.entries(panels).forEach(([id, p]) => {
        const show = acts.find(a => a.op === 'show' && a.panel === id);
        const hide = acts.find(a => a.op === 'hide' && a.panel === id);
        let op = 1;
        if (show) op = fadeIn(t, show.from, show.to);
        if (hide) op *= fadeOut(t, hide.from, hide.to);

        const lay = layoutAt(id, t);
        const x = lay.cx - (p.w * lay.scale) / 2;
        const y = lay.cy - (p.h * lay.scale) / 2;
        p.el.style.opacity = op.toFixed(3);
        p.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${lay.scale.toFixed(4)})`;

        /* line reveal + focus */
        const rev = acts.find(a => a.op === 'reveal' && a.panel === id);
        const foc = acts.find(a => a.op === 'focus' && a.panel === id);
        const off = rev ? revealOffsets(p, rev) : null;

        p.lineEls.forEach((ln, i) => {
          let lineOp = 1;
          if (rev) lineOp = fadeIn(t, rev.from + off.starts[i], rev.from + off.starts[i] + 0.30);

          let dim = 1;
          if (foc) {
            const inFocus = foc.lines.includes(i + 1);
            const active = inWin(t, foc.from, foc.to);
            const k = active ? fadeIn(t, foc.from, foc.from + 0.5) : 0;
            dim = inFocus ? 1 : lerp(1, 0.28, k);
          }
          ln.style.opacity = (lineOp * dim).toFixed(3);
          ln.classList.toggle('focused', !!foc && foc.lines.includes(i + 1) && inWin(t, foc.from, foc.to));
        });
      });

      /* notes */
      Object.values(notes).forEach(n => {
        const o = fadeIn(t, n.spec.from, n.spec.from + 0.5) * fadeOut(t, n.spec.to - 0.5, n.spec.to);
        n.el.style.opacity = o.toFixed(3);
        n.el.style.transform = `translate(-50%, ${((1 - fadeIn(t, n.spec.from, n.spec.from + 0.5)) * 14).toFixed(1)}px)`;
      });

      /* stage badge driven by a `phase` list */
      const phases = cfg.phases || [];
      let cur = null;
      for (const ph of phases) if (t >= ph.from) cur = ph;
      const badge = root.querySelector('#stageBadge');
      if (cur) {
        if (cur.name !== prevStage) { badge.textContent = cur.name; prevStage = cur.name; }
        const local = t - cur.from;
        const dur = (cur.to == null ? TOTAL : cur.to) - cur.from;
        badge.style.opacity = (clamp01(local / 0.3) * clamp01((dur - local) / 0.3) * 0.98).toFixed(3);
      } else {
        badge.style.opacity = '0';
      }

      /* progress */
      root.querySelector('#progFill').style.width = (W * clamp01(t / TOTAL)).toFixed(1) + 'px';
    }

    render(0);
    return { renderAt: render };
  }

  window.CodeScenes = { create };
})();
