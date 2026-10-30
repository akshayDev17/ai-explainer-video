import { test } from 'node:test';
import assert from 'node:assert/strict';
import { price } from '../src/pricing.ts';

test('a single item costs ten', () => {
  assert.equal(price({ sku: 'z' }), 10);
});
