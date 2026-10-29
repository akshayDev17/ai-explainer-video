/* flows.md: the approval table first (every series flow and core with its reason, every skipped high-ranked row,
   the variants, the dev rows, the estimate), then the C1′ and C1 accounting, then every flow and core in full: every
   hop with how it is reached, the rule and evidence of each edge, and the cited tests with their assertion lines.
   No truncation: this is what the user approves. */
const short = id => id == null ? '' : id.endsWith(':<main>') ? id.split(':')[0].split('.').pop() + ':<main>' : id.split(':').pop();
const cell = c => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head, rows) => rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.map(cell).join(' | ')} |`)].join('\n') : '_none_';
const code = id => id ? `\`${id}\`` : '';
const span = h => `${h.file}:${h.start}-${h.end}${h.lines ? ` (lines ${h.lines.map(([a, b]) => a === b ? a : `${a}-${b}`).join(',')})` : ''}`;

const reached = h => {
  const c = h.connection;
  if (!c) return '';
  if (c.how === 'entry' || c.how === 'start') return c.how;
  if (c.how === 'variant') return 'starts a variant';
  const from = c.path[0];
  return `${c.how === 'candidate' ? 'walk' : c.how === 'edges' ? 'edges' : 'declared link'} from \`${short(from)}\`: ${c.steps.map(s => s.kind).join(' → ')}`;
};
const evidence = h => (h.connection?.steps || []).filter(s => s.rule || s.declared || (s.evidence && s.kind !== 'static')).map(s => `${s.rule || s.kind}: ${s.evidence || ''}`.trim()).join('; ');
const tests = h => h.pinnedBy.map(t => `\`${short(t.test)}\` (${t.file}:${t.line}-${t.end}, asserts at ${t.assertLines.join(', ') || '—'}${t.strength === 'reachable' ? ', reachable only: never "tested"' : ''}) — ${t.say}`).join('<br>');

