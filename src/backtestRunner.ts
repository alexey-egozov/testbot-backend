import { OrderManager } from './orderManager';
import { Candle, computeATR, computeRSI } from './indicators';

type BacktestConfig = {
  symbol: string;
  category: 'linear' | 'inverse';
  interval: string;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  stopAtrMultiplier: number;
  takeProfitMultiplier: number;
};

type Trade = {
  side: 'Buy' | 'Sell';
  entryPrice: number;
  exitPrice: number;
  pnl: number;
};

async function runBacktest(config: BacktestConfig) {
  const orderManager = new OrderManager();
  const response = await orderManager.getKlines({
    category: config.category,
    symbol: config.symbol,
    interval: config.interval,
    limit: 200
  });
  const list = Array.isArray(response?.result?.list) ? response.result.list : [];
  const candles: Candle[] = list
    .map((item: string[]) => ({
      timestamp: Number(item[0]),
      open: Number(item[1]),
      high: Number(item[2]),
      low: Number(item[3]),
      close: Number(item[4]),
      volume: Number(item[5])
    }))
    .filter((candle: Candle) => Number.isFinite(candle.close))
    .sort((a: Candle, b: Candle) => a.timestamp - b.timestamp);

  const closes = candles.map(candle => candle.close);
  const rsi = computeRSI(closes, config.rsiPeriod);
  const atr = computeATR(candles, 14);
  if (rsi === null || atr === null) {
    console.log('Not enough data for backtest.');
    return;
  }

  const trades: Trade[] = [];
  let position: { side: 'Buy' | 'Sell'; entryPrice: number; stopLoss: number; takeProfit: number } | null = null;

  for (let i = 1; i < candles.length; i += 1) {
    const close = candles[i].close;
    const rsiNow = computeRSI(closes.slice(0, i + 1), config.rsiPeriod);
    if (rsiNow === null || atr === null) {
      continue;
    }

    if (!position) {
      if (rsiNow <= config.rsiOversold) {
        const stop = close - atr * config.stopAtrMultiplier;
        const take = close + atr * config.takeProfitMultiplier;
        position = { side: 'Buy', entryPrice: close, stopLoss: stop, takeProfit: take };
      } else if (rsiNow >= config.rsiOverbought) {
        const stop = close + atr * config.stopAtrMultiplier;
        const take = close - atr * config.takeProfitMultiplier;
        position = { side: 'Sell', entryPrice: close, stopLoss: stop, takeProfit: take };
      }
      continue;
    }

    if (position.side === 'Buy' && (close <= position.stopLoss || close >= position.takeProfit)) {
      trades.push({
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: close,
        pnl: close - position.entryPrice
      });
      position = null;
    }
    if (position?.side === 'Sell' && (close >= position.stopLoss || close <= position.takeProfit)) {
      trades.push({
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: close,
        pnl: position.entryPrice - close
      });
      position = null;
    }
  }

  const totalPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const wins = trades.filter(trade => trade.pnl > 0).length;
  console.log(`Trades: ${trades.length}, Wins: ${wins}, PnL: ${totalPnl.toFixed(4)}`);
}

runBacktest({
  symbol: 'BTCUSDT',
  category: 'linear',
  interval: '1',
  rsiPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  stopAtrMultiplier: 0.6,
  takeProfitMultiplier: 1.2
}).catch(error => {
  console.log('Backtest failed', (error as Error).message);
});
