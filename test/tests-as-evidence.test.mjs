// Tests are evidence: which functions are tests, which fixtures they bind, what they mock, and the direct links
// that remain once mocks are subtracted (fixture-scoped, autouse and session-wide).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FIXTURES, mine, short } from './helpers.mjs';

const r = mine(join(FIXTURES, 'rules', 'pytest'));
const m = r.codemap;
const T = name => m.tests.find(t => short(t.id) === name);
const direct = name => T(name).direct.map(d => `${short(d.to)} via ${d.via}`).sort();

test('mining the pytest fixture succeeds', () => assert.equal(r.status, 0, r.stderr));

test('tests: module test_* functions, Test* class methods and TestCase methods; helpers and fixtures are not tests', () => {
  assert.deepEqual(m.tests.map(t => short(t.id)).sort(), ['CartCase.test_starts_empty', 'TestPricing.test_price', 'test_add', 'test_mail_is_mocked_for_everyone',
    'test_patch_object', 'test_settings_are_mocked_for_the_session', 'test_through_a_helper', 'test_total_ignores_mocked_discount']);
  assert.deepEqual([T('test_add').asserts, T('test_add').assertLines], [1, [18]]);
  assert.equal(T('CartCase.test_starts_empty').asserts, 1, 'self.assertEqual counts as an assertion');
});

test('fixtures: class scope beats module beats conftest; autouse binds every test in scope', () => {
  assert.deepEqual(m.fixtures.map(f => [short(f.id), f.autouse]), [['cart', false], ['no_mail', true], ['TestPricing.rate', false]]);
  const bound = m.fixtureBindings.filter(b => !b.autouse).map(b => `${short(b.fn)} ${b.param} -> ${short(b.fixture)}`);
  assert.deepEqual(bound, ['test_add cart -> cart', 'TestPricing.test_price rate -> TestPricing.rate']);
  assert.equal(m.fixtureBindings.filter(b => b.autouse).length, m.tests.length);
});

test('a fixture-typed parameter resolves calls on it to the fixture\'s returned class', () => {
  assert.ok(m.edges.some(e => e.from === 'tests.test_cart:test_add' && e.to === 'shop.cart:Cart.add'));
});

test('mock targets resolve the way patch looks them up', () => {
  const mocks = m.mocks.map(x => `${x.how} ${x.raw} -> ${x.target}${x.scope ? ' (session)' : ''}`).sort();
  assert.deepEqual(mocks, [
    '@patch shop.cart.discount -> shop.pricing:discount',            // the name in the importing module, followed to its definition
    'patch shop.settings.get_settings -> shop.settings:get_settings (session)',
    'patch.object Cart.add -> shop.cart:Cart.add',
    'setattr shop.mail.send -> shop.mail:send',
  ]);
});

test('direct links: body, fixture and helper calls into non-test code', () => {
  assert.deepEqual(direct('test_add'), ['Cart.__init__ via fixture', 'Cart.add via body']);
  assert.deepEqual(direct('test_through_a_helper'), ['total via helper']);
  assert.deepEqual(direct('TestPricing.test_price'), ['price via body']);
});

test('a target the test patches is never a direct link', () => {
  assert.deepEqual(direct('test_patch_object'), ['Cart.__init__ via body', 'Cart.checkout via body']);
});

test('an autouse fixture\'s mock applies to every test in scope', () => {
  assert.deepEqual(direct('test_mail_is_mocked_for_everyone'), []);
  for (const t of m.tests) assert.ok(t.mocked.includes('shop.mail:send'), short(t.id));
});

test('a patch started in pytest_configure is a session-wide mock for every test under that conftest', () => {
  assert.deepEqual(direct('test_settings_are_mocked_for_the_session'), []);
  for (const t of m.tests) assert.ok(t.mocked.includes('shop.settings:get_settings'), short(t.id));
});

test('the summary counts production functions with a direct link', () => {
  const s = m.testSummary;
  assert.deepEqual([s.tests, s.fixtures, s.autouse, s.mocks, s.mocksResolved, s.sessionMocks], [8, 3, 1, 4, 4, 1]);
  assert.equal(s.prodFunctionsWithDirectLink, 5, 'Cart.__init__, Cart.add, Cart.checkout, total, price');
});

test('codemap.md lists the session-wide and autouse mocks every test runs under', () => {
  const section = r.md.split('### Mocks every test in scope runs under')[1].split('###')[0];
  assert.match(section, /get_settings.*session-wide/);
  assert.match(section, /send.*autouse fixture/);
});
