const PRODUCTS = new Map([['1', { id: '1', name: 'Lamp' }]]);

export function findProduct(id: string) {
  return PRODUCTS.get(id);
}

export function renameProduct(id: string, name: string) {
  const p = findProduct(id);
  return { ...p, name };
}
