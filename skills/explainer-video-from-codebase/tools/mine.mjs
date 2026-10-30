#!/usr/bin/env node
/* =============================================================================
   mine.mjs — parse every file of a repo, put each in a group, and write the
   code map: symbols, typed call edges, entry points, framework rule links,
   tests with their direct links into the code, and config facts.

   Usage:
     node tools/mine.mjs <repo> --out out/<name> [--group 'glob=group' ...]
                         [--exclude p,...] [--lang python,typescript] [--config-root <dir>]

   Languages: Python, and TypeScript / JavaScript (.ts .tsx .mts .cts .js .jsx .mjs
   .cjs; `--lang typescript` covers both). Each is mined by its own adapter into one
   code map; a frontend's HTTP calls link to the routes a backend in any language
   serves. Go, C and C++ files are grouped and listed, not mined yet.

   Writes out/<name>/codemap.json and out/<name>/codemap.md. Never writes inside
   the repo, never uses the network, never runs repo code. Config is read only from
   git-tracked files; a value is kept only for a key a dispatch guard reads, and a
   secret-looking one is shown only as set.

   Exit: 0 ok · 1 bad path, no supported files, or bad flags · 2 self-check failed
   (a definition the parser saw was not extracted, or two collapsed into one symbol)
   ========================================================================== */
import { readdirSync, readFileSync, lstatSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, relative, extname, resolve, sep, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadGrammars } from './lib/tree-sitter.mjs';
import { PATH_RULES, DEFAULT_RULE, classifyFile, parseOverrides } from './lib/groups.mjs';
import { newPythonModel, extractPythonFile, resolverFor, resolveCalls, pythonEntries } from './lang/python.mjs';
import { TS_LANGS, newTsModel, extractTsFile, tsModuleResolver, tsResolverFor, resolveTsCalls, tsEntries } from './lang/typescript.mjs';
import { STDLIB } from './lang/python-stdlib.mjs';
import { DEPENDENCY_FILES, declaredDependencies } from './lang/python-deps.mjs';
import { classifyDispatch } from './lang/python-config.mjs';
import * as fastapi from './rules/fastapi.mjs';
import * as celeryTaskiq from './rules/celery-taskiq.mjs';
import * as clickTyper from './rules/click-typer.mjs';
import * as registry from './rules/registry.mjs';
import * as haystack from './rules/haystack.mjs';
import * as pyHttp from './rules/py-http-client.mjs';
import * as spawn from './rules/process-spawn.mjs';
import * as pytest from './rules/pytest.mjs';
import * as express from './rules/express.mjs';
import * as nextjs from './rules/nextjs.mjs';
import * as reactRouter from './rules/react-router.mjs';
import * as jsHttp from './rules/js-http-client.mjs';
import * as jestVitest from './rules/jest-vitest.mjs';
import * as dotenv from './config/dotenv.mjs';
import * as yamlLite from './config/yaml-lite.mjs';
import * as tomlLite from './config/toml-lite.mjs';
import * as json from './config/json.mjs';
import { shownValue } from './config/redact.mjs';
import { renderCodemap } from './codemap-md.mjs';

const fail = (code, msg) => { console.error(`[mine] ${msg}`); process.exit(code); };

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
const VALUED = new Set(['--out', '--group', '--exclude', '--lang', '--config-root']);
const flags = new Map(); const bare = [];
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) { if (argv[i + 1] == null) fail(1, `${argv[i]} needs a value`); (flags.get(argv[i]) || flags.set(argv[i], []).get(argv[i])).push(argv[++i]); }
  else if (argv[i].startsWith('--')) fail(1, `unknown flag ${argv[i]}`);
  else bare.push(argv[i]);
}
if (bare.length !== 1 || !flags.has('--out')) fail(1, 'usage: mine.mjs <repo> --out out/<name> [--group glob=group] [--exclude p,...] [--lang python,typescript] [--config-root <dir>]');
const ROOT = resolve(bare[0]);
const OUT = resolve(flags.get('--out').at(-1));
if (!existsSync(ROOT) || !lstatSync(ROOT).isDirectory()) fail(1, `not a directory: ${bare[0]}`);
// compare real paths so a symlink on either side cannot route --out into the repo
const realOut = p => existsSync(p) ? realpathSync(p) : join(realOut(dirname(p)), basename(p));
const REAL_ROOT = realpathSync(ROOT), REAL_OUT = realOut(OUT);
if (REAL_OUT === REAL_ROOT || REAL_OUT.startsWith(REAL_ROOT + sep)) fail(1, `refusing to write inside the repo: ${OUT}`);
let overrides;
try { overrides = parseOverrides((flags.get('--group') || []).flatMap(s => s.split(',')).filter(Boolean)); } catch (e) { fail(1, e.message); }
const EXCLUDE = (flags.get('--exclude') || []).flatMap(s => s.split(',')).filter(Boolean).map(p => p.replace(/\/+$/, ''));
const LANGS = new Set((flags.get('--lang') || ['python,typescript']).flatMap(s => s.split(',')).filter(Boolean).map(l => {
  if (l !== 'python' && l !== 'typescript') fail(1, `--lang ${l}: mined languages are python and typescript (javascript is mined with typescript); go, c and cpp are not mined yet`);
  return l; }));
