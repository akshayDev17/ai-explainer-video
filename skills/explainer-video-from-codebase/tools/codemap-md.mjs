/* codemap.md: the human-readable code map. Every group, every entry, every rule link with its evidence, the test
   inventory with its session-wide and autouse mocks, config facts and profiles, and the self-check. Pytest
   fixture links are listed per fixture (each individual link is in codemap.json). */
const short = id => id.split(':').pop();
const loc = (file, line) => line ? `${file}:${line}` : file;
const table = (head, rows) => rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.map(c => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n') : '_none_';

export function renderCodemap(m) {
  const G = ['prod', 'eval', 'dev', 'test'];
  const sym = new Map(m.symbols.map(s => [s.id, s]));
  const fileOf = id => sym.get(id)?.file || id.split(':')[0];
  const out = [];
  const ts = m.testSummary, sc = m.selfCheck;
  out.push(`# Code map: ${m.root.split('/').pop()}`, '',
    `- root: \`${m.root}\`${m.commit ? ` at \`${m.commit.slice(0, 7)}\`` : ''} · tree ${m.treeHash.slice(0, 19)}…`,
    `- tools: ${Object.entries(m.tool.versions).map(([k, v]) => `${k}@${v}`).join(', ')}`,
    `- ${m.files.length} files: ${m.languages.python.files} Python (${m.languages.python.parseErrors} with syntax errors), ${m.unsupported.files} not mined yet ${JSON.stringify(m.unsupported.byExt)}`,
    `- ${m.symbols.length} symbols · ${m.edges.length} edges · ${m.entries.length} entries · ${ts.tests} tests`, '');

  out.push('## Self-check', '',
    `- **${sc.ok ? 'ok' : 'FAILED'}**: ${sc.defsExtracted} of ${sc.defNodes} parsed definitions extracted (${sc.defLinesRaw} \`def\`/\`class\` lines by regex) · ${sc.defScopes} distinct definitions, ${sc.symbols} symbols`,
    `- calls: ${sc.calls.resolved} resolved · unresolved by origin ${JSON.stringify(sc.unresolvedByOrigin)} · in-repo miss rate ${(sc.inRepoMissRate * 100).toFixed(1)}%`,
    `- Python package roots below the repo root: ${sc.packageRoots.length ? sc.packageRoots.map(r => `\`${r}/\``).join(', ') : 'none'}`,
    ...(sc.ambiguousImports.length ? [`- **${sc.ambiguousImports.reduce((n, x) => n + x.calls, 0)} calls are not linked: their import names a module several package roots claim and none holds the importing file**: ` +
      sc.ambiguousImports.map(x => `\`${x.name}\` ${x.calls} (${x.roots.map(r => `\`${r}/\``).join(', ')})`).join(', ')] : []),
    ...(sc.crossRootImports.length ? [`- ${sc.crossRootImports.reduce((n, x) => n + x.calls, 0)} calls resolve through a package root that does not hold the importing file (right only if that root is on its sys.path): ` +
      sc.crossRootImports.map(x => `\`${x.name}\` → \`${x.root}/\` ${x.calls}`).join(', ')] : []),
    ...(sc.externalLikeRepoDirs.calls ? [`- **${sc.externalLikeRepoDirs.calls} calls (${(sc.externalLikeRepoDirs.rate * 100).toFixed(1)}%) go to imports resolved as external although an in-repo directory with no \`__init__.py\` has their name**: ` +
      sc.externalLikeRepoDirs.names.map(x => `\`${x.name}\` ${x.calls} (${x.dirs.map(d => `\`${d}/\``).join(', ')})`).join(', ') + ' — if these are in-repo namespace packages, these calls are not linked'] : []),
    `- files with syntax errors: ${sc.filesWithErrors.length ? sc.filesWithErrors.map(f => `\`${f}\``).join(', ') : 'none'}`, '');

  out.push('## Groups', '', 'Rules, first match wins (a `--group` override wins over all of them):', '', ...m.groups.rules.map((r, i) => `${i + 1}. ${r}`), '',
    m.groups.overrides.length ? `Overrides: ${m.groups.overrides.map(o => `\`${o}\``).join(', ')}` : 'Overrides: none', '',
    table(['group', 'files', 'symbols', 'entries'], G.map(g => [g, m.groups.files[g], m.groups.symbols[g], m.groups.entries[g]])), '');
  const testEntries = m.entries.filter(e => e.group === 'test');
  if (testEntries.length) out.push('**Entries in the test group** (test-group entries are not flows; if this is a script, override its group):', '',
    ...testEntries.map(e => `- \`${e.id}\` (${loc(e.file, e.line)}) — e.g. \`--group '${e.file}=dev'\``), '');
  out.push('### Every file and the rule that placed it', '', table(['file', 'group', 'rule'], m.files.map(f => [`\`${f.path}\``, f.group, f.rule + (f.unsupported ? ' · not mined yet' : '') + (f.parseError ? ' · syntax error' : '')])), '');

  out.push('## Entries', '');
  for (const g of G) {
    const es = m.entries.filter(e => e.group === g);
    out.push(`### ${g} (${es.length})`, '', table(['kind', 'entry', 'route / key / via', 'where', 'rule'],
      es.map(e => [e.kind, `\`${short(e.id)}\``, e.path ? `${e.method} ${e.path}` : e.key || e.via || '', loc(e.file, e.line), e.rule || 'python'])), '');
  }

  out.push('## Rule links', '');
  const ruleEdges = m.edges.filter(e => e.rule && !/^pytest\.fixture/.test(e.rule));
  const byRule = new Map(); for (const e of ruleEdges) (byRule.get(e.rule) || byRule.set(e.rule, []).get(e.rule)).push(e);
  for (const [rule, es] of [...byRule].sort()) {
    out.push(`### ${rule} (${es.length})`, '', table(['from', 'to', 'kind', 'groups', 'evidence'],
      es.map(e => [`\`${short(e.from)}\``, `\`${short(e.to)}\``, e.kind, e.groups ? e.groups.join('→') : e.group || '', e.evidence || loc(fileOf(e.from), e.line)])), '');
  }
  const reg = m.rules.registry;
  if (reg.length) out.push('### registry tables', '', table(['key', 'message type', 'consumer', 'evidence', 'constructors', 'linked'],
    reg.map(r => [r.key, `\`${short(r.messageType)}\``, `\`${short(r.consumer)}\``, r.evidence, r.candidates, r.kept])), '');
  const unlinked = m.rules.pyHttp.filter(h => !h.handler);
  if (m.rules.pyHttp.length) out.push(`### HTTP client calls with no matching route (${unlinked.length} of ${m.rules.pyHttp.length})`, '',
    table(['from', 'call', 'where'], unlinked.map(h => [`\`${short(h.from)}\``, `${h.method} ${h.url}`, loc(h.file, h.line)])), '');
  const onFailure = m.edges.filter(e => e.onFailure);
  out.push(`### Calls on failure paths (${onFailure.length})`, '', 'Calls inside an `except` clause run only when the guarded code raised.', '',
    table(['from', 'to', 'on failure', 'where'], onFailure.map(e => [`\`${short(e.from)}\``, `\`${short(e.to)}\``, e.onFailure, loc(fileOf(e.from), e.line)])), '');
  out.push('### Frameworks imported without a rule pack', '', m.frameworksWithoutPack.length
    ? m.frameworksWithoutPack.map(f => `- \`${f.name}\` (first seen in \`${f.firstSeen}\`): its wiring is not linked; declare links where a flow needs them`).join('\n') : '_none_', '');

  out.push('## Tests', '',
    `${ts.tests} tests (${ts.asserting} with at least one assertion) · ${ts.fixtures} fixtures (${ts.autouse} autouse) · ${ts.fixtureLinks} fixture links · ` +
    `${ts.mocks} mock targets (${ts.mocksResolved} resolved in the repo, ${ts.sessionMocks} session-wide) · ` +
    `**${ts.prodFunctionsWithDirectLink} of ${ts.prodFunctions} production functions have a direct test link**`, '');
  const session = m.mocks.filter(x => x.scope === 'session');
  const autouse = new Set(m.fixtures.filter(f => f.autouse).map(f => f.id));
  const autouseMocks = m.mocks.filter(x => autouse.has(x.fn));
  out.push('### Mocks every test in scope runs under', '', 'No test is evidence for what these replace; narration must not call it "tested".', '',
    table(['mock', 'replaces', 'set up in', 'applies to'], [
      ...session.map(x => [x.how, `\`${x.target ? short(x.target) : x.raw}\``, loc(fileOf(x.fn), x.line) + ` (\`${short(x.fn)}\`)`, `every test under \`${x.conftest}\` (session-wide)`]),
      ...autouseMocks.map(x => [x.how, `\`${x.target ? short(x.target) : x.raw}\``, loc(fileOf(x.fn), x.line) + ` (\`${short(x.fn)}\`)`, 'every test in scope (autouse fixture)'])]), '');
  const binds = new Map(); for (const b of m.fixtureBindings) binds.set(b.fixture, (binds.get(b.fixture) || 0) + 1);
  out.push('### Fixtures', '', table(['fixture', 'where', 'autouse', 'bound by'], m.fixtures.map(f => [`\`${short(f.id)}\``, loc(f.file, f.line), f.autouse ? 'yes' : '', binds.get(f.id) || 0])), '');
  const perFile = new Map(); for (const t of m.tests) { const x = perFile.get(t.file) || perFile.set(t.file, { n: 0, direct: 0 }).get(t.file); x.n++; x.direct += t.direct.length; }
  out.push('### Tests per file', '', table(['file', 'tests', 'direct links'], [...perFile].map(([f, x]) => [`\`${f}\``, x.n, x.direct])), '');

  out.push('## Config', '', `${m.config.settingsFields.length} settings fields · ${m.config.settingsProps.length} settings properties · ${m.config.kv.length} config facts in ${m.config.files.length} git-tracked files · ${m.config.untracked} untracked config files not read`, '',
    ...m.config.notGitWorkTree.map(d => `**Config not read from \`${d}\`: not a git work tree, so no config file can be proven tracked.**`), ...(m.config.notGitWorkTree.length ? [''] : []),
    'A value is kept only for a key a dispatch guard reads; a secret-looking key or value is shown as `set (redacted)`.', '',
    table(['config file', 'group', 'reader', 'facts'], m.config.files.map(f => [`\`${f.path}\``, f.group, f.reader, f.facts])), '',
    '### Profiles', '', table(['profile', 'group', 'keys a guard reads'], m.config.profiles.map(p => [p.name, p.group, p.keys.join(', ')])), '',
    '### Config-selected dispatch', '');
  for (const s of m.config.sites) {
    out.push(`- \`${s.factory}\` (${s.group}) → **${s.classification}**`);
    for (const a of s.alternatives) out.push(`  - \`${short(a.cls)}\`${a.group && a.group !== s.group ? ` (${a.group} group)` : ''} when ${a.guards.join(' & ') || '(fallthrough)'} · ${Object.entries(a.sel).map(([k, v]) => `${k.split('/').pop()}=${v}`).join(' ')}`);
    for (const v of s.inRepoValues) out.push(`  - reads settings.${v.setting} (env ${v.env}, default ${v.default}) set in: ${v.files.join(', ') || 'no in-repo file'}`);
    if (s.params.length) out.push(`  - runtime inputs: ${s.params.join(', ')}`);
  }
  out.push('');
  return out.join('\n');
}
