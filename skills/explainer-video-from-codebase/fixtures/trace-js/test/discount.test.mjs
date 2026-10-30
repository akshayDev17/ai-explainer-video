import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discountFor } from '../src/cart.mjs';

test('no discount under 100', () => {
  assert.equal(discountFor(99), 0);
});