const CONFIG_ROOTS = (flags.get('--config-root') || []).map(d => resolve(d));
for (const d of CONFIG_ROOTS) if (!existsSync(d)) fail(1, `--config-root ${d} does not exist`);

/* ---------------- walk ---------------- */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build']);
const CODE_EXT = { '.py': 'python', '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
  '.cjs': 'javascript', '.go': 'go', '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp' };
const READERS = [['dotenv', dotenv], ['yaml-lite', yamlLite], ['toml-lite', tomlLite], ['json', json]];
const excluded = rel => EXCLUDE.some(p => rel === p || rel.startsWith(p + '/'));
function walk(root, dir, out, skip) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name), rel = relative(root, p).split(sep).join('/'), st = lstatSync(p);
    if (st.isSymbolicLink() || skip(rel)) continue;
    if (st.isDirectory()) { if (!name.startsWith('.')) walk(root, p, out, skip); continue; }
    if (DEPENDENCY_FILES.test(rel)) out.deps.push(rel);
    if (name === 'package.json' || name === 'tsconfig.json' || name === 'jsconfig.json') out.jsMeta.push(rel);
    const reader = READERS.find(([, r]) => r.matches(rel));
    if (reader && st.size < 512 * 1024) out.config.push({ rel, reader: reader[0] });
    if (name.startsWith('.')) continue;
    if (CODE_EXT[extname(name)]) out.code.push(rel);
  }
  return out;
}
const newWalk = () => ({ code: [], config: [], deps: [], jsMeta: [] });
// git-tracked files under a directory (relative to it); null when it is not in a git work tree
const trackedFiles = root => {
  try { return new Set(execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, 'ls-files', '-z'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 })
    .toString().split('\0').filter(Boolean)); } catch { return null; }
};
const { code, config, deps, jsMeta } = walk(ROOT, ROOT, newWalk(), excluded);
const mined = rel => { const l = CODE_EXT[extname(rel)]; return l === 'python' ? LANGS.has('python') : TS_LANGS.has(l) && LANGS.has('typescript'); };
const pyFiles = code.filter(f => CODE_EXT[extname(f)] === 'python' && mined(f));
const tsFiles = code.filter(f => TS_LANGS.has(CODE_EXT[extname(f)]) && mined(f));
if (!pyFiles.length && !tsFiles.length) fail(1, `no supported source files under ${ROOT} (supported: ${[...LANGS].join(', ')})`);

