// The mining tool's contract: exit codes, never writing inside the repo, deterministic output, the self-check,
// and the vendored tree-sitter it runs on.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, statSync, symlinkSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { ROOT, SKILL, FIXTURES, mine, scratch, cleanup, gitRepo, git } from './helpers.mjs';
import { loadGrammars } from '../skills/explainer-video-from-codebase/tools/lib/tree-sitter.mjs';

const MINE = join(SKILL, 'tools', 'mine.mjs');
const RESOLVER = join(FIXTURES, 'resolver');
const TMP = scratch();
after(() => cleanup(TMP));
let n = 0;
const out = () => join(TMP, `o${n++}`);
const run = (...args) => spawnSync(process.execPath, [MINE, ...args], { encoding: 'utf8' });
const listing = dir => (function walk(d) { return readdirSync(d).flatMap(n => statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [relative(dir, join(d, n))]); })(dir).sort();

test('exit 1: no repo, no --out, an unknown flag, a missing directory', () => {
  assert.equal(run().status, 1);
  assert.equal(run(RESOLVER).status, 1);
  assert.equal(run(RESOLVER, '--out', out(), '--fast').status, 1);
  assert.equal(run(join(RESOLVER, 'nope'), '--out', out()).status, 1);
});

test('exit 1: a repo with no supported source files', () => {
  const repo = out();
  mkdirSync(repo);
  writeFileSync(join(repo, 'main.rs'), 'fn main() {}\n');
  const r = run(repo, '--out', out());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no supported source files/);
});

test('exit 1: refuses to write inside the repo', () => {
  const r = run(RESOLVER, '--out', join(RESOLVER, 'out'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to write inside the repo/);
});

test('exit 1: refuses an --out that reaches the repo through a symlink', () => {
  const link = out();
  symlinkSync(RESOLVER, link);
  const r = run(RESOLVER, '--out', join(link, 'out'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to write inside the repo/);
  assert.equal(existsSync(join(RESOLVER, 'out')), false);
  const viaRepoLink = run(link, '--out', join(RESOLVER, 'out'));
  assert.equal(viaRepoLink.status, 1);
});

test('exit 1: a bad --group or an unmined --lang', () => {
  assert.equal(run(RESOLVER, '--out', out(), '--group', 'x/**=staging').status, 1);
  assert.match(run(RESOLVER, '--out', out(), '--lang', 'rust').stderr, /mined languages are python, typescript, go, c, cpp/);
});

test('--lang takes python, typescript (which covers JavaScript), go, c and cpp, each mining only its own files; no other spelling', () => {
  const polyglot = join(FIXTURES, 'polyglot');
  const files = m => [...new Set(m.symbols.map(s => s.file.slice(s.file.lastIndexOf('.'))))].sort();
  for (const [lang, repo, exts] of [['python', polyglot, ['.py']], ['typescript', polyglot, ['.ts', '.tsx']], ['go', polyglot, ['.go']], ['c', polyglot, ['.c']],
    ['cpp', join(FIXTURES, 'cpp-resolver'), ['.cpp', '.h']]]) {
    const r = mine(repo, '--lang', lang);
    assert.equal(r.status, 0, `${lang}: ${r.stderr}`);
    assert.deepEqual(files(r.codemap), exts, lang);
  }
  for (const alias of ['py', 'ts', 'javascript', 'js', 'golang', 'c++', 'cxx']) {
    const r = run(polyglot, '--out', out(), '--lang', alias);
    assert.equal(r.status, 1, alias);
    assert.match(r.stderr, new RegExp(`--lang ${alias.replace(/\+/g, '\\+')}: mined languages are python, typescript, go, c, cpp`));
  }
});

test('the repo is never written to, and two runs produce identical code maps', () => {
  const before = listing(RESOLVER);
  const a = mine(RESOLVER), b = mine(RESOLVER);
  assert.equal(a.status, 0, a.stderr);
  assert.deepEqual(listing(RESOLVER), before);
  assert.deepEqual(a.codemap, b.codemap);
  assert.equal(a.md, b.md);
});

test('--exclude skips a path; --config-root adds config facts from outside the repo', () => {
  const ex = mine(join(FIXTURES, 'rules', 'pytest'), '--exclude', 'tests');
  assert.equal(ex.codemap.files.some(f => f.path.startsWith('tests/')), false);
  const cfg = gitRepo();
  mkdirSync(join(cfg, 'deploy'), { recursive: true });
  writeFileSync(join(cfg, 'deploy', 'values.yaml'), 'env:\n  - name: REMOTE_EMBEDDER\n    value: "true"\n');
  git(cfg, 'add', '-A');
  const r = mine(join(FIXTURES, 'rules', 'haystack'), '--config-root', cfg);
  cleanup(dirname(cfg));
  const site = r.codemap.config.sites[0];
  assert.equal(site.decidedByProfile[`${cfg}/deploy/values.yaml`], 'pipe.components:RemoteEmbedder', 'a Helm env list sets REMOTE_EMBEDDER');
});

test('the self-check passes on every fixture and reports unresolved calls by origin', () => {
  for (const dir of ['resolver', 'polyglot', 'rules/fastapi', 'rules/pytest', 'nested-classes', 'package-roots', 'package-roots-wrapper', 'package-roots-flask', 'package-roots-stdlib', 'package-roots-ambiguous', 'package-roots-namespace', 'package-roots-declared', 'package-imports']) {
    const { status, codemap } = mine(join(FIXTURES, dir));
    assert.equal(status, 0, dir);
    assert.equal(codemap.selfCheck.ok, true, dir);
    assert.equal(codemap.selfCheck.defsExtracted, codemap.selfCheck.defNodes, dir);
    assert.equal(codemap.symbols.filter(s => s.kind !== 'main' && s.file.endsWith('.py')).length, codemap.selfCheck.defScopes, `${dir}: one symbol per distinct definition`);
    assert.deepEqual(Object.keys(codemap.selfCheck.unresolvedByOrigin).sort(), ['builtin', 'external', 'inRepo', 'local']);
  }
});

test('symbols carry their group, span and a content hash; cross-group edges are labelled', () => {
  const { codemap } = mine(join(FIXTURES, 'rules', 'pytest'));
  const cart = codemap.symbols.find(s => s.id === 'shop.cart:Cart.add');
  assert.deepEqual([cart.group, cart.kind, cart.file, cart.start, cart.end], ['prod', 'method', 'shop/cart.py', 9, 10]);
  assert.match(cart.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(codemap.edges.find(e => e.from === 'tests.test_cart:test_add' && e.to === 'shop.cart:Cart.add').groups, ['test', 'prod']);
});

test('the vendored drift check passes offline', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-tree-sitter-vendor.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('all seven vendored grammars load and parse without node_modules', async () => {
  const langs = ['python', 'typescript', 'tsx', 'javascript', 'go', 'c', 'cpp'];
  const { Parser, grammars } = await loadGrammars(langs);
  const src = { python: 'def f():\n    return 1\n', typescript: 'const x: number = 1;', tsx: 'const a = <div/>;', javascript: 'function f() {}',
    go: 'package main\nfunc main() {}\n', c: 'int main(void) { return 0; }', cpp: 'class A { public: int f(); };' };
  for (const l of langs) {
    const p = new Parser(); p.setLanguage(grammars[l]);
    const t = p.parse(src[l]);
    assert.equal(t.rootNode.hasError, false, l);
    t.delete(); p.delete();
  }
});
