/* Validated flows → videos (design §4.5): the cost model and the splitting rules, shared by flow-plan.mjs and by
   apply-flows' estimate in the approval table. Every constant except WPM and EXPANSION (measured on coursework,
   imported from its model.mjs) is an uncalibrated estimate until the pilot measures code videos.

     words(video) = FRAME + Σ_hops (HOP_BASE + WPL × narrated(h)) + Σ_crossings BOUNDARY + Σ_taught branches BRANCH
                  + min(MAX_TESTS, cited tests) × TEST
     narrated(h)  = h.lines ? count(h.lines) : min(LINE_CAP, ceil(NARRATE × span lines))
     minutes      = words / WPM × EXPANSION

   Splitting: a hop with `break` starts a new video; hops pack greedily under the cap; on overflow the video splits at
   its latest crossing, else at the overflowing hop (a hop is never split); flows and cores are never glued together;
   a piece under the minimum merges with a neighbour of the same item when the two fit. One overview video opens
   the series. */
import { WPM, EXPANSION } from '../../../explainer-video-from-coursework/tools/model.mjs';

export const MODEL = { wpm: WPM, expansion: EXPANSION, frame: 150, hopBase: 60, wpl: 8, lineCap: 22, narrate: 0.5, boundary: 60, branch: 80,
  prompt: 12, test: 30, maxTests: 3, overview: 1000, calibrated: false };

export const narratedLines = h => h.lines ? h.lines.reduce((a, [x, y]) => a + y - x + 1, 0) : Math.min(MODEL.lineCap, Math.ceil(MODEL.narrate * (h.end - h.start + 1)));
const hopWords = h => MODEL.hopBase + MODEL.wpl * narratedLines(h);
const seconds = words => Math.round((words / MODEL.wpm) * 60 * MODEL.expansion);
export const section = h => `${h.file} :: ${h.name} @L${h.start}`;

// the words of one video holding `hops` of an item whose taught branches sit on the hops listed in `teach`
function cost(hops, teach) {
  const at = new Set(hops.map(h => h.index));
  const branches = teach.filter(t => at.has(t.hop)).length, cited = hops.reduce((a, h) => a + h.pinnedBy.length, 0);
  const crossings = hops.filter(h => h.crossing).length;
  const words = MODEL.frame + hops.reduce((a, h) => a + hopWords(h), 0) + crossings * MODEL.boundary + branches * MODEL.branch + Math.min(MODEL.maxTests, cited) * MODEL.test;
  return { words, seconds: seconds(words), crossings, branches, cited: Math.min(MODEL.maxTests, cited) };
}

// one item's hops → pieces under the cap
function split(item, capSec, minSec) {
  const groups = [];
  for (const h of item.hops) { if (!groups.length || (h.break && h.index !== item.hops[0].index)) groups.push([]); groups.at(-1).push(h); }
  const pieces = [];
  groups.forEach((g, gi) => {
    let cur = [];
    for (const h of g) {
      if (cur.length && cost([...cur, h], item.teach).seconds > capSec) {
        const k = cur.findLastIndex((x, i) => i > 0 && x.crossing);
        if (k > 0) { pieces.push({ hops: cur.slice(0, k), group: gi }); cur = cur.slice(k); }
        if (cur.length && cost([...cur, h], item.teach).seconds > capSec) { pieces.push({ hops: cur, group: gi }); cur = []; }
      }
      cur.push(h);
    }
    pieces.push({ hops: cur, group: gi });
  });
  for (let i = 0; i < pieces.length; i++) {
    if (pieces.length < 2 || cost(pieces[i].hops, item.teach).seconds >= minSec) continue;
    const fits = j => pieces[j] && pieces[j].group === pieces[i].group && cost([...pieces[Math.min(i, j)].hops, ...pieces[Math.max(i, j)].hops], item.teach).seconds <= capSec;
    const j = fits(i - 1) ? i - 1 : fits(i + 1) ? i + 1 : null;
    if (j == null) continue;
    const [a, b] = [Math.min(i, j), Math.max(i, j)];
    pieces.splice(a, 2, { hops: [...pieces[a].hops, ...pieces[b].hops], group: pieces[a].group });
    i = a - 1;
  }
  return pieces;
}

export function planVideos(v, { maxMin = 25, minMin = 2.5 } = {}) {
  const capSec = maxMin * 60, minSec = minMin * 60;
  const items = new Map([...v.flows, ...v.cores].map(x => [x.id, x]));
  const videos = [], coverage = [];
  const overviewSec = seconds(MODEL.overview);
  videos.push({ index: 1, title: 'Series overview', form: 'overview', group: 'overview', flowGroup: null, words: MODEL.overview, seconds: overviewSec, minutes: +(overviewSec / 60).toFixed(1),
    formWhy: 'one system map per series: the processes, the stores, and every flow and core as a route through them', sources: [], artefacts: [],
    evidence: { items: v.series.length },
    sections: v.series.map(s => `${s.id} :: ${s.title}`),
    sectionSpans: v.series.map(s => ({ id: `${s.id} :: ${s.title}`, src: 'flows.validated.json', title: s.title, item: s.id, kind: s.kind, why: s.why })) });
  for (const s of v.series) {
    const item = items.get(s.id), pieces = split(item, capSec, minSec);
    pieces.forEach((p, i) => {
      const c = cost(p.hops, item.teach), index = videos.length + 1;
      for (const h of p.hops) coverage.push({ item: item.id, hop: h.index, symbol: h.symbol, section: section(h), video: index });
      const at = new Set(p.hops.map(h => h.index));
      videos.push({ index, title: pieces.length > 1 ? `${item.title} (part ${i + 1} of ${pieces.length})` : item.title, form: item.kind, group: item.id, flowGroup: item.group,
        words: c.words, seconds: c.seconds, minutes: +(c.seconds / 60).toFixed(1), formWhy: s.why,
        sources: [...new Set(p.hops.map(h => h.file))], artefacts: [...new Set(p.hops.flatMap(h => h.pinnedBy.map(t => t.file)))],
        evidence: { hops: p.hops.length, crossings: c.crossings, branches: c.branches, citedTests: c.cited, part: `${i + 1}/${pieces.length}`, rank: item.rank || null },
        teach: item.teach.filter(t => at.has(t.hop)),
        sections: p.hops.map(section),
        sectionSpans: p.hops.map(h => ({ id: section(h), src: h.file, title: h.name, line: h.start, endLine: h.end, symbol: h.symbol, sha256: h.sha256, item: item.id, hop: h.index,
          lines: h.lines, narratedLines: narratedLines(h), crossing: h.crossing, uses: h.uses, exercises: h.exercises, pinnedBy: h.pinnedBy })) });
    });
  }
  const assigned = new Set(coverage.map(c => `${c.item}#${c.hop}`));
  const orphans = [...items.values()].flatMap(x => x.hops.filter(h => !assigned.has(`${x.id}#${h.index}`)).map(h => ({ item: x.id, hop: h.index, symbol: h.symbol })));
  const capViolations = videos.filter(x => x.seconds > capSec).map(x => ({ index: x.index, minutes: x.minutes }));
  const total = videos.reduce((a, x) => a + x.seconds, 0);
  return { videos, coverage, orphans, capViolations,
    totals: { videos: videos.length, seriesMinutes: +(total / 60).toFixed(1), longestVideoMin: Math.max(...videos.map(x => x.minutes)), capMinutes: maxMin,
      hops: coverage.length, flows: v.flows.length, cores: v.cores.length } };
}