/* ---------------- parse + extract ---------------- */
const sha = s => createHash('sha256').update(s).digest('hex');
const GRAMMARS = ['python', ...(tsFiles.length ? ['typescript', 'tsx', 'javascript'] : [])];
const { Parser, grammars, versions } = await loadGrammars(GRAMMARS);
const parsers = Object.fromEntries(GRAMMARS.map(l => { const p = new Parser(); p.setLanguage(grammars[l]); return [l, p]; }));
const parser = parsers.python;
const py = newPythonModel(), ts = newTsModel();
const files = [];
const t0 = Date.now();
const readCache = new Map();
const readText = rel => readCache.get(rel) ?? (readCache.set(rel, readFileSync(join(ROOT, rel), 'utf8')), readCache.get(rel));
for (const rel of code) {
  const lang = CODE_EXT[extname(rel)];
  const { group, rule } = classifyFile(rel, overrides, lang === 'python' || TS_LANGS.has(lang) ? () => readText(rel) : null, lang);
  const text = readText(rel);
  const f = { path: rel, group, rule, lang, sha256: sha(text) };
  if (mined(rel) && lang === 'python') {
    const tree = parser.parse(text);
    if (tree.rootNode.hasError) f.parseError = true;
    extractPythonFile(py, rel, tree.rootNode, group, text);
    tree.delete();
  } else if (mined(rel)) {
    const tree = parsers[lang].parse(text);
    if (tree.rootNode.hasError) f.parseError = true;
    extractTsFile(ts, rel, tree.rootNode, group, text, lang);
    tree.delete();
  } else f.unsupported = true;
  files.push(f);
}
const parseMs = Date.now() - t0;
const groupOfFile = new Map(files.map(f => [f.path, f.group]));

/* ---------------- resolve: core rules, then framework packs ---------------- */
fastapi.registerAliases(py);
const declared = declaredDependencies(deps.map(rel => ({ rel, text: readText(rel) })));
const R = resolverFor(py, declared.names);
const tests = pytest.findTests(py, R);
const fixtures = pytest.findFixtures(py);
const fixtureBindings = pytest.bindFixtures(py, tests, fixtures);
resolveCalls(py, R);

const prefixOf = fastapi.routePrefixes(py, R);
const entries = [];
for (const d of py.decorated) {
  const e = fastapi.routeEntry(py, d, prefixOf) || celeryTaskiq.consumerEntry(py, d) || clickTyper.commandEntry(py, d, entries);
  if (e) entries.push(e);
}
entries.push(...pythonEntries(py, R));

// TypeScript / JavaScript: resolve, then its routes and UI routes, before any HTTP client is linked to a route
const symbolOf = id => py.symbols.get(id) || ts.symbols.get(id);
const groupOfId = id => symbolOf(id)?.group || py.modules.get(id.split(':')[0])?.group || ts.modules.get(id.split(':')[0])?.group;
ts.groupOf = groupOfId; py.groupOf = groupOfId;
const TR = tsResolverFor(ts, tsModuleResolver({ files: tsFiles, readText }));
const exp = express.expressRoutes(ts, TR);
resolveTsCalls(ts, TR, { skipHanded: exp.claimed });
const readJson = rel => { try { return JSON.parse(readText(rel)); } catch { return null; } };
const packageJsons = jsMeta.filter(f => basename(f) === 'package.json').map(rel => ({ rel, dir: dirname(rel) === '.' ? '' : dirname(rel), json: readJson(rel) }));
const nextRootDirs = tsFiles.length ? nextjs.nextRoots(packageJsons, code) : [];
const routeAliases = [];   // a handler a second route also reaches: matched by HTTP clients, not a second entry
for (const e of [...exp.routes, ...nextjs.nextEntries(ts, TR, nextRootDirs), ...reactRouter.uiRoutes(ts, TR), ...tsEntries(ts)]) {
  const first = entries.find(x => x.id === e.id);
  if (!first) { entries.push(e); continue; }
  if (e.kind === 'http') routeAliases.push(e);
  if (e.path && first.path !== e.path) (first.alsoAt || (first.alsoAt = [])).push(e.method ? `${e.method} ${e.path}` : e.path);
}
for (const e of entries) e.group = groupOfFile.get(e.file) || 'prod';
for (const e of routeAliases) e.group = groupOfFile.get(e.file) || 'prod';

