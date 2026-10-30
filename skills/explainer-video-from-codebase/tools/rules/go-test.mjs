/* Rule pack: go test, in test-group (`_test.go`) files.
   - tests: `func TestXxx(t *testing.T)` and `func FuzzXxx(f *testing.F)` (Xxx not starting with a lower-case letter),
     the functions `go test` runs; assertion lines are `t.Error*` / `t.Fatal*` / `t.Fail*` calls, testify
     `assert.*` / `require.*` calls (or an `assert.New(t)` value's) and a testify mock's `AssertExpectations` /
     `AssertCalled`; a function literal's body (a subtest) belongs to its test;
   - subtests: `t.Run("name", func(t *testing.T) {…})` names a subtest; in a table test,
     `for _, tc := range cases { t.Run(tc.name, …) }`, the table's case count is recorded when `cases` is a composite
     literal (`table: { cases, line }`);
   - hooks: `TestMain(m *testing.M)` runs around every test of its directory's test binary (the pytest pack's autouse
     fixture);
   - mock targets: a test-group type the test side constructs (`&fakeStore{}`, `new(fakeStore)`, a testify
     `mock.Mock` embedder, a gomock `NewMockX(ctrl)`) that implements a production interface replaces, in that test,
     every production implementation of that interface's methods: the code it stands in for is not what the test
     exercises;
   - direct test links: every edge from a test's own side (its body, TestMain, test-side helpers) into non-test code,
     minus whatever that test mocks. */
import { posix } from 'node:path';
import { addGoEdge } from '../lang/go.mjs';

const TEST = /^(Test|Fuzz)([^a-z]|$)/;
const ASSERT_ATTR = /^(Error|Errorf|Fatal|Fatalf|Fail|FailNow)$/;
const TESTIFY = /^github\.com\/stretchr\/testify\/(assert|require)\.(?!New$)\w+$/;
const MOCK_ASSERT = /^Assert(Expectations|Called|NotCalled|NumberOfCalls)$/;   // a testify mock.Mock's own checks
const dirOf = f => posix.dirname(f) === '.' ? '' : posix.dirname(f);

export function findGoTests(go, R) {
  const isTestingT = (ir, c) => { const t = R.typeOf(ir, c), x = t && R.classOf(t.t, t.module)?.ext; return /^testing\.(T|B|F|TB)$/.test(x || ''); };
  const isAssertions = (ir, c) => { const t = R.typeOf(ir, c), x = t && R.classOf(t.t, t.module)?.ext;
    if (/^github\.com\/stretchr\/testify\/(assert|require)\.Assertions$/.test(x || '')) return true;
    const spec = ir?.k === 'id' ? R.resolveName(ir.name, c)?.local : null;   // a := assert.New(t)
    return spec?.t === 'expr' && spec.ir.k === 'call' && /\/(assert|require)\.New$/.test(R.calleeOf(spec.ir.fn, c)?.ext || ''); };
  const asserts = new Map(), runs = new Map();
  for (const c of go.rawCalls) {
    const s = go.symbols.get(c.from);
    if (s?.group !== 'test') continue;
    const isAssert = (c.attr && ASSERT_ATTR.test(c.attr) && isTestingT(c.obj, c)) || TESTIFY.test(R.calleeOf(c.attr ? { k: 'sel', obj: c.obj, field: c.attr } : c.fn, c)?.ext || '')
      || (c.attr && (isAssertions(c.obj, c) || MOCK_ASSERT.test(c.attr)));
    if (isAssert) (asserts.get(c.from) || asserts.set(c.from, new Set()).get(c.from)).add(c.line);
    if (c.attr === 'Run' && isTestingT(c.obj, c)) {
      const title = c.args[0]?.ir.k === 'str' ? c.args[0].ir.v : null;
      (runs.get(c.from) || runs.set(c.from, []).get(c.from)).push({ title, line: c.line, ...(title == null ? { name: c.args[0]?.text } : {}),
        ...(c.range ? { table: { over: c.range.over, line: c.range.line, cases: c.range.cases } } : {}) });
    }
  }
  const tests = [];
  for (const s of go.symbols.values()) {
    if (s.group !== 'test' || s.kind !== 'function' || !/_test\.go$/.test(s.file) || s.id.includes('<locals>') || !TEST.test(s.name) || s.name === 'TestMain') continue;
    if (!/^testing\.(T|F)$/.test(R.classOf(s.paramTypes?.[0], s.file)?.ext || '')) continue;
    const lines = [...(asserts.get(s.id) || [])].sort((a, b) => a - b);
    s.asserts = lines.length; s.assertLines = lines;
    const sub = runs.get(s.id) || [];
    const table = sub.find(r => r.table)?.table;
    tests.push({ id: s.id, file: s.file, line: s.start, end: s.end, asserts: lines.length, assertLines: lines,
      ...(sub.length ? { subtests: sub.map(r => r.title ?? `<${r.name}>`) } : {}), ...(table ? { table } : {}) });
  }
  return tests;
}

