/* ranking.md: every row of every group with its evidence columns, the shared heavily-tested table, every
   continuation with its parent, the merged prod+eval order, and for the top rows of prod and eval their segments,
   config-dependent dispatch points and config-guarded branches. No row is marked chosen: the agent proposes. */
const short = id => id.endsWith(':<main>') ? id.split(':')[0].split('.').pop() + ':<main>' : id.split(':').pop();
const table = (head, rows) => rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.map(c => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n') : '_none_';
const what = x => x.path ? `${x.method} ${x.path}` : x.key || '';
const pct = x => `${Math.round(100 * x)}%`;

// a dispatch point whose targets depend on config: narrowed by a config read, picked by selectors, or a collaborator
// with more than one concrete implementation; one per site and target set, however many times the walk passed it
export const configDispatchPoints = dispatch => { const seen = new Set();
  return dispatch.filter(d => d.config || d.selectors || (d.collaborator && d.after > 1)).filter(d => { const key = d.site + d.targets.join(); return !seen.has(key) && seen.add(key); }); };

export function renderRanking(k, r) {
  const out = [];
  const t = k.totals;
  out.push(`# Ranking: ${(k.root || '').split('/').pop()}`, '',
    `- ${k.commit ? `commit \`${k.commit.slice(0, 7)}\` · ` : ''}tree ${(k.treeHash || '').slice(0, 19)}…`,
    `- top-level candidates: prod ${t.topLevel.prod}, eval ${t.topLevel.eval}, dev ${t.topLevel.dev} · ${t.continuations} continuations · universes prod ${t.universe.prod}, eval ${t.universe.eval}, dev ${t.universe.dev} own symbols`,
    `- walk: same-group fan-in >= ${r.params.fanin} with a subtree <= ${r.params.leafy} folds a helper · interface folding ${r.params.ifaceFold ? 'on' : 'off'}`, '',
    'Each group is ordered by the new own code a row adds (`gain`), ties by more crossings. **There is no cut line and no series**: ' +
    'new code is not important code. Read `nearest (J)` to judge "same flow" against "different flow", and the test, eval and config ' +
    'columns for importance the order cannot see. Every high-ranked row needs a decision with a reason in `flows.json`.', '',
    'Columns: `own` expanded symbols · `cross` crossings (queue, HTTP, spawn) · `pinned` own functions with a direct test link · ' +
    '`tests` distinct tests pinning own code · `new` tests pinning only this row\'s new code · `cfg` config-dependent dispatch points · `evals` eval candidates exercising this row.', '');

  const rows = (grp, xs) => table(['rank', 'gain', 'cum', 'kind', 'entry', 'route / key', 'own', 'cross', 'nearest (J)', 'pinned', 'tests', 'new', 'cfg', 'evals'],
    xs.map(x => [x.rank, x.gain, pct(x.coverage), x.kind, `\`${short(x.entry)}\``, what(x), x.own, x.crossings,
      x.nearest ? `#${xs.find(y => y.entry === x.nearest).rank} \`${short(x.nearest)}\` (${x.jaccard})` : '—', x.pinned, x.tests, x.testsNew, x.cfg,
      grp === 'prod' ? x.evals.map(e => `\`${short(e)}\``).join(', ') : x.evals.length]));
  const prodRank = new Map(k.ranked.prod.map(x => [x.entry, x.rank]));
  const flow = f => f.flowRank ? ` (in #${f.flowRank})` : '';

  out.push(`## prod: ${t.topLevel.prod} rows`, '', rows('prod', k.ranked.prod), '');
  out.push(`## eval: ${t.topLevel.eval} rows`, '', 'Eval flows are ranked in their own group and never filtered: account for each high-ranked row (include, variant, or skip with a reason). ' +
    'An eval walk folds the production code it calls into `uses-prod` leaves; its crossings into production are `exercises` links, not continuations.', '', rows('eval', k.ranked.eval), '');
  const KIND_ORDER = ['http', 'queue', 'spawn'];
  const byKind = xs => [...xs].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  out.push('### What each eval row exercises in production', '', 'A spawn link is a process the harness starts (a worker, a scheduler) and every consumer it serves.', '',
    table(['rank', 'entry', 'exercises (crossings)', 'other uses-prod leaves'], k.ranked.eval.map(x => { const crossed = new Set(x.exercises.map(e => e.to));
      return [x.rank, `\`${short(x.entry)}\``, byKind(x.exercises).map(e => `${e.kind} \`${short(e.to)}\`${flow(e)}`).join(', ') || '—',
        x.usesProd.filter(u => !crossed.has(u.id)).map(u => `\`${short(u.id)}\`${flow(u)}`).join(', ') || '—']; })), '');
  out.push(`## dev: ${t.topLevel.dev} rows (filtered by default)`, '', 'Migrations, dev routes, debug, verification and ops scripts: printed, not proposed. Promote a row in `flows.json` with a reason.', '',
    rows('dev', k.ranked.dev), '');

  out.push('## Shared, heavily tested production code', '',
    'Production modules whose functions appear in at least 3 production rows and that at least 5 tests pin directly. Cross-cutting code (auth, retry, tokens) ' +
    'has no entry point, so the order above counts it only inside the first row that reaches it.', '',
    table(['module', 'in rows', 'first owner', 'functions', 'direct tests'], k.shared.map(x => [`\`${x.module}\``, x.candidates, `#${x.firstOwner} \`${short(x.firstOwnerEntry)}\``, x.functions, x.directTests])), '');

  out.push('## Continuations', '', 'Entries reached through another candidate\'s same-group crossing. They are shown inside their parent, not ranked on their own.', '',
    table(['entry', 'group', 'route / key', 'own', 'reached from'], k.continuations.map(c => [`\`${short(c.entry)}\``, c.group, what(c), c.own,
      c.parents.map(p => `${prodRank.has(p) ? `#${prodRank.get(p)} ` : ''}\`${short(p)}\``).join(', ')])), '');

  out.push('## Merged prod + eval order (evidence only)', '', 'Where eval flows would land on one list. Groups stay separate; this order decides nothing.', '',
    table(['rank', 'entry', 'group', 'gain'], k.merged.map(x => [x.rank, `\`${short(x.entry)}\``, x.group, x.gain])), '');

  const explain = (grp, n) => {
    for (const x of k.ranked[grp].slice(0, n)) {
      const c = r.candidates[x.entry];
      out.push(`### ${grp} #${x.rank} \`${short(x.entry)}\`${what(x) ? ` — ${what(x)}` : ''}`, '',
        `${c.file}${c.line ? `:${c.line}` : ''} · ${x.own} own, ${c.folded} folded, ${x.modules} modules, depth ${c.maxDepth} · ${c.testDoubles.length} test doubles refused`, '',
        table(['segment root', 'reached from', 'via', 'own', 'folded'], c.segments.map(s => [`\`${short(s.root)}\``, s.from ? `\`${short(s.from)}\`` : '(entry)', s.kind || '', s.own, s.folded])), '');
      const points = configDispatchPoints(c.dispatch);
      if (points.length) out.push('Dispatch points:', '', table(['site', 'how', 'targets', 'config'], points.map(d => [`\`${d.site}\``, `${d.how} ${d.before}→${d.after}${d.narrowedBy ? ` by \`${short(d.narrowedBy)}\`` : ''}`,
        d.targets.map(short).join(', '), d.config ? `${d.config.classification}: ${d.config.alternatives.map(a => `\`${short(a.cls)}\` when ${a.guards.join(' & ') || '(fallthrough)'}`).join('; ')}` : ''])), '');
      const bseen = new Set();
      const branches = c.branches.filter(b => { const key = `${b.from}|${b.to}|${b.line}`; return !bseen.has(key) && bseen.add(key); });
      if (branches.length) out.push('Config-guarded branches:', '', table(['from', 'to', 'guard', 'line'], branches.map(b => [`\`${short(b.from)}\``, `\`${short(b.to)}\``, b.cfg.join(' & ') + (b.onFailure ? ` (on failure: ${b.onFailure})` : ''), b.line])), '');
    }
  };
  out.push('## Top rows explained', '');
  explain('prod', k.params.explainTop);
  explain('eval', k.params.explainTopEval);
  return out.join('\n');
}