const producers = celeryTaskiq.linkProducers(py, R, entries);
const registryKeys = registry.linkRegistry(py, producers.dispatchers, producers.consumerByKey);
const depends = fastapi.linkDepends(py, R);
const pipelines = haystack.linkPipelines(py, R);
const httpRoutes = [...entries.filter(e => e.kind === 'http'), ...routeAliases];
const httpCalls = pyHttp.linkHttpCalls(py, httpRoutes);
const jsHttpCalls = jsHttp.linkHttpCalls(ts, TR, httpRoutes);
const spawns = spawn.linkSpawns(py, R, entries);
pytest.linkFixtures(py, fixtureBindings);
const mocks = pytest.mockTargets(py, R);
pytest.directLinks(py, tests, fixtures, mocks);
// jest / vitest: tests, hooks (autouse fixtures), module mocks and spies, then the direct links over every edge
const jsConfigs = code.filter(f => /(^|\/)(jest|vitest|vite)\.config\.[cm]?[jt]s$/.test(f)).map(rel => ({ rel, text: readText(rel) }));
for (const p of packageJsons) if (p.json?.jest) jsConfigs.push({ rel: p.rel, text: JSON.stringify(p.json.jest) });
const setupFiles = jestVitest.configuredSetupFiles(jsConfigs);
const jsTests = jestVitest.findTests(ts);
const hooks = jestVitest.findHooks(ts, setupFiles);
const hookBindings = jestVitest.bindHooks(jsTests, hooks);
jestVitest.linkHooks(ts, hookBindings);
const jsMocks = jestVitest.mockTargets(ts, TR, setupFiles);
jestVitest.directLinks(jsTests, jsMocks, [...py.edges, ...ts.edges], symbolOf);
const allTests = [...tests, ...jsTests], allFixtures = [...fixtures, ...hooks], allBindings = [...fixtureBindings, ...hookBindings], allMocks = [...mocks, ...jsMocks];

/* ---------------- config facts ---------------- */
const configFiles = [], configKV = [];
let untrackedConfig = 0;
const notGitWorkTree = [];
const readConfig = (root, rel, reader, group, label) => {
  let txt; try { txt = readFileSync(join(root, rel), 'utf8'); } catch { return; }
  const facts = READERS.find(([n]) => n === reader)[1].readFacts(txt);
  configFiles.push({ path: label, group, reader, facts: facts.length, sha256: sha(txt) });
  for (const kv of facts) configKV.push({ ...kv, file: label, group });
};
const readTracked = (root, cs, groupOf, labelOf) => { const tracked = trackedFiles(root);
  if (!tracked) { notGitWorkTree.push(root); return; }
  for (const c of cs) if (tracked.has(c.rel)) readConfig(root, c.rel, c.reader, groupOf(c.rel), labelOf(c.rel)); else untrackedConfig++; };
readTracked(ROOT, config, rel => classifyFile(rel, overrides, null).group, rel => rel);
for (const d of CONFIG_ROOTS) readTracked(d, walk(d, d, newWalk(), () => false).config, () => 'prod', rel => `${d}/${rel}`);
const factories = Object.fromEntries([...new Set(py.returns.map(r => r.fn))].map(f => [f, R.factoryReturns(f)])
  .filter(([, v]) => v.length > 1 || v.some(x => x.guards.length)));
const guardParser = new Parser(); guardParser.setLanguage(grammars.python);
const dispatch = classifyDispatch({ py, factories, entries, configKV, parser: guardParser });
// env keys a TypeScript guard tests keep their (redacted) values, like the keys a Python dispatch guard reads
const tsGuardKeys = new Set(ts.edges.flatMap(e => e.cfg || []).flatMap(g => [...g.matchAll(/(?:process\.env|import\.meta\.env)\.([A-Za-z_]\w*)/g)].map(m => m[1].toUpperCase())));

/* ---------------- self-check ---------------- */
const KNOWN_PACKS = new Set(['fastapi', 'starlette', 'celery', 'taskiq', 'haystack', 'pytest', 'pytest_asyncio', 'unittest', 'httpx', 'requests', 'aiohttp', 'click', 'typer', 'subprocess', 'asyncio']);
const FRAMEWORKS = ['flask', 'django', 'rq', 'dramatiq', 'huey', 'arq', 'tornado', 'sanic', 'falcon', 'bottle', 'pyramid', 'quart', 'litestar', 'aiohttp_jinja2',
  'grpc', 'kafka', 'confluent_kafka', 'aiokafka', 'pika', 'aio_pika', 'nameko', 'airflow', 'prefect', 'dagster', 'luigi', 'langchain', 'langgraph',
  'llama_index', 'ray', 'socketio', 'channels', 'graphene', 'strawberry', 'ariadne', 'apscheduler', 'schedule', 'fire', 'docopt'];
