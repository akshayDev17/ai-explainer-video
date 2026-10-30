import { loadProduct } from '../../../../lib/client';

export default async function ProductPage({ params }: { params: { id: string } }) {
  const product = await loadProduct(params.id);
  return <div>{product.name}</div>;
}