export function renderFlows(v, problems, estimate, r) {
  const out = [];
  const all = [...v.flows, ...v.cores];
  const byId = new Map(all.map(x => [x.id, x]));
  out.push(`# Flows: ${(v.root || '').split('/').pop()}`, '',
    `- ${v.commit ? `commit \`${v.commit.slice(0, 7)}\` · ` : ''}tree ${(v.treeHash || '').slice(0, 19)}…`,
    `- inputs: \`${v.inputs.flows.file}\` (sha256 ${v.inputs.flows.sha256.slice(0, 12)}…), \`${v.inputs.candidates.file}\`, \`${v.inputs.ranking.file}\``,
    `- high-ranked: the top ${v.params.explainTop} production and top ${v.params.explainTopEval} eval rows, plus every row at or above the lowest-ranked row the series includes`, '');
  if (problems.length) out.push(`## ${problems.length} problem(s): not validated`, '', ...problems.map(p => `- ${p}`), '');

  out.push('## Approval table', '',
    problems.length ? 'Fix the problems above first: nothing here may be approved yet.'
      : 'Show this table to the user and ask them to approve it or edit it (add, drop, reorder, promote). Run `approve-flows` only on an explicit yes; after any edit, rerun `apply-flows` and ask again.', '');
  out.push('### The proposed series, in video order', '',
    table(['#', 'kind', 'id', 'title', 'group', 'rank', 'size', 'why'], v.series.map((s, i) => { const x = byId.get(s.id), c = x.from && r.candidates[x.from];
      return [i + 1, s.kind, code(s.id), x.title, x.group, s.rank || '—', `${x.hops.length} hops${c ? ` · ${c.own} own symbols` : ''}`, s.why]; })), '');
  const highSet = new Set(Object.values(v.triage.highRanked).flatMap(h => h.rows.map(x => x.entry)));
  out.push('### Skipped rows', '', table(['entry', 'group', 'rank', 'high-ranked', 'why'], v.skipped.map(s => [code(short(s.entry)), s.group, s.rank || '—', highSet.has(s.entry) ? 'yes' : 'no', s.why])), '');
  out.push('### Variants', '', table(['of', 'entry', 'rank', 'why'], all.flatMap(x => x.variants.map(y => [code(x.id), code(short(y.entry)), y.rank || '—', y.why]))), '');
  if (v.promote.length) out.push('### Promoted dev rows', '', table(['entry', 'rank', 'why'], v.promote.map(p => [code(short(p.entry)), p.rank || '—', p.why])), '');
  out.push('### Dev rows (filtered by default; promote one in flows.json with a reason)', '',
    table(['entry', 'kind', 'route / key', 'rank', 'status'], v.triage.entries.filter(t => t.group === 'dev').map(t => [code(short(t.id)), t.kind, t.route, t.rank ? `#${t.rank}` : '—', t.status || 'untriaged'])), '');
  if (estimate) {
    out.push(`### Estimate: ${estimate.videos.length} videos, ${estimate.totals.seriesMinutes} min (cap ${estimate.totals.capMinutes} min per video)`, '',
      'From the cost model in `flow-plan --estimate`; every constant but the narration pace is uncalibrated until the pilot measures a code video.', '',
      table(['#', 'video', 'form', 'hops', 'cited tests', 'words', 'min'], estimate.videos.map(x => [x.index, x.title, x.form, x.evidence.hops ?? '—', x.evidence.citedTests ?? '—', x.words, x.minutes])), '');
  }

  out.push('## High-ranked rows (C1′)', '');
  for (const [grp, h] of Object.entries(v.triage.highRanked)) {
    if (!h.rows.length) continue;
    const s = h.summary;
    out.push(`${grp}: ${s.highRanked} high-ranked · ${s.series} in series · ${s.variant} variant · ${s.skipped} skipped · ${s.unexplained} unexplained`, '',
      table(['rank', 'entry', 'decision', 'why'], h.rows.map(x => [`#${x.rank}`, code(short(x.entry)), x.status || '**unexplained**', x.why || ''])), '');
  }
  const t = v.triage.entries, g = grp => t.filter(x => x.group === grp), n = (xs, s) => xs.filter(x => x.status === s).length;
  out.push('## Entry triage (C1)', '',
    `${t.length + v.triage.testGroupEntries.length} entries · prod ${g('prod').length} · eval ${g('eval').length} · dev ${g('dev').length} (${n(g('dev'), 'dev-filtered')} filtered, ${n(g('dev'), 'continuation')} continuations) · ${t.filter(x => !x.status).length} untriaged · test-group entries: ${v.triage.testGroupEntries.length} (listed)`, '',
    table(['entry', 'group', 'kind', 'route / key', 'rank', 'decision', 'by', 'reason'], t.map(x => [code(x.id), x.group, x.kind, x.route, x.rank ? `#${x.rank}` : '—', x.status || '**untriaged**', x.by, x.reason])), '');
  if (v.triage.testGroupEntries.length) out.push('Entries in the test group (not flows): ' + v.triage.testGroupEntries.map(code).join(', '), '');
  if (v.excluded.length) out.push('### Exclusion rules', '', table(['match', 'why', 'matched'], v.excluded.map(x => [code(x.match), x.why, x.matched.map(short).join(', ')])), '');

  out.push('## Flows and cores', '');
  for (const s of v.series) {
    const x = byId.get(s.id);
    out.push(`### ${x.kind} \`${x.id}\`: ${x.title}`, '',
      `${x.from ? `from \`${x.from}\`${x.entry?.path ? ` (${x.entry.method} ${x.entry.path})` : x.entry?.key ? ` (${x.entry.key})` : ''} · ` : ''}group ${x.group} · ${x.rank || 'no rank'} · why: ${s.why}`, '',
      table(['#', 'hop', 'span', 'reached by', 'rule / evidence', 'cited tests', 'notes'], x.hops.map(h => [h.index, code(h.symbol), span(h), reached(h), evidence(h), tests(h),
        [h.crossing ? 'crossing' : '', h.break ? 'break' : '', h.uses ? `uses ${h.uses}` : '', h.exercises ? `exercises ${h.exercises}` : '', h.selectedBy ? `selected only by an unverified out-of-repo claim: ${h.selectedBy.outOfRepo}` : ''].filter(Boolean).join(', ')])), '');
    if (x.segments.length) out.push('Segments:', '', table(['root', 'reached from', 'via', 'own', 'decision', 'say / why'], x.segments.map(y => [code(short(y.root)), y.from ? code(short(y.from)) : '(entry)', y.kind || '', y.own, y.decision + (y.rule ? ` (${y.rule})` : ''), y.say || y.why || ''])), '');
    if (x.teach.length) out.push('Taught branches:', '', table(['point', 'at hop', 'alternatives', 'say'], x.teach.map(y => [code(y.dispatch || y.guard), y.hop,
      (y.alternatives || []).map(a => typeof a === 'string' ? code(short(a)) : a.cls ? `\`${short(a.cls)}\` when ${a.guards.join(' & ') || '(fallthrough)'}${a.sel ? ` (${Object.entries(a.sel).map(([p, s2]) => `${p}: ${s2}`).join(', ')})` : ''}` : `\`${short(a.to)}\` when ${a.guards.join(' & ')}`).join('; '), y.say])), '');
    if (x.links.length) out.push('Declared links:', '', table(['from', 'to', 'kind', 'evidence'], x.links.map(l => [code(short(l.from)), code(short(l.to)), l.kind, l.evidence])), '');
  }
  const shared = new Map();
  // a hop that `uses` the core holding the same symbol is that core's reference, not a second narration
  const refersToCore = h => h.uses && byId.get(h.uses)?.hops.some(y => y.symbol === h.symbol);
  for (const x of all) for (const h of x.hops) if (!refersToCore(h)) (shared.get(h.symbol) || shared.set(h.symbol, []).get(h.symbol)).push(x.id);
  const twice = [...shared].filter(([, ids]) => ids.length > 1);
  out.push('## Hops kept by two or more flows', '', 'A sequence kept by two or more flows is a core candidate; a hop listed here is narrated in each.', '',
    table(['hop', 'kept by'], twice.map(([s, ids]) => [code(s), ids.join(', ')])), '');
  out.push('## Out-of-repo claims (unverified)', '', table(['claim', 'evidence', 'selects'], v.outOfRepo.map(o => [o.claim, o.evidence, o.selects.map(code).join(', ')])), '');
  out.push('## Test configuration', '', 'Mocks every test under a conftest runs with: a claim that a test exercises one of these targets is false.', '',
    table(['target', 'scope', 'where'], [...v.tests.sessionMocks.map(x => [code(x.target), 'session', x.conftest]), ...v.tests.autouseMocks.map(x => [code(x.target), 'autouse fixture', code(x.fixture)])]), '');
  return out.join('\n');
}
