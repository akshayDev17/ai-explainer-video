/* Rule pack: jest / vitest (and node:test and mocha, which share the API) in test-group files.
   - tests: `it(title, fn)` / `test(title, fn)` (and `.only`, `.skip`, `.each(...)`), named by their `describe` titles
     and their own (`A > B > adds`); assertion lines are their `expect(…)` and `assert…(…)` calls;
   - hooks: `beforeEach` / `beforeAll` / `afterEach` / `afterAll` bind to every test under their `describe` (the
     pytest pack's autouse fixtures); a hook in a setup file (setupTests.*, jest.setup.*, vitest.setup.*, or a file a
     jest / vitest config lists in setupFiles) binds to every test below that setup file's directory (a listed one:
     below its config's directory);
   - mock targets: `jest.mock('mod')` / `vi.mock('mod')` (and `doMock`) replace every export of the module the
     string resolves to (from the test file, the way the module system would), or only the factory's keys when the
     factory spreads the real module; they are hoisted, so they apply to the whole test file, and in a setup file to
     every test in its scope (session-wide). `jest.spyOn(obj, 'm')` / `vi.spyOn` replaces `m` only when a
     `.mockImplementation` / `.mockReturnValue` / `.mockResolvedValue` / `.mockRejectedValue` follows (a bare spy
     calls through);
   - direct test links: every edge from a test's own side (its body, its hooks, test-side helpers) into non-test
     code, minus whatever that test mocks. */
import { posix } from 'node:path';
import { addTsEdge } from '../lang/typescript.mjs';

export const SETUP_FILE = /(^|\/)(setupTests|setup-tests|jest\.setup|vitest\.setup|test-setup)\.[cm]?[jt]sx?$/;
const ASSERT = /^(expect|assert)$|^assert\.\w+$|^expect\.\w+$|^t\.assert\w*$/;

