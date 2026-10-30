import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../src/cart.mjs';
import { nightlyTotal } from '../src/jobs.mjs';

test('the nightly total runs the body', () => {
  assert.equal(nightlyTotal(new Cart().add(5)), 5);
});
