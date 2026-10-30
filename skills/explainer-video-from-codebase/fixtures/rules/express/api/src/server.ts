import express, { Router } from 'express';
import { OrderService } from './orders';

const app = express();
const orders: Router = Router();
const svc = new OrderService();

orders.get('/:orderId', async (req, res) => {
  res.json(await svc.get(req.params.orderId));
});
app.use('/v2/orders', orders);

// not an Express app: a `.get(path, fn)` on anything else is no route
const registry = { get(path: string, fn: () => void) { fn(); } };
registry.get('/decoy', () => 1);

export default app;
