import express, { Request, Response } from 'express';
import cors from 'cors';
import { TradeEngine } from './tradeEngine';
import { OrderManager } from './orderManager';

const app = express();
app.use(cors());
app.use(express.json());

const tradeEngine = new TradeEngine();
tradeEngine.connect();

const orderManager = new OrderManager();

app.get('/api/price', (req: Request, res: Response) => {
  res.json({ price: tradeEngine.lastPrice });
});

app.post('/api/order', async (req: Request, res: Response) => {
  const { side, value } = req.body;
  try {
    const result = await orderManager.createTestOrder('BTCUSDT', side, value);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`🚀 Bot backend running on http://localhost:${PORT}`);
});
