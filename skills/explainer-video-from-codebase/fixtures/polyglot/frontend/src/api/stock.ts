const INVENTORY = '/api/v1/stock';

export async function stockLevel(isbn: string) {
  return fetch(`${INVENTORY}/${isbn}`);
}

export async function reserveCopy(isbn: string) {
  return fetch(`${INVENTORY}/${isbn}/reserve`, { method: 'POST' });
}
