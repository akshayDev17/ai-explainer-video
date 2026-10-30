import { Cart } from './cart';
import { discount } from './pricing';
import { sendReceipt } from './mailer';

export async function checkout(email: string, skus: string[]) {
  const cart = new Cart();
  for (const sku of skus) cart.add({ sku });
  const total = cart.total() - discount(cart.total());
  await sendReceipt(email, total);
  return total;
}