const JS_FRAMEWORKS = ['koa', 'fastify', '@nestjs/core', '@nestjs/common', '@hapi/hapi', 'hono', 'restify', 'vue-router', '@angular/router', '@tanstack/react-router',
  '@remix-run/react', '@sveltejs/kit', 'nuxt', '@trpc/server', '@trpc/client', 'graphql', '@apollo/server', '@apollo/client', 'socket.io', 'bullmq', 'bull', 'kafkajs',
  'amqplib', 'commander', 'yargs', 'mocha', 'superagent', 'got', 'node-fetch', 'undici', 'electron'];
const withoutPack = [...FRAMEWORKS.filter(f => py.externalImports.has(f) && !KNOWN_PACKS.has(f)).map(f => ({ name: f, firstSeen: py.externalImports.get(f) })),
  ...JS_FRAMEWORKS.filter(f => ts.externalImports.has(f)).map(f => ({ name: f, firstSeen: ts.externalImports.get(f), lang: 'typescript' }))];
const defLinesRaw = pyFiles.reduce((n, f) => n + (readText(f).match(/^[ \t]*(async[ \t]+def|def|class)[ \t]+[A-Za-z_]/gm) || []).length, 0);
const inRepoCalls = py.callStats.resolved + py.unresolved.inRepo;
// calls into an import the resolver called external although an in-repo directory with no __init__.py (a namespace
// package) has its name: Python may find them in the repo, the code map cannot
const initDirs = new Set(pyFiles.filter(f => /(^|\/)__init__\.py$/.test(f)).map(f => f.split('/').slice(0, -1).join('/')));
const pyDirs = new Map();
for (const f of pyFiles) f.split('/').slice(0, -1).forEach((d, i, a) => { const dir = a.slice(0, i + 1).join('/');
  if (!initDirs.has(dir) && !STDLIB.has(d)) (pyDirs.get(d) || pyDirs.set(d, new Set()).get(d)).add(dir); });
const likeRepoDirs = [...py.externalCalls].filter(([top]) => pyDirs.has(top)).sort()
  .map(([name, calls]) => ({ name, calls, dirs: [...pyDirs.get(name)].sort() }));
const likeRepoCalls = likeRepoDirs.reduce((n, x) => n + x.calls, 0);
const definedSymbols = py.symbols.size - new Set(py.mains).size;
const selfCheck = {
  defNodes: py.defNodes, defsExtracted: py.defsVisited, defScopes: py.defScopes, defLinesRaw, symbols: py.symbols.size,
  filesWithErrors: files.filter(f => f.parseError).map(f => f.path), dependencyFilesNotParsed: declared.unparsed,
  calls: py.callStats, unresolvedByOrigin: py.unresolved,
  inRepoMissRate: inRepoCalls ? Number((py.unresolved.inRepo / inRepoCalls).toFixed(4)) : 0,
  packageRoots: R.packageRoots,
  crossRootImports: [...py.importNotes.cross.values()].sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : 1)),
  ambiguousImports: [...py.importNotes.ambiguous.values()].sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : 1)),
  externalLikeRepoDirs: { calls: likeRepoCalls, rate: likeRepoCalls ? Number((likeRepoCalls / (inRepoCalls + likeRepoCalls)).toFixed(4)) : 0, names: likeRepoDirs },
  ok: py.defsVisited === py.defNodes && definedSymbols >= py.defScopes && ts.defsVisited === ts.defNodes,
};
const tsInRepo = ts.callStats.resolved + ts.unresolved.inRepo;
if (tsFiles.length) selfCheck.typescript = { defNodes: ts.defNodes, defsExtracted: ts.defsVisited, defScopes: ts.defScopes,
  symbols: ts.symbols.size, calls: ts.callStats, unresolvedByOrigin: ts.unresolved,
  inRepoMissRate: tsInRepo ? Number((ts.unresolved.inRepo / tsInRepo).toFixed(4)) : 0,
  unresolvedImports: [...ts.unresolvedImports.values()].sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : a.spec < b.spec ? -1 : 1) };

