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
