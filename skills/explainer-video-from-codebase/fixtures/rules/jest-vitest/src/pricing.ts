export function price(item: { sku: string; qty?: number }) {
  return (item.qty ?? 1) * 10;
}

export function discount(total: number) {
  return total > 100 ? total * 0.1 : 0;
}
