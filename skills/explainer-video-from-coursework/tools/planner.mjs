#!/usr/bin/env node
/* =============================================================================
   planner.mjs — turn a directory of source notes into a VIDEO SERIES PLAN.

   This is the stage that decides HOW MANY videos a body of content needs, in
   what form, in what order — and proves nothing was silently dropped.

   Usage:
     node tools/planner.mjs <sourceDir> --out out/<name> [--max-min 14] [--title "..."]

   Pipeline position:
     source notes -> [PLANNER] -> plan.json -> script -> scene -> audio -> video

   Design rules:
     • Every number is derived and printed, so the plan can be argued with.
     • Coverage is ASSERTED, not assumed: every source section lands on a video
       or is excluded with a stated reason. Orphans are reported as failures.
     • Form is inferred from evidence (code ratio, link ratio, diagram markers)
       and the evidence is emitted alongside the verdict.
   ========================================================================== */

import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, extname, basename, sep } from 'node:path';
import { WPM, EXPANSION } from './model.mjs';

/* ---------------- tunable model ---------------- */
const DEFAULTS = {
  wpm: WPM,          // narration words per minute — measured, see model.mjs
  expansion: EXPANSION, // visual/beat overhead on top of pure narration time — measured
  maxMin: 14,        // per-video hard cap
  minMin: 2.5,       // below this, try to merge with a sibling
  codeNarration: 0.15,  // fraction of code words that get narrated (you show, then explain briefly)
  tableNarration: 0.40, // tables get condensed, not read out
};

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
const sourceDir = argv.find(a => !a.startsWith('--'));
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? d : argv[i + 1];
};
if (!sourceDir) {
  console.error('usage: node tools/planner.mjs <sourceDir> --out <outDir> [options]');
  process.exit(1);
}
const CFG = {
  ...DEFAULTS,
  wpm: parseFloat(flag('wpm', DEFAULTS.wpm)),
  expansion: parseFloat(flag('expansion', DEFAULTS.expansion)),
  maxMin: parseFloat(flag('max-min', DEFAULTS.maxMin)),
  minMin: parseFloat(flag('min-min', DEFAULTS.minMin)),
  outDir: flag('out', 'out/plan'),
  title: flag('title', basename(sourceDir.replace(/\/+$/, ''))),
};
const CAP_SEC = CFG.maxMin * 60;
const MIN_SEC = CFG.minMin * 60;
// Pack to slightly under the cap so a heading's own intro prose can still be
// attached to the video it belongs to without breaching the real limit.
const PACK_CAP = CAP_SEC * 0.97;

/* =============================================================================
   1. Walk the source tree
   ========================================================================== */
function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, base));
    else out.push({ path: p, rel: relative(base, p), ext: extname(p).toLowerCase(), bytes: st.size });
  }
  return out;
}
// Fail cleanly on a bad path rather than emitting a raw ENOENT stack trace.
if (!existsSync(sourceDir)) {
  console.error(`[planner] source directory not found: ${sourceDir}`);
  process.exit(1);
}
if (!statSync(sourceDir).isDirectory()) {
  console.error(`[planner] not a directory: ${sourceDir}`);
  process.exit(1);
}
const files = walk(sourceDir);
const mdFiles = files.filter(f => f.ext === '.md');
const codeFiles = files.filter(f => ['.java', '.py', '.ts', '.js', '.go', '.cpp', '.c', '.rs'].includes(f.ext));

// Refuse to plan nothing. An empty or all-code directory used to produce a
// silent "1 video, 0 min" plan, which reads as success and is useless.
if (!mdFiles.length) {
  console.error(`[planner] no markdown files under ${sourceDir}`);
  console.error(`          found ${files.length} file(s), none of them .md — nothing to plan.`);
  console.error('          (only .md is parsed; .mdx/.rst/.txt/.ipynb are not supported yet)');
  process.exit(1);
}

/* =============================================================================
   2. Parse markdown into a section list, with code fences respected
   ========================================================================== */
