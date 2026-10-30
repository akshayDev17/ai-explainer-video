/* Rule pack: C and C++ tests — GoogleTest, Catch2, and plain C test functions (Unity, cmocka, a hand-rolled runner) —
   in test-group files.
   - tests: gtest `TEST(Suite, Name)`, `TEST_F(Fixture, Name)`, `TEST_P`, `TYPED_TEST` (named `Suite.Name`); Catch2
     `TEST_CASE("title", "[tags]")`, `SCENARIO`, `TEST_CASE_METHOD(Fixture, "title")`, its `SECTION("…")`s recorded
     as subtests; a C function named `test_*`; assertion lines are `EXPECT_*` / `ASSERT_*` (gmock's `EXPECT_CALL`
     included), `REQUIRE*` / `CHECK*`, Unity `TEST_ASSERT*`, cmocka `assert_*`, check's `ck_assert*` and `assert`;
   - hooks: a TEST_F / TEST_CASE_METHOD fixture class's constructor, `SetUp` and `TearDown` run around each of its
     tests (the pytest pack's autouse fixtures), as do a Unity file's `setUp` / `tearDown`; the test body is a member of
     its fixture, so `cart_.add()` resolves through the fixture's fields;
   - mock targets: a test-group class that derives from a production class — a gmock `MOCK_METHOD` mock or a
     hand-written fake — and that the test side constructs replaces, in that test, every production implementation of
     the methods it overrides in that hierarchy;
   - direct test links (lib/test-links.mjs): every edge from a test's side into non-test code, minus its mocks. */
import { addCEdge } from '../lang/c.mjs';

const ASSERT = /^((EXPECT|ASSERT)_[A-Z0-9_]+|REQUIRE(_\w+)?|CHECK(_\w+)?|TEST_ASSERT\w*|assert|assert_\w+|ck_assert\w*|ASSERT|CU_ASSERT\w*)$/;

export function findCTests(cm) {
  const asserts = new Map(), sections = new Map();
  for (const c of cm.rawCalls) {
    const s = cm.symbols.get(c.from);
    if (s?.group !== 'test' || c.attr || c.isNew) continue;
    const name = c.fn?.k === 'id' ? c.fn.name.split('::').pop() : c.expr;
    if (ASSERT.test(name)) (asserts.get(c.from) || asserts.set(c.from, new Set()).get(c.from)).add(c.line);
    if (name === 'SECTION' || name === 'GIVEN' || name === 'WHEN' || name === 'THEN') (sections.get(c.from) || sections.set(c.from, []).get(c.from)).push(c.args[0]?.str ?? c.args[0]?.text);
  }
  const tests = [];
  for (const s of cm.symbols.values()) {
    if (s.group !== 'test' || s.kind !== 'function' || s.id.includes('<locals>')) continue;
    if (!s.test && !/^test_\w+$/.test(s.name)) continue;
    const lines = [...(asserts.get(s.id) || [])].sort((a, b) => a - b);
    s.asserts = lines.length; s.assertLines = lines;
    const sub = sections.get(s.id) || [];
    tests.push({ id: s.id, file: s.file, line: s.start, end: s.end, asserts: lines.length, assertLines: lines, framework: s.macro ? (/TEST_CASE|SCENARIO/.test(s.macro) ? 'catch2' : 'gtest') : 'c',
      ...(s.fixture ? { fixture: s.fixture } : {}), ...(sub.length ? { subtests: sub } : {}) });
  }
  return tests;
}

export function findCHooks(cm, R, tests) {
  const hooks = new Map();
  const add = (id, name, autouse = true) => { const s = cm.symbols.get(id); if (s && !hooks.has(id)) hooks.set(id, { id, name, file: s.file, line: s.start, cls: s.cls || null, autouse }); };
  for (const t of tests) {
    const s = cm.symbols.get(t.id);
    if (t.fixture) { const k = R.classNamed(t.fixture, { module: s.module, ns: s.ns }); if (!k) continue;
      for (const m of [R.ctorOf(k), R.lookup(k, 'SetUp'), R.lookup(k, 'TearDown')]) if (m) add(m, cm.symbols.get(m).name); }
  }
  for (const s of cm.symbols.values()) if (s.group === 'test' && s.kind === 'function' && /^(setUp|tearDown)$/.test(s.name)) add(s.id, s.name);
  for (const h of hooks.values()) cm.symbols.get(h.id).hook = h.name.split('.').pop();   // a direct link through it is `via: fixture`
  return [...hooks.values()];
}

export function bindCHooks(cm, R, tests, hooks) {
  const out = [];
  for (const t of tests) {
    const s = cm.symbols.get(t.id);
    const k = t.fixture ? R.classNamed(t.fixture, { module: s.module, ns: s.ns }) : null;
    const chain = k ? new Set(R.mro(k)) : new Set();
    for (const h of hooks) {
      if (h.cls && chain.has(h.cls)) out.push({ fn: t.id, param: null, fixture: h.id, autouse: true, rule: 'gtest.fixture' });
      else if (!h.cls && h.file === t.file && !t.fixture && t.framework === 'c') out.push({ fn: t.id, param: null, fixture: h.id, autouse: true, rule: 'unity.setUp' });
    }
  }
  return out;
}

export function linkCHooks(cm, bindings) {
  const s = id => cm.symbols.get(id);
  for (const b of bindings) addCEdge(cm, b.fn, b.fixture, 'framework', s(b.fn)?.start, { rule: b.rule,
    evidence: `${s(b.fn)?.file}: ${s(b.fixture)?.name} at ${s(b.fixture)?.file}:${s(b.fixture)?.start} runs around this test` });
}

export function cMockTargets(cm, R, hooks) {
  const mocks = [], seen = new Set();
  const isTest = id => cm.symbols.get(id)?.group === 'test';
  // what the test side constructs: `MockPrices m;`, `new FakeDb`, make_unique<…>, and a fixture's fields (made with it)
  const built = cm.rawCalls.filter(c => c.isNew && c.target).map(c => ({ from: c.from, cls: c.target, line: c.line }));
  for (const h of hooks) if (h.cls) for (const k of R.mro(h.cls)) for (const [f, t] of cm.classes.get(k)?.fields || []) {
    const d = t.k === 'name' ? R.classNamed(t.name, { module: cm.classes.get(k).module, ns: cm.classes.get(k).ns }) : null;
    if (d) built.push({ from: h.id, cls: d, line: cm.classes.get(k).line, field: f });
  }
  for (const c of built) {
    if (!isTest(c.cls) || !cm.classes.has(c.cls)) continue;
    const k = cm.classes.get(c.cls);
    const roots = R.mro(k.id).slice(1).filter(b => !isTest(b));
    if (!roots.length) continue;
    for (const m of k.methods.keys()) for (const r of roots) {
      const impls = [R.lookup(r, m), ...R.overrides(r, m)].filter(x => x && !isTest(x) && !(cm.symbols.get(x).decos || []).includes('abstractmethod'));
      for (const target of impls) {
        const key = `${c.from}\0${target}`;
        if (seen.has(key)) continue; seen.add(key);
        mocks.push({ fn: c.from, raw: `${k.name} (for ${cm.symbols.get(r).name}.${m})`, target, line: c.line, how: k.mocked ? 'gmock' : 'cpp.fake' });
      }
    }
  }
  return mocks;
}
