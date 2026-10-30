import { stockLevel, reserveCopy } from '../api/stock';

export function StockPage() {
  const check = async (isbn: string) => { await stockLevel(isbn); await reserveCopy(isbn); };
  return <button onClick={() => check('123')}>Reserve</button>;
}
