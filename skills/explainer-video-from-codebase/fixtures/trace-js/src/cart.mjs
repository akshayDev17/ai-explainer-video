export function discountFor(total) {
  return total >= 100 ? 10 : 0;
}

export function applyDiscount(total) {
  return total - discountFor(total);
}

export class Cart {
  constructor() {
    this.items = [];
  }

  add(price) {
    this.items.push(price);
    return this;
  }

  total() {
    return applyDiscount(this.items.reduce((a, b) => a + b, 0));
  }
}