/* ---------------- write ---------------- */
const symbols = [...py.symbols.values(), ...ts.symbols.values()].map(({ text, ...s }) => ({ ...s, sha256: sha(text) }));
const edges = [...py.edges, ...ts.edges];
const byKey = (xs, k) => xs.reduce((a, x) => (a[x[k]] = (a[x[k]] || 0) + 1, a), {});
const count = (xs, keys) => Object.fromEntries(keys.map(k => [k, xs.filter(x => x.group === k).length]));
let commit = null;
try { commit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
const treeHash = 'sha256:' + sha([...files.map(f => `${f.path}\0${f.sha256}`), ...configFiles.map(f => `${f.path}\0${f.sha256}`)].sort().join('\n'));
const unsupported = files.filter(f => f.unsupported);
const prodFns = symbols.filter(s => s.group === 'prod' && (s.kind === 'function' || s.kind === 'method'));
const pinned = new Set(allTests.flatMap(t => t.direct.map(l => l.to)));
const G = ['prod', 'test', 'eval', 'dev'];
const codemap = {
  schema: 1, tool: { name: 'mine.mjs', versions }, root: ROOT, commit, treeHash,
  languages: { python: { files: pyFiles.length, parseErrors: files.filter(f => f.parseError && f.lang === 'python').length },
    ...(tsFiles.length ? Object.fromEntries(['typescript', 'javascript'].map(l => { const fs = files.filter(f => !f.unsupported && (l === 'javascript' ? f.lang === 'javascript' : f.lang === 'typescript' || f.lang === 'tsx'));
      return [l, { files: fs.length, parseErrors: fs.filter(f => f.parseError).length }]; })) : {}) },
  unsupported: { files: unsupported.length, byExt: byKey(unsupported.map(f => ({ ext: extname(f.path) })), 'ext') },
  groups: { rules: [...PATH_RULES.map(r => r.rule), DEFAULT_RULE], overrides: overrides.map(o => `${o.glob}=${o.group}`),
    files: count(files, G), symbols: count(symbols, G), entries: count(entries, G) },
  files, symbols,
  classes: [...py.classes.values(), ...ts.classes.values()].map(k => ({ id: k.id, bases: [...k.bases, ...(k.implementsIds || [])], baseExprs: k.baseExprs, methods: Object.fromEntries(k.methods), decos: k.decos })),
  edges, entries,
  tests: allTests, fixtures: allFixtures, fixtureBindings: allBindings, mocks: allMocks,
  testSummary: { tests: allTests.length, asserting: allTests.filter(t => t.asserts).length, fixtures: allFixtures.length, autouse: allFixtures.filter(f => f.autouse).length,
    fixtureLinks: allBindings.length, mocks: allMocks.length, mocksResolved: allMocks.filter(m => m.target).length,
    sessionMocks: allMocks.filter(m => m.scope === 'session').length, prodFunctions: prodFns.length, prodFunctionsWithDirectLink: prodFns.filter(s => pinned.has(s.id)).length },
  rules: { routes: entries.filter(e => e.kind === 'http').length, depends, taskiq: producers.links, registry: registryKeys, haystack: pipelines,
    pyHttp: httpCalls, spawn: spawns, callbacks: py.edges.filter(e => e.rule === 'py.callback').length,
    ...(tsFiles.length ? { jsHttp: jsHttpCalls, uiRoutes: entries.filter(e => e.kind === 'ui-route').length, express: { mounts: exp.mounts }, nextRoots: nextRootDirs,
      routeAliases: routeAliases.map(e => ({ method: e.method, path: e.path, id: e.id, file: e.file, line: e.line, rule: e.rule })),
      setupFiles: [...new Set([...setupFiles.keys(), ...hooks.filter(h => h.setup).map(h => h.file), ...jsMocks.filter(x => x.scope === 'session').map(x => x.conftest)])].sort() } : {}) },
  dispatchSites: py.dispatchSites, factories,
  config: { files: configFiles, untracked: untrackedConfig, notGitWorkTree,
    settingsFields: py.settingsFields.map(f => ({ ...f, default: shownValue(f.alias || f.name, f.default) })), settingsProps: py.settingsProps,
    kv: configKV.map(({ value, ...kv }) => dispatch.guardKeys.has(kv.key.toUpperCase()) || tsGuardKeys.has(kv.key.toUpperCase()) ? { ...kv, value: shownValue(kv.key, value) } : kv),
    profiles: dispatch.profiles, sites: dispatch.sites,
    ...(tsFiles.length ? { envReads: ts.envReads.map(r => r.default != null ? { ...r, default: shownValue(r.key, r.default) } : r) } : {}) },
  frameworksWithoutPack: withoutPack,
  selfCheck,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'codemap.json'), JSON.stringify(codemap, null, 1) + '\n');
