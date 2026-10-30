// The C and C++ adapter and its rule packs: each pack's fixture mined and diffed against its golden links, plus the
// resolution rules the adapter exists for (C linkage, includes, namespaces, out-of-line members, virtual dispatch,
// factory narrowing, function-pointer fields, build and config guards) and gtest / Catch2 / C test evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { FIXTURES, mine, ruleView, assertGolden, edgesFrom, short, gitRepo, cleanup } from './helpers.mjs';

const pack = name => {
  const r = mine(join(FIXTURES, 'rules', name));
  assert.equal(r.status, 0, r.stderr);
  return r.codemap;
};

test('c-handlers: C command tables and C++ handler maps make command entries; their dispatchers fan out as one site', () => {
  const m = pack('c-handlers');
  assertGolden('c-handlers', ruleView(m));
  const d = edgesFrom(m, 'src/commands.c:dispatch').filter(e => e.rule === 'c.handler-table');
  assert.equal(new Set(d.map(e => e.site)).size, 1, 'one dispatch site: a walk folds the commands as alternatives');
  assert.deepEqual(d.map(e => e.key), ['add', 'list', 'remove']);
  assert.deepEqual(m.rules.c.tables.map(t => `${t.name} ${t.rows} ${t.field}`), ['commands 3 run', 'routes 2 null', 'extra_ 1 null']);
  const audit = edgesFrom(m, 'src/store.c:store_put').find(e => e.to === 'src/store.c:audit_log');
  assert.deepEqual(audit.cfg, ['#ifdef WITH_AUDIT'], 'a build guard is a config fact on the call');
  assert.deepEqual(m.entries.find(e => e.kind === 'signal'), { kind: 'signal', id: 'src/main.c:on_sigint', key: 'SIGINT', file: 'src/main.c', line: 7, rule: 'c.signal', group: 'prod' });
  assert.equal(m.edges.some(e => e.rule === 'c.callback' && e.to === 'src/main.c:on_sigint'), false, 'a signal handler is an entry, not a callback');
});

test('gtest: GoogleTest, Catch2 and Unity tests; fixtures as hooks; a gmock mock stands in for the production implementation', () => {
  const m = pack('gtest');
  const view = { ...ruleView(m), tests: m.tests.map(t => `${t.id} [${t.framework}] asserts ${t.assertLines.join(',')} | mocked ${t.mocked.join(',')} | direct ${t.direct.map(d => `${d.to}/${d.via}`).join(',')}${t.subtests ? ` | subtests ${t.subtests.join(',')}` : ''}`),
    mocks: m.mocks.map(x => `${x.fn} ${x.how} ${x.raw} -> ${x.target}`) };
  assertGolden('gtest', view);
  assert.deepEqual(m.entries.filter(e => e.group === 'test'), [], 'a Unity runner\'s main is no entry');
});

test('c++ resolver: namespaces and using-directives, out-of-line members, virtual dispatch, make_unique factories, implicit this, -I includes', () => {
  const m = mine(join(FIXTURES, 'cpp-resolver')).codemap;
  assert.equal(m.selfCheck.ok, true);
  const run = edgesFrom(m, 'src/report.cpp:run').map(e => `${short(e.to)} ${e.kind}${e.narrowedBy ? ' narrowed' : ''}${e.recvClass ? ' concrete' : ''}`);
  for (const want of ['geo.Circle ctor', 'geo.Circle.Circle ctor', 'geo.Circle.area static concrete', 'geo.make_shape static', 'geo.Circle.area dispatch narrowed',
    'geo.Square.area dispatch narrowed', 'Report.add static concrete', 'geo.Square.Square ctor', 'area_of static'])
    assert.ok(run.includes(want), `${want} in ${run.join(', ')}`);
  assert.deepEqual(edgesFrom(m, 'src/report.cpp:area_of').map(e => `${short(e.to)} ${e.kind}`), ['geo.Shape.area static', 'geo.Circle.area virtual', 'geo.Square.area virtual'],
    'a declared Shape& is read through the hierarchy');
  assert.deepEqual(edgesFrom(m, 'src/report.cpp:Report.add').map(e => `${short(e.to)} ${e.self}`), ['Report.log log', 'Report.log log'], 'log() and this->log()');
  assert.equal(m.symbols.find(s => s.id === 'src/shapes.cpp:geo.Circle.area').cls, 'include/shapes.h:geo.Circle', 'an out-of-line member joins its class');
  assert.deepEqual(m.selfCheck.c.unresolvedIncludes, [], '"shapes.h" from src/ is include/shapes.h, as an -I directory would find it');
  assert.ok(m.symbols.find(s => s.id === 'include/shapes.h:geo.Shape.area').decos.includes('abstractmethod'), 'a pure virtual method is abstract');
});

const repoOf = files => { const repo = gitRepo();
  for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(repo, f)), { recursive: true }); writeFileSync(join(repo, f), text); }
  return repo; };
const calls = (m, from) => edgesFrom(m, from).map(e => `${e.to} ${e.kind}`);

test('c resolver: a static function is seen only from its own file and the files that include its header', () => {
  const repo = repoOf({
    'src/a.c': 'static int min(int a, int b) { return a < b ? a : b; }\nint use_a(void) { return min(1, 2); }\n',
    'src/b.c': 'int use_b(void) { return min(3, 4); }\n',
    'src/util.h': 'static inline int clamp(int x) { return x < 0 ? 0 : x; }\n',
    'src/c.c': '#include "util.h"\nint use_c(void) { return clamp(-1); }\n' });
  const m = mine(repo).codemap;
  assert.deepEqual(calls(m, 'src/a.c:use_a'), ['src/a.c:min static']);
  assert.deepEqual(calls(m, 'src/b.c:use_b'), [], 'another file\'s static min is not the one b.c calls');
  assert.deepEqual(calls(m, 'src/c.c:use_c'), ['src/util.h:clamp static'], 'a static inline in an included header is');
  cleanup(dirname(repo));
});

test('c++ resolver: an out-of-line definition qualified by a namespace, not a class, is a function in that namespace', () => {
  const repo = repoOf({
    'src/geo.h': 'namespace geo {\nint area(int w);\n}\n',
    'src/geo.cpp': '#include "geo.h"\nint geo::area(int w) { return w * w; }\n',
    'src/report.cpp': '#include "geo.h"\nint run() { return geo::area(2); }\nnamespace geo {\nint twice() { return area(3) * 2; }\n}\n' });
  const m = mine(repo).codemap;
  assert.equal(m.symbols.find(s => s.id === 'src/geo.cpp:geo.area').kind, 'function');
  assert.deepEqual(calls(m, 'src/report.cpp:run'), ['src/geo.cpp:geo.area static']);
  assert.deepEqual(calls(m, 'src/report.cpp:geo.twice'), ['src/geo.cpp:geo.area static']);
  cleanup(dirname(repo));
});
