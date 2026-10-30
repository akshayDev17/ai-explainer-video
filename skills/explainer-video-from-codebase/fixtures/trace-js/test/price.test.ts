import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTotal, type Line } from '../src/price.ts';

test('a line costs its quantity times the unit price', () => {
  const line: Line = { sku: 'a', qty: 3 };
  assert.equal(lineTotal(line, 2), 6);
});
