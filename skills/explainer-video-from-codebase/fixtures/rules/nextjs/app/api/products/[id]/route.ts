import { findProduct, renameProduct } from '../../../../lib/products';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  return Response.json(findProduct(params.id));
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return Response.json(renameProduct(params.id, await req.text()));
}