export function findGoHooks(go, R) {
  return [...go.symbols.values()].filter(s => s.group === 'test' && s.kind === 'function' && s.name === 'TestMain' && /_test\.go$/.test(s.file)
    && /^testing\.M$/.test(R.classOf(s.paramTypes?.[0], s.file)?.ext || ''))
    .map(s => { s.hook = 'TestMain'; return { id: s.id, name: 'TestMain', file: s.file, line: s.start, cls: null, autouse: true, scope: [], covers: dirOf(s.file) }; });
}

// TestMain runs around every test in its directory: both the package's and its external `_test` package's
export function bindGoHooks(tests, hooks) {
  const out = [];
  for (const t of tests) for (const h of hooks) if (dirOf(t.file) === h.covers) out.push({ fn: t.id, param: null, fixture: h.id, autouse: true, rule: 'go.TestMain' });
  return out;
}

export function goMockTargets(go, R, readText) {
  const mocks = [];
  const how = k => {
    if (k.embeds.some(t => /testify\/mock\.Mock$/.test(R.classOf(t, k.module)?.ext || ''))) return 'testify.mock';
    if (/Code generated by MockGen/.test(readText(k.file).slice(0, 400))) return 'gomock';
    return 'go.fake';
  };
  const doubleOf = cls => { const k = go.classes.get(cls); return k && !k.iface && go.symbols.get(cls)?.group === 'test' ? k : null; };
  const constructs = [];
  for (const l of go.literals) if (l.cls && doubleOf(l.cls)) constructs.push({ from: l.from, cls: l.cls, line: l.line });
  for (const c of go.rawCalls) {   // NewMockStore(ctrl), newFake(): a function whose declared result is a test double
    const s = c.target && go.symbols.get(c.target), r = s?.results?.[0] && R.classOf(s.results[0], s.file)?.cls;
    if (r && doubleOf(r)) constructs.push({ from: c.from, cls: r, line: c.line });
  }
  const seen = new Set();
  for (const x of constructs) {
    const k = doubleOf(x.cls);
    for (const iface of k.implementsIds || []) {
      if (go.symbols.get(iface)?.group === 'test') continue;
      for (const n of go.classes.get(iface).methods.keys())
        for (const impl of R.implementers.get(iface) || []) {
          if (go.symbols.get(impl)?.group === 'test') continue;
          const target = R.lookup(impl, n), key = `${x.from}\0${target}`;
          if (!target || seen.has(key)) continue;
          seen.add(key);
          mocks.push({ fn: x.from, raw: `${k.name} (for ${go.symbols.get(iface).name}.${n})`, target, line: x.line, how: how(k) });
        }
    }
  }
  return mocks;
}

export function linkGoHooks(go, bindings) {
  const s = id => go.symbols.get(id);
  for (const b of bindings) addGoEdge(go, b.fn, b.fixture, 'framework', s(b.fn)?.start, { rule: 'go.test-main',
    evidence: `${s(b.fn)?.file}: TestMain at ${s(b.fixture)?.file}:${s(b.fixture)?.start} runs around this test` });
}
