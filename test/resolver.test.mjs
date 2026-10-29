// The resolver fixes milestone 1 names: B14 getattr selectors, B17 callables passed as arguments,
// B18 `x or Default()`, B19 self-method factories, plus except paths labelled "on failure" and super().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FIXTURES, mine, edgesFrom, short } from './helpers.mjs';

const r = mine(join(FIXTURES, 'resolver'));
const m = r.codemap;
const site = fn => m.config.sites.find(s => s.factory === fn);

test('mining the resolver fixture succeeds', () => assert.equal(r.status, 0, r.stderr));

test('B14: getattr(settings, "x", default) is a selector; its default decides when no field declares x', () => {
  const s = site('svc.backends:create_backend');
  assert.equal(s.classification, 'config-narrowed');
  assert.deepEqual(s.settingsRead, ['backend_mode']);
  assert.equal(s.decidedByProfile['code defaults'], 'svc.backends:LocalBackend');
});

test('B14: a declared settings field wins over getattr\'s default', () => {
  assert.equal(site('svc.backends:create_regional_backend').decidedByProfile['code defaults'], 'svc.backends:LocalBackend');
});

test('B17: a coroutine handed to a callee that awaits it links callee -> coroutine, tagged with who passed it', () => {
  const e = m.edges.find(x => x.rule === 'py.callback' && x.to === 'svc.runner:task.<locals>._body');
  assert.equal(e.from, 'svc.runner:run_with_timeout');
  assert.equal(e.passedBy, 'svc.runner:task');
});

test('B17: a callable handed to a callee that calls it links callee -> callable', () => {
  const e = m.edges.find(x => x.rule === 'py.callback' && x.to === 'svc.runner:load.<locals>._fetch');
  assert.deepEqual([e.from, e.passedBy], ['svc.runner:with_retry', 'svc.runner:load']);
});

test('B17: a callable the callee never calls gets no link', () => {
  assert.equal(m.edges.filter(x => x.to === 'svc.runner:store_only.<locals>._callback').length, 0);
  assert.equal(m.edges.filter(x => x.rule === 'py.callback').length, 2);
});

test('B18: self.x = arg or Default() types the attribute by the default', () => {
  const e = edgesFrom(m, 'svc.strategies:Runner.go').find(x => x.to === 'svc.strategies:Executor.run');
  assert.equal(e?.kind, 'static');
});

test('B19: a receiver set by a self-method factory dispatches to that method\'s returns', () => {
  const es = edgesFrom(m, 'svc.strategies:Manager.ensure').map(x => `${short(x.to)} ${x.kind}`).sort();
  assert.deepEqual(es, ['FastStrategy.ensure dispatch', 'SlowStrategy.ensure dispatch']);
  assert.equal(site('svc.strategies:Manager._create_strategy').classification, 'config-dependent (runtime input)');
});

test('a call inside an except clause is labelled with the failure it handles', () => {
  const e = m.edges.find(x => x.from === 'svc.runner:with_retry' && x.to === 'svc.runner:log_retry');
  assert.equal(e.onFailure, 'except ValueError');
  assert.equal(m.edges.find(x => x.from === 'svc.runner:load' && x.to === 'svc.runner:with_retry').onFailure, undefined);
  assert.match(r.md, /### Calls on failure paths \(1\)/);
});

test('super().m() resolves to the next class in the MRO', () => {
  const e = edgesFrom(m, 'svc.strategies:Child.save').find(x => x.to === 'svc.strategies:Base.save');
  assert.equal(e.super, true);
});

test('nested and function-local classes get scoped ids: two models\' `class Config` never collide', () => {
  const n = mine(join(FIXTURES, 'nested-classes'));
  assert.equal(n.status, 0, n.stderr);
  const sym = id => n.codemap.symbols.find(x => x.id === id);
  assert.deepEqual(['pkg.m:Config', 'pkg.m:User.Config', 'pkg.m:Item.Config', 'pkg.m:build.<locals>.Impl'].map(id => [id, sym(id)?.start]),
    [['pkg.m:Config', 1], ['pkg.m:User.Config', 6], ['pkg.m:Item.Config', 14], ['pkg.m:build.<locals>.Impl', 22]]);
  assert.deepEqual([sym('pkg.m:Item.Config.describe').kind, sym('pkg.m:Item.Config.describe').cls], ['method', 'pkg.m:Item.Config']);
  assert.ok(edgesFrom(n.codemap, 'pkg.m:default_config').some(e => e.to === 'pkg.m:Config' && e.kind === 'ctor'), 'Config() is the top-level class');
  assert.ok(edgesFrom(n.codemap, 'pkg.m:build').some(e => e.to === 'pkg.m:build.<locals>.Impl.run'), 'a function-local class resolves inside its function');
  assert.equal(n.codemap.selfCheck.ok, true);
});

test('a class or function redefined in both branches of an if / try is one symbol, and the self-check passes', () => {
  const n = mine(join(FIXTURES, 'nested-classes'));
  assert.equal(n.status, 0, n.stderr);
  const ids = n.codemap.symbols.filter(s => s.file === 'pkg/compat.py').map(s => s.id).sort();
  assert.deepEqual(ids, ['pkg.compat:Compat', 'pkg.compat:Compat.run', 'pkg.compat:speedup']);
  assert.equal(n.codemap.symbols.length, n.codemap.selfCheck.defScopes);
});

test('`from pkg import items` reaches the submodule when pkg/__init__.py does `from . import items`; a missing name is an in-repo miss', () => {
  const p = mine(join(FIXTURES, 'package-imports'));
  assert.equal(p.status, 0, p.stderr);
  assert.ok(edgesFrom(p.codemap, 'pkg.use:run').some(e => e.to === 'pkg.items:list_items'));
  assert.deepEqual([p.codemap.selfCheck.unresolvedByOrigin.inRepo, p.codemap.selfCheck.unresolvedByOrigin.local], [1, 0]);
});
