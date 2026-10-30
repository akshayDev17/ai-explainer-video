import { describe, it, expect, vi } from 'vitest';
import { checkout } from './checkout';

vi.mock('./pricing', async (importOriginal) => ({
  ...(await importOriginal()),
  discount: vi.fn(() => 0),
}));

describe('checkout', () => {
  it('charges the cart total', async () => {
    const total = await checkout('a@b.c', ['x', 'y']);
    expect(total).toBe(20);
  });
});
