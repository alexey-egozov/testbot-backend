import express, { Request, Response } from 'express';
import cors from 'cors';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { TradeEngine } from './tradeEngine';
import { OrderManager } from './orderManager';

const app = express();
app.use(cors());
app.use(express.json());

const tradeEngine = new TradeEngine();
tradeEngine.connect();

const orderManager = new OrderManager();

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set<WebSocket>();

wss.on('connection', ws => {
  clients.add(ws);
  if (tradeEngine.orderBook) {
    ws.send(JSON.stringify({ type: 'orderBook', payload: tradeEngine.orderBook }));
  }
  ws.on('close', () => {
    clients.delete(ws);
  });
});

tradeEngine.onOrderBookUpdate(snapshot => {
  const message = JSON.stringify({ type: 'orderBook', payload: snapshot });
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
});

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
server.listen(PORT, () => {
  console.log(`🚀 Bot backend running on http://localhost:${PORT}`);
});
