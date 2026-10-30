import { Cart } from '../cart';
import * as pricing from '../pricing';

describe('Cart', () => {
  let cart;

  beforeEach(() => {
    cart = new Cart();
  });

  it('adds an item at its price', () => {
    expect(cart.add({ sku: 'a', qty: 2 })).toBe(20);
  });

  it('totals every item', () => {
    jest.spyOn(cart, 'total');
    cart.add({ sku: 'a' });
    expect(cart.total()).toBe(10);
  });

  describe('discounts', () => {
    it.each([[50, 0], [200, 20]])('gives %i a discount of %i', (total, off) => {
      jest.spyOn(pricing, 'price').mockReturnValue(1);
      expect(pricing.discount(total)).toBe(off);
    });
  });
});
