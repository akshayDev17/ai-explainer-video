import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../src/cart.mjs';

describe('Cart', () => {
  let cart;

  beforeEach(() => {
    cart = new Cart().add(60).add(50);
  });

  it('applies the discount over 100', () => {
    assert.equal(cart.total(), 100);
  });
});
