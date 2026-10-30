import { price } from './pricing';

export class Cart {
  items: { sku: string; qty?: number }[] = [];

  add(item: { sku: string; qty?: number }) {
    this.items.push(item);
    return price(item);
  }

  total() {
    return this.items.reduce((n, i) => n + price(i), 0);
  }
}