// files a jest or vitest config names in setupFiles / setupFilesAfterEnv (`<rootDir>/x`, './x' or 'x', from the config's
// dir) -> the directory whose tests they set up (the config's)
export function configuredSetupFiles(configs) {
  const out = new Map();
  for (const { rel, text } of configs) {
    const dir = posix.dirname(rel) === '.' ? '' : posix.dirname(rel);
    for (const m of text.matchAll(/setupFiles(?:AfterEnv)?["']?\s*:\s*\[([^\]]*)\]/g))
      for (const s of m[1].matchAll(/["'`]([^"'`]+)["'`]/g)) out.set(posix.normalize(posix.join(dir, s[1].replace(/^<rootDir>\/?/, ''))), dir);
  }
  return out;
}
// the directory a setup file's hooks and mocks cover: its config's, else its own
const setupScope = (file, setupFiles) => setupFiles.has(file) ? setupFiles.get(file) : posix.dirname(file) === '.' ? '' : posix.dirname(file);
const under = (dir, file) => !dir || file.startsWith(dir + '/');

export function findTests(ts) {
  const assertsOf = new Map();
  for (const c of ts.rawCalls) if (ASSERT.test(c.expr) && ts.symbols.get(c.from)?.test) (assertsOf.get(c.from) || assertsOf.set(c.from, new Set()).get(c.from)).add(c.line);
  return [...ts.symbols.values()].filter(s => s.test && s.group === 'test').map(s => {
    const lines = [...(assertsOf.get(s.id) || [])].sort((a, b) => a - b);
    s.asserts = lines.length; s.assertLines = lines;
    return { id: s.id, file: s.file, line: s.start, end: s.end, asserts: lines.length, assertLines: lines, title: s.title, describe: s.describe };
  });
}

export function findHooks(ts, setupFiles) {
  return ts.testCalls.filter(t => t.kind === 'hook').map(h => {
    const setup = SETUP_FILE.test(h.file) || setupFiles.has(h.file);
    return { id: h.id, name: h.hook, file: h.file, line: h.line, cls: null, autouse: true, scope: h.describe, ...(setup ? { setup: true, covers: setupScope(h.file, setupFiles) } : {}) };
  });
}

export function bindHooks(tests, hooks) {
  const binds = (t, h) => h.setup ? under(h.covers, t.file) : h.file === t.file && h.scope.every((x, i) => t.describe[i] === x);
  const out = [];
  for (const t of tests) for (const h of hooks) if (binds(t, h)) out.push({ fn: t.id, param: null, fixture: h.id, autouse: true, rule: `${h.setup ? 'setup-file' : 'test'}.${h.name}` });
  return out;
}

export function linkHooks(ts, bindings) {
  const s = id => ts.symbols.get(id);
  for (const b of bindings) addTsEdge(ts, b.fn, b.fixture, 'framework', s(b.fn)?.start, { rule: 'js.test-hook',
    evidence: `${s(b.fn)?.file}: ${s(b.fixture)?.name} at ${s(b.fixture)?.file}:${s(b.fixture)?.start} runs around this test` });
}

export function mockTargets(ts, R, setupFiles) {
  const exportsOf = (rel, seen = new Set()) => {
    if (seen.has(rel)) return []; seen.add(rel);
    const M = ts.modules.get(rel); if (!M) return [];
    const names = [...M.exports.keys(), ...(M.defaultExport ? ['default'] : [])];
    const ids = names.map(n => R.exportOf(rel, n)?.id).filter(Boolean);
    for (const s of M.starExports) { const t = R.resolveModule(s, rel); if (t) ids.push(...exportsOf(t, seen)); }
    // a mocked class has every method replaced
    return [...new Set(ids.flatMap(id => ts.classes.has(id) ? [id, ...ts.classes.get(id).methods.values()] : [id]))];
  };
  const mocks = [];
  for (const c of ts.mockCalls) {
    const setup = SETUP_FILE.test(c.file) || setupFiles.has(c.file);
    const where = setup ? { scope: 'session', conftest: c.file, covers: setupScope(c.file, setupFiles) } : {};
    if (/(^|\.)(mock|doMock)$/.test(c.how) && c.spec != null) {
      const mod = R.resolveModule(c.spec, c.file);
      const fn = `${c.file}:<module>`;   // hoisted: the whole test file
      if (!mod) { mocks.push({ fn, raw: c.spec, target: null, line: c.line, how: c.how, ...where }); continue; }
      const targets = c.keys ? c.keys.map(k => R.exportOf(mod, k)?.id).filter(Boolean) : exportsOf(mod);
      if (!targets.length) mocks.push({ fn, raw: c.spec, target: null, module: mod, line: c.line, how: c.how, ...where });
      for (const t of targets) mocks.push({ fn, raw: c.spec, target: t, module: mod, line: c.line, how: c.how, ...(c.keys ? { partial: true } : {}), ...where });
    } else if (/spyOn$/.test(c.how) && c.obj && c.prop && c.replaced) {
      let target = null;
      const obj = c.obj.replace(/\.prototype$/, '');
      const r = /^[\w$.]+$/.test(obj) ? R.resolveExpr(obj, c) : null;
      if (r?.module) target = R.exportOf(r.module, c.prop)?.id || null;
      else if (r?.id && ts.classes.has(r.id)) target = R.lookup(r.id, c.prop);
      else if (r?.obj) { const m = r.obj.get(c.prop); target = typeof m === 'string' ? m : null; }
      else { const spec = c.types?.get(obj) || r?.var; const rc = spec ? R.receiverOf(spec, spec.module ? spec : c) : null; if (rc) target = R.lookup(rc.cls[0], c.prop); }
      mocks.push({ fn: c.fn, raw: `${c.obj}.${c.prop}`, target, line: c.line, how: c.how, ...where });
    }
  }
  return mocks;
}

const FOLLOW = new Set(['static', 'ctor', 'framework', 'dispatch', 'queue', 'http', 'virtual']);
export function directLinks(tests, mocks, edges, symbolOf) {
  const out = new Map(); for (const e of edges) (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e);
  const G = id => symbolOf(id)?.group || (id.startsWith('ext:') ? 'ext' : 'prod');
  const mocksIn = new Map(); for (const m of mocks) if (m.target && !m.scope) (mocksIn.get(m.fn) || mocksIn.set(m.fn, new Set()).get(m.fn)).add(m.target);
  const session = mocks.filter(m => m.target && m.scope === 'session');
  for (const t of tests) {
    const side = new Set([t.id]), q = [t.id];
    while (q.length) { const x = q.pop(); for (const e of out.get(x) || []) if (FOLLOW.has(e.kind) && G(e.to) === 'test' && !side.has(e.to)) { side.add(e.to); q.push(e.to); } }
    const mocked = new Set(session.filter(m => under(m.covers, t.file)).map(m => m.target));
    for (const s of [...side, `${t.file}:<module>`]) for (const m of mocksIn.get(s) || []) mocked.add(m);
    const hooks = new Set([...side].filter(s => symbolOf(s)?.hook));
    const links = new Map();
    for (const s of side) for (const e of out.get(s) || []) {
      if (!FOLLOW.has(e.kind) || G(e.to) === 'test' || e.to.startsWith('ext:') || mocked.has(e.to) || symbolOf(e.to)?.kind === 'class' || links.has(e.to)) continue;
      links.set(e.to, { to: e.to, via: s === t.id ? 'body' : hooks.has(s) ? 'fixture' : 'helper', viaId: s, kind: e.kind, ...(e.rule ? { rule: e.rule } : {}), line: e.line, ...(e.recvClass ? { recvClass: e.recvClass } : {}) });
    }
    t.mocked = [...mocked].sort();
    t.direct = [...links.values()];
  }
}
