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

app.get('/api/account/wallet-balance', async (req: Request, res: Response) => {
  const accountType = typeof req.query.accountType === 'string' ? req.query.accountType : 'UNIFIED';
  try {
    const result = await orderManager.getWalletBalance(
      accountType as 'UNIFIED' | 'CONTRACT' | 'SPOT'
    );
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/positions', async (req: Request, res: Response) => {
  const category = typeof req.query.category === 'string' ? req.query.category : 'linear';
  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
  const settleCoin = typeof req.query.settleCoin === 'string' ? req.query.settleCoin : undefined;
  try {
    const result = await orderManager.getPositions(
      category as 'linear' | 'inverse' | 'option',
      symbol,
      settleCoin
    );
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/orders', async (req: Request, res: Response) => {
  const category = typeof req.query.category === 'string' ? req.query.category : 'linear';
  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
  try {
    const result = await orderManager.getOrders(
      category as 'linear' | 'inverse' | 'option',
      symbol
    );
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/executions', async (req: Request, res: Response) => {
  const category = typeof req.query.category === 'string' ? req.query.category : 'linear';
  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
  try {
    const result = await orderManager.getExecutions(
      category as 'linear' | 'inverse' | 'option',
      symbol
    );
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/instruments', async (req: Request, res: Response) => {
  const category = typeof req.query.category === 'string' ? req.query.category : 'linear';
  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
  try {
    const result = await orderManager.getInstrumentsInfo(
      category as 'linear' | 'inverse' | 'option' | 'spot',
      symbol
    );
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/tickers', async (req: Request, res: Response) => {
  const category = typeof req.query.category === 'string' ? req.query.category : 'linear';
  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
  try {
    const result = await orderManager.getTickers(
      category as 'linear' | 'inverse' | 'option' | 'spot',
      symbol
    );
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
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

app.post('/api/trading-stop', async (req: Request, res: Response) => {
  const {
    symbol,
    stopLoss,
    takeProfit,
    slTriggerBy,
    tpTriggerBy,
    positionIdx,
    category
  } = req.body;
  try {
    const result = await orderManager.setTradingStop({
      category,
      symbol,
      stopLoss,
      takeProfit,
      slTriggerBy,
      tpTriggerBy,
      positionIdx
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = 4000;
server.listen(PORT, () => {
  console.log(`🚀 Bot backend running on http://localhost:${PORT}`);
});
