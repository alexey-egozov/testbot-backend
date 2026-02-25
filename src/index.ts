import express, { Request, Response } from 'express';
import cors from 'cors';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { TradeEngine } from './tradeEngine';
import { OrderManager } from './orderManager';
import { ScalpingStrategy } from './scalpingStrategy';

const app = express();
app.use(cors());
app.use(express.json());

const tradeEngine = new TradeEngine();
tradeEngine.connect();

const orderManager = new OrderManager();
const autoScalpingEnabled = process.env.AUTO_SCALPING_ENABLED !== 'false';

let strategy: ScalpingStrategy | null = null;
if (autoScalpingEnabled) {
  strategy = new ScalpingStrategy(tradeEngine, orderManager, {
    symbol: 'BTCUSDT',
    category: 'linear',
    interval: '1',
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    riskPerTradePct: 0.001,
    dailyStopPct: 0.005,
    stopAtrMultiplier: 0.6,
    takeProfitMultiplier: 1.2,
    minSpreadTicks: 1,
    minBidDepth: 5,
    minAskDepth: 5,
    maxRetries: 5,
    pollIntervalMs: 10000,
    cooldownMs: 60000,
    maxTradesPerDay: 6,
    paperTrading: process.env.PAPER_TRADING === 'true'
  });
  strategy.start();
  console.log('✅ Auto-scalping strategy started');
} else {
  console.log('⏸️ Auto-scalping strategy disabled');
}

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

app.get('/api/account/info', async (req: Request, res: Response) => {
  try {
    const result = await orderManager.getAccountInfo();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/strategy/status', (req: Request, res: Response) => {
  if (!strategy) {
    res.json({ enabled: false, paperTrading: false });
    return;
  }
  res.json({ enabled: true, paperTrading: strategy.getPaperTrading() });
});

app.post('/api/strategy/mode', (req: Request, res: Response) => {
  if (!strategy) {
    res.status(400).json({ error: 'Strategy is disabled' });
    return;
  }
  const { paperTrading } = req.body;
  if (typeof paperTrading !== 'boolean') {
    res.status(400).json({ error: 'paperTrading must be boolean' });
    return;
  }
  strategy.setPaperTrading(paperTrading);
  res.json({ enabled: true, paperTrading: strategy.getPaperTrading() });
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
