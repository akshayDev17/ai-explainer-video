export async function loadProduct(id: string) {
  const res = await fetch(`/api/products/${id}`);
  return res.json();
}

export async function legacyLookup(slug: string) {
  return fetch(`/api/legacy/${slug}`, { method: 'POST' });
}