writeFileSync(join(OUT, 'codemap.md'), renderCodemap(codemap));

const ek = byKey(edges, 'kind'), nk = byKey(entries, 'kind'), tsum = codemap.testSummary;
const queueBy = byKey(py.edges.filter(e => e.rule === 'registry').map(e => ({ g: e.group })), 'g');
console.log(`[mine] ${files.length} files (${pyFiles.length} python, ${tsFiles.length} typescript/javascript, ${unsupported.length} unsupported) parsed in ${parseMs} ms · ${selfCheck.filesWithErrors.length} with syntax errors · ${configFiles.length} config files`);
console.log(`[mine] files by group ${JSON.stringify(codemap.groups.files)} · entries by group ${JSON.stringify(codemap.groups.entries)}`);
console.log(`[mine] ${symbols.length} symbols · ${edges.length} edges ${JSON.stringify(ek)}`);
console.log(`[mine] entries ${JSON.stringify(nk)} · Depends ${depends.length} · registry producers ${JSON.stringify(queueBy)} · haystack ${pipelines.length} · http ${httpCalls.filter(h => h.handler).length}/${httpCalls.length} · spawn ${spawns.length} · callbacks ${codemap.rules.callbacks}`);
if (tsFiles.length) console.log(`[mine] typescript/javascript: express routes ${exp.routes.length} · next.js roots ${nextRootDirs.length} · ui routes ${codemap.rules.uiRoutes} · js http ${jsHttpCalls.filter(h => h.handler).length}/${jsHttpCalls.length} · tests ${jsTests.length} · hooks ${hooks.length} · mocks ${jsMocks.length} (resolved ${jsMocks.filter(m => m.target).length})`);
console.log(`[mine] tests ${tsum.tests} (asserting ${tsum.asserting}) · fixtures ${tsum.fixtures} (autouse ${tsum.autouse}) · fixture links ${tsum.fixtureLinks} · mocks ${tsum.mocks} (resolved ${tsum.mocksResolved}, session-wide ${tsum.sessionMocks}) · prod functions with a direct test link ${tsum.prodFunctionsWithDirectLink}/${tsum.prodFunctions}`);
for (const d of notGitWorkTree) console.log(`[mine] config not read from ${d}: not a git work tree, so no config file can be proven tracked`);
console.log(`[mine] config: ${dispatch.sites.length} factory dispatch sites · profiles ${dispatch.profiles.map(p => `${p.name} (${p.group})`).join(', ')}`);
console.log(`[mine] self-check ${selfCheck.ok ? 'ok' : 'FAILED'}: ${selfCheck.defsExtracted}/${selfCheck.defNodes} definitions extracted · ${definedSymbols} distinct symbols for ${selfCheck.defScopes} distinct definitions · package roots ${selfCheck.packageRoots.join(', ') || 'none'} · calls across package roots ${selfCheck.crossRootImports.reduce((n, x) => n + x.calls, 0)} · calls lost to an ambiguous import ${selfCheck.ambiguousImports.reduce((n, x) => n + x.calls, 0)} · external calls named like repo dirs ${likeRepoCalls} · in-repo miss rate ${(selfCheck.inRepoMissRate * 100).toFixed(1)}%${selfCheck.typescript ? ` · typescript/javascript ${selfCheck.typescript.defsExtracted}/${selfCheck.typescript.defNodes} definitions, in-repo miss rate ${(selfCheck.typescript.inRepoMissRate * 100).toFixed(1)}%, ${selfCheck.typescript.unresolvedImports.length} relative imports to no file` : ''} · wrote ${relative(process.cwd(), OUT) || '.'}/codemap.{json,md}`);
if (!selfCheck.ok) process.exit(2);