const LINK_RE = /(https?:\/\/|\[[^\]]*\]\([^)]*\))/;
// A fence may sit behind a list marker ("5. ```java"). Missing that desynchronises
// the fence state and silently swallows every later heading in the file.
const FENCE_RE = /^(?:[-*+]\s+|\d+[.)]\s+)?```/;
const DIAGRAM_LANG = /^(mermaid|plantuml|graphviz|dot|d2)\b/i;

function parseMarkdown(rel, text) {
  const lines = text.split('\n');
  const sections = [];      // {level, title, line, endLine, prose, code, diagram, table, link}
  let fence = false;
  let fenceLang = '';
  let cur = { level: 0, title: '(preamble)', line: 0, prose: 0, code: 0, diagram: 0, table: 0, link: 0, codeBlocks: 0 };
  const flush = (endLine) => { cur.endLine = endLine; sections.push(cur); };

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();

    if (FENCE_RE.test(line.trim())) {
      if (!fence) {
        fence = true; cur.codeBlocks++;
        fenceLang = line.trim().replace(FENCE_RE, '').trim().split(/\s+/)[0] || '';
      } else fence = false;
      return;
    }
    if (fence) {
      const w = line.split(/\s+/).filter(Boolean).length;
      // A diagram fence is a visual to render, not code to narrate — it must
      // not inflate codeRatio (that was misclassifying mermaid as `code`).
      if (DIAGRAM_LANG.test(fenceLang)) cur.diagram += w; else cur.code += w;
      return;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush(i);
      cur = {
        level: h[1].length,
        title: h[2].replace(/<a\s+name="[^"]*">\s*<\/a>/gi, '').replace(/<[^>]+>/g, '').trim(),
        line: i, prose: 0, code: 0, diagram: 0, table: 0, link: 0, codeBlocks: 0,
      };
      return;
    }

    const words = line.split(/\s+/).filter(Boolean).length;
    if (!words) return;
    if (LINK_RE.test(line) && words < 14) cur.link += words;    // link/list lines aren't narrated verbatim
    else if (/^\s*\|/.test(line)) cur.table += words;           // table row
    else cur.prose += words;
  });
  flush(lines.length);

  // narratable words for a section (cost model)
  const cost = s => s.prose + CFG.codeNarration * s.code + CFG.tableNarration * s.table;
  sections.forEach(s => { s.src = rel; s.narratable = Math.round(cost(s)); });
  return sections.filter(s => s.title !== '(preamble)' || s.prose > 0);
}

/* =============================================================================
   3. Build a single section list across all markdown, then a tree
   ========================================================================== */
let allSections = [];
const parseDiag = [];
for (const f of mdFiles) {
  const text = readFileSync(f.path, 'utf8');
  const secs = parseMarkdown(f.rel, text);
  secs.forEach(s => { s.file = f.rel; });
  allSections = allSections.concat(secs);
  // Self-check: coverage can only assert over what the parser SAW. If the parser
  // silently swallowed headings, coverage passes vacuously. Compare against the
  // raw count of heading-like lines (the delta is usually code comments in fences).
  const rawHeadings = text.split('\n').filter(l => /^#{1,6}\s/.test(l.trim())).length;
  parseDiag.push({ file: f.rel, rawHeadingLines: rawHeadings, parsedHeadings: secs.filter(s => s.title !== '(preamble)').length });
}

// tree from heading levels. Each FILE gets its own node under the root, so
// packing can never merge unrelated files into one video.
const root = { id: 'root', title: CFG.title, level: -1, children: [], own: 0, src: '', isRoot: true };
function buildTree(secs, parent) {
  const stack = [parent];
  for (const s of secs) {
    while (stack.length && stack[stack.length - 1].level >= s.level) stack.pop();
    const parentNode = stack.length ? stack[stack.length - 1] : parent;
    const n = {
      id: `${s.file}:${s.line}`, title: s.title, level: s.level, src: s.file,
      own: s.narratable, prose: s.prose, code: s.code, diagram: s.diagram, table: s.table, link: s.link,
      children: [], section: s,
    };
    parentNode.children.push(n);
    stack.push(n);
  }
  return parent;
}

const byFile = {};
allSections.forEach(s => { (byFile[s.file] = byFile[s.file] || []).push(s); });
for (const f of Object.keys(byFile)) {
  const h1s = byFile[f].filter(s => s.level === 1);
  // A file whose first H1 is just the first of MANY H1s (OOP/README.md) has no
  // real document title. Prefer the containing directory name — "OOP", not "README".
  const dir = f.includes(sep) ? f.split(sep).slice(-2, -1)[0] : null;
  const title = h1s.length === 1 ? h1s[0].title : (dir || basename(f, '.md'));
  const fileNode = {
    id: 'file:' + f, title, level: 0, children: [], own: 0, src: f, isFile: true,
  };
  root.children.push(fileNode);
  buildTree(byFile[f], fileNode);
}

/* path from root down to a node, for lowest-common-ancestor lookups */
function pathTo(target, node = root, chain = []) {
  const c = chain.concat(node);
  if (node === target) return c;
  for (const k of node.children) {
    const r = pathTo(target, k, c);
    if (r) return r;
  }
  return null;
}
/** deepest node that is an ancestor-or-self of every unit */
function commonAncestor(units) {
  if (!units.length) return root;
  const paths = units.map(u => pathTo(u)).filter(Boolean);
  if (!paths.length) return root;
  let lca = root;
  const min = Math.min(...paths.map(p => p.length));
  for (let i = 0; i < min; i++) {
    const cand = paths[0][i];
    if (paths.every(p => p[i] === cand)) lca = cand; else break;
  }
  return lca;
}

const durOf = node => node.own + node.children.reduce((a, c) => a + durOf(c), 0);
const secsOf = node => (node.own > 0 || node.diagram > 0 || !node.children.length ? [node] : []).concat(node.children.flatMap(secsOf));
const toSec = words => (words / CFG.wpm) * 60 * CFG.expansion;

/* =============================================================================
   4. Exclude navigation sections — and nothing else

   There used to be an "index pointer" inference here: if a section's title
   contained a directory name, and that directory held 2x the words, the section
   was excluded as a mere summary of that source. It was DELETED because:

     • it silently dropped real content on unfamiliar trees — a section titled
       "☕ Java" matched an unrelated JAVA/ directory elsewhere in the tree;
     • gating it behind a flag only moved the problem onto the user, who cannot
       know which directories are "index targets" in a folder they just pointed us at;
     • measured on the reference tree it changed neither the video count, nor the
       orphan count, nor the longest video — only the total, by 3 minutes in 59.

   So there is no name-based inference. Navigation headings are the one
   unambiguous case, and that is all we remove. Everything else is planned.
   ========================================================================== */
const overlaps = [];
(function detectNav(node) {
  for (const ch of node.children) {
    if (/(table of contents|^contents$|^toc$|^index$)/i.test(ch.title)) {
      ch.excluded = true;
      ch.indexOf = 'TOC';
      overlaps.push({ section: ch.title, src: ch.src, child: '(navigation — not content)', ownWords: durOf(ch), childWords: 0 });
    }
    detectNav(ch);
  }
})(root);

/* =============================================================================
   5. Pack the tree into videos under the cap
   ========================================================================== */
const live = node => !node.excluded;
function packNode(node) {
  const total = durOf(node);
  // seconds vs seconds — comparing words here silently changes the effective cap
  if (toSec(total) <= CAP_SEC && node !== root) return [{ units: [node], words: total }];

  const out = [];
  let cur = null;
  let carried = 0;
  for (const ch of node.children.filter(live)) {
    for (const v of packNode(ch)) {
      // compare in SECONDS, not words. Also: never glue two different source
      // files into one video — OOP foundations do not belong with the intro.
      const sameFile = cur && cur.units.length && v.units.length && cur.units[0].src === v.units[0].src;
      if (sameFile && toSec(cur.words + v.words) <= PACK_CAP) {
        cur.units.push(...v.units);
        if (v.ownOnly) (cur.ownOnly = cur.ownOnly || []).push(...v.ownOnly);  // don't drop container prose
        cur.words += v.words;
      } else {
        cur = { units: [...v.units], ownOnly: v.ownOnly ? [...v.ownOnly] : [], words: v.words };
        out.push(cur);
      }
    }
  }
  // A heading's own prose has to live somewhere. Attach the NODE but keep it in
  // `ownOnly` — expanding it via secsOf() would falsely claim its whole subtree,
  // which belongs to other videos.
  if (node.own > 0 && !node.isRoot) {
    if (out.length) { (out[0].ownOnly = out[0].ownOnly || []).push(node); out[0].words += node.own; }
    else out.push({ units: [], ownOnly: [node], words: node.own });
  }
  return out.length ? out : [{ units: [node], words: total }];
}

let videos = packNode(root);

// merge runs that are individually too small, when they share a parent and fit
for (let i = 0; i < videos.length - 1; i++) {
  const a = videos[i], b = videos[i + 1];
  const pa = a.units[0], pb = b.units[0];
  const sameSrc = pa.src === pb.src;
  if (toSec(a.words) < MIN_SEC && sameSrc && toSec(a.words + b.words) <= CAP_SEC) {
    // preserve ownOnly: container prose attached to either half must not vanish
    videos[i] = {
      units: a.units.concat(b.units),
      ownOnly: (a.ownOnly || []).concat(b.ownOnly || []),
      words: a.words + b.words,
    };
    videos.splice(i + 1, 1);
    i--;
  }
}

/* =============================================================================
   6. Classify form from evidence
   ========================================================================== */
function classify(v) {
  const agg = { prose: 0, code: 0, diagram: 0, table: 0, link: 0, text: '' };
  v.units.forEach(u => secsOf(u).forEach(s => {
    agg.prose += s.prose || 0; agg.code += s.code || 0; agg.diagram += s.diagram || 0;
    agg.table += s.table || 0; agg.link += s.link || 0;
    agg.text += ' ' + (s.title || '');
  }));
  const total = agg.prose + agg.code + agg.diagram + agg.table + agg.link || 1;
  const codeRatio = agg.code / total;
  const diagramRatio = agg.diagram / total;
  const linkRatio = agg.link / total;
  const paths = v.units.map(u => u.src).join(' ').toLowerCase();
  const ev = { codeRatio: +codeRatio.toFixed(3), diagramRatio: +diagramRatio.toFixed(3), linkRatio: +linkRatio.toFixed(3) };

  // the code artefacts that sit alongside this video's sources
  const prefixes = new Set(v.units.map(u => u.src.split(sep).slice(0, -1).join(sep)));
  const artefacts = codeFiles
    .filter(f => Array.from(prefixes).some(p => p && f.rel.startsWith(p + sep)) || (prefixes.has('') && !f.rel.includes(sep)))
    .map(f => f.rel);

  if (linkRatio > 0.5) return { form: 'resources', why: `linkRatio ${linkRatio.toFixed(2)} — a link list, not narratable`, artefacts, ev };
  if (/violation|rectified|before|after/.test(paths)) return { form: 'refactor', why: 'source pair reads as before/after', artefacts, ev };
  if (diagramRatio > 0.3 || /diagram|uml|notation|mermaid|sequence|state machine/.test(agg.text.toLowerCase()))
    return { form: 'diagram', why: `diagramRatio ${diagramRatio.toFixed(2)} — mermaid/plantuml fences or diagram markers`, artefacts, ev };
  if (/problem|taxonomy|catalog|directory|questions/.test(agg.text.toLowerCase()) && agg.table + agg.link > total * 0.3)
    return { form: 'catalogue', why: 'enumerated problem/table listing', artefacts, ev };
  if (codeRatio > 0.35) return { form: 'code', why: `codeRatio ${codeRatio.toFixed(2)}`, artefacts, ev };
  return { form: 'concept', why: 'prose-dominant explanatory content', artefacts, ev };
}

const cleanTitle = t => t
  .replace(/^[\d.]+\s*/, '')
  .replace(/^Phase\s*\d+\s*:?\s*/i, '')
  .replace(/[📑☕⚙️🐍🐹🎯🔒✅❌]/g, '')
  .replace(/<[^>]+>/g, '')
  .trim();

videos.forEach((v, i) => {
  const c = classify(v);
  v.index = i + 1;
  v.form = c.form;
  v.formWhy = c.why;
  v.evidence = c.ev;
  v.artefacts = c.artefacts;

  // Title from the DEEPEST COMMON ANCESTOR of the units, not from the first one.
  // Otherwise a video holding five principles gets named after whichever came first.
  const lcaNode = commonAncestor(v.units);
  const lcaTitle = cleanTitle(lcaNode.title || '');
  let title;
  if (lcaTitle && !lcaNode.isRoot && lcaTitle.length <= 48) {
    title = lcaTitle;                       // a tight, meaningful ancestor
  } else {
    // units span a whole file: name the video after its own content range,
    // ignoring container headings that carry almost no narration
    const ts = v.units
      .map(u => ({ t: cleanTitle(u.title), w: u.own }))
      .filter(x => x.t && x.w > 5 && x.t.length <= 56)
      .map(x => x.t.length > 40 ? x.t.slice(0, 38) + '…' : x.t);
    if (!ts.length) title = lcaTitle ? lcaTitle.slice(0, 40) + '…' : `Part ${i + 1}`;
    else if (ts.length === 1) title = ts[0];
    else if (ts.length === 2) title = ts.join(' & ');
    else title = `${ts[0]} → ${ts[ts.length - 1]}`;
  }
  v.title = title;
  v.coveredHeading = lcaNode.isFile ? lcaNode.src : (lcaNode.title || '');

  v.seconds = Math.round(toSec(v.words));
  v.minutes = +(v.seconds / 60).toFixed(1);

  const expanded = v.units.flatMap(u => secsOf(u).map(s => ({
    src: s.src, title: s.title, narratable: s.narratable || 0,
    line: s.section ? s.section.line + 1 : null,      // 1-based inclusive span
    endLine: s.section ? s.section.endLine : null,
  })));
  const ownOnly = (v.ownOnly || []).map(n => ({
    src: n.src, title: n.title, narratable: n.own,
    line: n.section ? n.section.line + 1 : null,
    endLine: n.section ? n.section.endLine : null,
  }));
  // Section identity is (src, line): a heading's line number is unique within a
  // file, so two same-title headings ("Analogy", "Appendix") stay distinct.
  // Keying on src||title collapsed them — that was the lossy-identity bug.
  const seen = new Set();
  v.sections = expanded.concat(ownOnly).filter(s => {
    const k = s.src + ':' + s.line;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  v.sources = Array.from(new Set(v.sections.map(s => s.src)));
});

/* =============================================================================
   7. Coverage assertion
   ========================================================================== */
const covered = new Set();
videos.forEach(v => v.sections.forEach(s => covered.add(s.src + ':' + s.line)));
const coverage = allSections.map(s => {
  const line1 = s.line + 1;                    // v.sections stores 1-based line
  const owner = videos.find(v => v.sections.some(x => x.src === s.src && x.line === line1));
  const idxOwner = overlaps.find(o => o.src === s.src && o.section === s.title);
  return {
    src: s.src, title: s.title, line: line1, narratable: s.narratable,
    video: owner ? owner.index : null,
    excluded: idxOwner ? `index pointer -> ${idxOwner.child}/` : null,
    reason: idxOwner ? 'summary of a dedicated source; that source is the video' : null,
  };
});
// Only sections that actually CARRY content can be orphaned. A container
// heading with no prose of its own is structure, not an uncovered topic.
const contentCoverage = coverage.filter(c => c.narratable > 0);
const structuralCoverage = coverage.filter(c => c.narratable === 0);
const orphans = contentCoverage.filter(c => !c.video && !c.excluded);

/* =============================================================================
   8. Emit
   ========================================================================== */
const totalSec = videos.reduce((a, v) => a + v.seconds, 0);
// hard invariant: nothing may exceed the cap
const capViolations = videos.filter(v => v.seconds > CAP_SEC);
const plan = {
  generatedFrom: sourceDir,
  model: { wpm: CFG.wpm, expansion: CFG.expansion, maxVideoMin: CFG.maxMin, minVideoMin: CFG.minMin },
  sourceStats: {
    markdownFiles: mdFiles.length,
    codeFiles: codeFiles.length,
    markdownWords: mdFiles.reduce((a, f) => a + readFileSync(f.path, 'utf8').split(/\s+/).length, 0),
    narratableWords: allSections.reduce((a, s) => a + s.narratable, 0),
  },
  totals: {
    videos: videos.length,
    seriesMinutes: +(totalSec / 60).toFixed(1),
    longestVideoMin: Math.max(...videos.map(v => v.minutes)),
    capMinutes: CFG.maxMin,
    rawNarrationMinutes: +(allSections.reduce((a, s) => a + s.narratable, 0) / CFG.wpm).toFixed(1),
  },
  excluded: overlaps,
  parserDiag: parseDiag,
  coverage,
  orphans,
  videos: videos.map(v => ({
    index: v.index, title: v.title, form: v.form, formWhy: v.formWhy,
    minutes: v.minutes, seconds: v.seconds, words: v.words,
    sources: v.sources, artefacts: v.artefacts, evidence: v.evidence,
    sections: v.sections.map(s => `${s.src} :: ${s.title} @L${s.line}`),
    sectionSpans: v.sections.map(s => ({ id: `${s.src} :: ${s.title} @L${s.line}`, src: s.src, title: s.title, line: s.line, endLine: s.endLine })),
  })),
};

mkdirSync(CFG.outDir, { recursive: true });
writeFileSync(join(CFG.outDir, 'plan.json'), JSON.stringify(plan, null, 2));

/* ---- human-readable report ---- */
const L = [];
L.push(`# ${CFG.title} — video series plan`, '');
L.push(`Source: \`${sourceDir}\``);
L.push(`Markdown: ${plan.sourceStats.markdownFiles} files, ${plan.sourceStats.markdownWords} words · Code: ${plan.sourceStats.codeFiles} files`);
L.push(`Narratable: ${plan.sourceStats.narratableWords} words → **${plan.totals.rawNarrationMinutes} min** of pure narration`);
L.push('');
L.push(`Model: ${CFG.wpm} wpm × ${CFG.expansion} overhead · cap **${CFG.maxMin} min/video**`);
L.push('');
L.push(`## Result: ${plan.totals.videos} videos, ${plan.totals.seriesMinutes} min total (longest ${plan.totals.longestVideoMin} min)`, '');
L.push('| # | Video | Form | Min | Sources | Code |');
L.push('|---|---|---|---|---|---|');
videos.forEach(v => {
  L.push(`| ${v.index} | ${v.title} | \`${v.form}\` | ${v.minutes} | ${v.sources.join(', ')} | ${v.artefacts.length} |`);
});
L.push('');
L.push('### Form evidence', '');
videos.forEach(v => L.push(`- **${v.index}. ${v.title}** → \`${v.form}\` — ${v.formWhy} ${JSON.stringify(v.evidence)}`));
if (overlaps.length) {
  L.push('', '### Excluded (navigation headings, not content)', '');
  overlaps.forEach(o => L.push(`- \`${o.src}\` :: "${o.section}" (${o.ownWords}w) → ${o.child}`));
}
if (capViolations.length) {
  L.push('', `**⚠️ ${capViolations.length} video(s) exceed the ${CFG.maxMin}-min cap:**`);
  capViolations.forEach(v => L.push(`- ${v.index}. ${v.title} — ${v.minutes} min`));
}
L.push('', '### Parser self-check (did we actually SEE every heading?)', '');
parseDiag.forEach(d => {
  const delta = d.rawHeadingLines - d.parsedHeadings;
  L.push(`- \`${d.file}\`: ${d.rawHeadingLines} heading-like lines, ${d.parsedHeadings} parsed${delta ? ` (delta ${delta} — expected: code comments inside fences)` : ''}`);
});
L.push('', '### Coverage', '');
L.push(`${coverage.length} headings · ${contentCoverage.length} carry content · ${structuralCoverage.length} are structural containers`);
L.push(`${contentCoverage.filter(c => c.video).length} assigned · ${contentCoverage.filter(c => c.excluded).length} excluded as navigation · **${orphans.length} orphaned**`);
if (orphans.length) {
  L.push('', '**ORPHANS (content nothing covers):**');
  orphans.forEach(o => L.push(`- ⚠️ ${o.src} :: ${o.title} @L${o.line} (${o.narratable} narratable words)`));
} else {
  L.push('', '✅ No orphans — every content-bearing section is either assigned to a video or is a navigation heading.');
}
writeFileSync(join(CFG.outDir, 'plan.md'), L.join('\n') + '\n');

/* ---- console summary ---- */
console.log(L.slice(0, 12).join('\n'));
console.log(`\n[out] ${join(CFG.outDir, 'plan.json')}`);
console.log(`[out] ${join(CFG.outDir, 'plan.md')}`);
if (orphans.length) { console.log(`\n⚠️  ${orphans.length} orphaned section(s)`); process.exitCode = 2; }
