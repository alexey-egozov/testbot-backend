import { TradeEngine } from './tradeEngine';
import { OrderManager } from './orderManager';
import { Candle, computeATR, computeRSI } from './indicators';
import { PositionState } from './positionState';
import { loadStrategyConfig, saveStrategyConfig } from './strategyConfigStore';

type StrategyConfig = {
  symbol: string;
  category: 'linear' | 'inverse';
  interval: string;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  riskPerTradePct: number;
  dailyStopPct: number;
  stopAtrMultiplier: number;
  takeProfitMultiplier: number;
  minSpreadTicks: number;
  minBidDepth: number;
  minAskDepth: number;
  maxTradesPerDay: number;
  maxRetries: number;
  pollIntervalMs: number;
  cooldownMs: number;
  paperTrading: boolean;
};

type InstrumentMeta = {
  tickSize: number;
  qtyStep: number;
  minOrderQty: number;
  maxOrderQty: number;
};

type PositionSide = 'Buy' | 'Sell' | null;

type StrategyDiagnostics = {
  lastTickAt: number | null;
  rsi: number | null;
  atr: number | null;
  signal: PositionSide;
  spreadTicks: number | null;
  bidDepth: number | null;
  askDepth: number | null;
  equity: number | null;
  riskAmount: number | null;
  qty: number | null;
  blockedReasons: string[];
};

export class ScalpingStrategy {
  private timer: NodeJS.Timeout | null = null;
  private lastTradeAt = 0;
  private dayStartEquity: number | null = null;
  private dayStartDate = '';
  private lastEquity: number | null = null;
  private tradesToday = 0;
  private openOrderLinkId: string | null = null;
  private openPositionSide: PositionSide = null;
  private instrumentMeta: InstrumentMeta | null = null;
  private lastSignal: PositionSide = null;
  private lastSignalReset = true;
  private configLoaded = false;
  private leverageSet = false;
  private positionState = new PositionState();
  private paperPosition: {
    side: PositionSide;
    entryPrice: number;
    qty: number;
    stopLoss: number;
    takeProfit: number;
  } | null = null;
  private paperLogs: { timestamp: number; message: string }[] = [];
  private diagnostics: StrategyDiagnostics = {
    lastTickAt: null,
    rsi: null,
    atr: null,
    signal: null,
    spreadTicks: null,
    bidDepth: null,
    askDepth: null,
    equity: null,
    riskAmount: null,
    qty: null,
    blockedReasons: []
  };

  constructor(
    private tradeEngine: TradeEngine,
    private orderManager: OrderManager,
    private config: StrategyConfig
  ) {}

  start() {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.tick().catch(error => {
        console.log('[strategy] tick error', (error as Error).message);
      });
    }, this.config.pollIntervalMs);
  }

  setPaperTrading(enabled: boolean) {
    this.config.paperTrading = enabled;
    if (!enabled) {
      this.paperPosition = null;
    }
  }

  getPaperTrading() {
    return this.config.paperTrading;
  }

  getPaperLogs() {
    return this.paperLogs.slice(-50);
  }

  getRsiThresholds() {
    this.ensureConfigLoaded();
    return {
      oversold: this.config.rsiOversold,
      overbought: this.config.rsiOverbought
    };
  }

  setRsiThresholds(oversold: number, overbought: number) {
    this.config.rsiOversold = oversold;
    this.config.rsiOverbought = overbought;
    this.persistConfig();
  }

  getFilterSettings() {
    this.ensureConfigLoaded();
    return {
      minSpreadTicks: this.config.minSpreadTicks,
      minBidDepth: this.config.minBidDepth,
      minAskDepth: this.config.minAskDepth
    };
  }

  setFilterSettings(minSpreadTicks: number, minBidDepth: number, minAskDepth: number) {
    this.config.minSpreadTicks = minSpreadTicks;
    this.config.minBidDepth = minBidDepth;
    this.config.minAskDepth = minAskDepth;
    this.persistConfig();
  }

  getDiagnostics() {
    return this.diagnostics;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning() {
    return Boolean(this.timer);
  }

  ensureConfigLoaded() {
    if (!this.configLoaded) {
      this.loadPersistedConfig();
    }
  }

  private async tick() {
    if (!this.configLoaded) {
      this.loadPersistedConfig();
    }
    const now = Date.now();
    this.diagnostics = {
      ...this.diagnostics,
      lastTickAt: now,
      blockedReasons: []
    };
    if (now - this.lastTradeAt < this.config.cooldownMs) {
      this.diagnostics.blockedReasons.push('cooldown');
      return;
    }
    await this.ensureInstrumentMeta();
    if (!this.instrumentMeta) {
      this.diagnostics.blockedReasons.push('no-instrument-meta');
      return;
    }
    await this.ensureLeverage();
    await this.reconcilePositions();
    await this.refreshDayEquity();
    this.lastEquity = await this.getEquity();
    this.diagnostics.equity = this.lastEquity;

    if (!this.canTradeToday()) {
      this.diagnostics.blockedReasons.push('daily-stop-hit');
      return;
    }
    if (this.tradesToday >= this.config.maxTradesPerDay) {
      this.diagnostics.blockedReasons.push('max-trades-reached');
      return;
    }

    const candles = await this.getCandles();
    if (candles.length === 0) {
      this.diagnostics.blockedReasons.push('no-candles');
      return;
    }
    const closes = candles.map(candle => candle.close);
    const rsi = computeRSI(closes, this.config.rsiPeriod);
    const atr = computeATR(candles, 14);
    if (rsi === null || atr === null) {
      this.diagnostics.blockedReasons.push('insufficient-data');
      return;
    }
    this.diagnostics.rsi = rsi;
    this.diagnostics.atr = atr;
    this.checkPaperPosition(closes[closes.length - 1]);

    const liquidityOk = this.passesLiquidityFilters();
    if (!liquidityOk) {
      this.diagnostics.blockedReasons.push('liquidity-filter');
      return;
    }

    const signal = this.getSignal(rsi);
    this.diagnostics.signal = signal;
    if (this.lastSignal === 'Buy' && rsi >= this.getRsiResetBuy()) {
      this.lastSignalReset = true;
    }
    if (this.lastSignal === 'Sell' && rsi <= this.getRsiResetSell()) {
      this.lastSignalReset = true;
    }
    if (!signal) {
      this.diagnostics.blockedReasons.push('no-signal');
      return;
    }
    if (signal === this.lastSignal && !this.lastSignalReset) {
      this.diagnostics.blockedReasons.push('rsi-reset-required');
      return;
    }

    if (this.openPositionSide || this.paperPosition) {
      this.diagnostics.blockedReasons.push('position-open');
      return;
    }
    if (this.openOrderLinkId) {
      this.diagnostics.blockedReasons.push('order-pending');
      return;
    }

    await this.executeSignal(signal, atr, closes[closes.length - 1]);
    this.lastSignal = signal;
    this.lastSignalReset = false;
  }

  private getSignal(rsi: number): PositionSide {
    if (rsi <= this.config.rsiOversold) {
      return 'Buy';
    }
    if (rsi >= this.config.rsiOverbought) {
      return 'Sell';
    }
    return null;
  }

  private loadPersistedConfig() {
    const saved = loadStrategyConfig();
    if (saved) {
      this.config.rsiOversold = saved.rsiOversold;
      this.config.rsiOverbought = saved.rsiOverbought;
      this.config.minSpreadTicks = saved.minSpreadTicks;
      this.config.minBidDepth = saved.minBidDepth;
      this.config.minAskDepth = saved.minAskDepth;
    }
    this.configLoaded = true;
  }

  private persistConfig() {
    const snapshot = {
      rsiOversold: this.config.rsiOversold,
      rsiOverbought: this.config.rsiOverbought,
      minSpreadTicks: this.config.minSpreadTicks,
      minBidDepth: this.config.minBidDepth,
      minAskDepth: this.config.minAskDepth
    };
    saveStrategyConfig(snapshot);
  }

  private getRsiResetBuy() {
    return Math.min(this.config.rsiOversold + 10, 50);
  }

  private getRsiResetSell() {
    return Math.max(this.config.rsiOverbought - 10, 50);
  }

  private passesLiquidityFilters(): boolean {
    const orderBook = this.tradeEngine.orderBook;
    if (!orderBook) {
      this.diagnostics.blockedReasons.push('no-orderbook');
      return false;
    }
    if (!this.instrumentMeta) {
      return false;
    }
    if (!orderBook.bestAsk || !orderBook.bestBid) {
      this.diagnostics.blockedReasons.push('no-best-bid-ask');
      return false;
    }
    const spread = orderBook.bestAsk - orderBook.bestBid;
    const spreadTicks = spread / this.instrumentMeta.tickSize;
    this.diagnostics.spreadTicks = spreadTicks;
    this.diagnostics.bidDepth = orderBook.bidDepth;
    this.diagnostics.askDepth = orderBook.askDepth;
    // Negative/zero spread = crossed/invalid book; do not treat as "tight" liquidity.
    if (orderBook.bestAsk <= orderBook.bestBid || spreadTicks < 0) {
      this.diagnostics.blockedReasons.push('invalid-spread');
      return false;
    }
    if (spreadTicks > this.config.minSpreadTicks) {
      return false;
    }
    if (orderBook.bidDepth < this.config.minBidDepth) {
      return false;
    }
    if (orderBook.askDepth < this.config.minAskDepth) {
      return false;
    }
    return true;
  }

  private async executeSignal(side: PositionSide, atr: number, lastClose: number) {
    if (!side || !this.instrumentMeta) {
      return;
    }

    const equity = this.lastEquity ?? (await this.getEquity());
    if (!equity) {
      this.diagnostics.blockedReasons.push('no-equity');
      return;
    }

    const stopDistance = Math.max(atr * this.config.stopAtrMultiplier, this.instrumentMeta.tickSize * 10);
    const riskAmount = equity * this.config.riskPerTradePct;
    let qty = riskAmount / stopDistance;
    qty = this.roundQty(qty);
    this.diagnostics.riskAmount = riskAmount;
    this.diagnostics.qty = qty;
    if (qty < this.instrumentMeta.minOrderQty) {
      this.diagnostics.blockedReasons.push('qty-below-min');
      return;
    }
    if (qty > this.instrumentMeta.maxOrderQty) {
      qty = this.instrumentMeta.maxOrderQty;
    }

    const orderLinkId = `scalp-${this.config.symbol}-${Date.now()}`;
    this.openOrderLinkId = orderLinkId;

    if (this.config.paperTrading) {
      const entryPrice = lastClose;
      const stopLoss = side === 'Buy' ? entryPrice - stopDistance : entryPrice + stopDistance;
      const takeProfit = side === 'Buy'
        ? entryPrice + stopDistance * this.config.takeProfitMultiplier
        : entryPrice - stopDistance * this.config.takeProfitMultiplier;
      this.paperPosition = {
        side,
        entryPrice,
        qty,
        stopLoss: this.roundPrice(stopLoss),
        takeProfit: this.roundPrice(takeProfit)
      };
      this.paperLogs.push({
        timestamp: Date.now(),
        message: `Open ${side} @ ${entryPrice.toFixed(2)} qty ${qty.toFixed(4)}`
      });
      this.lastTradeAt = Date.now();
      this.tradesToday += 1;
      this.openOrderLinkId = null;
      return;
    }

    const order = await this.withRetries(
      () =>
        this.orderManager.createOrder({
          symbol: this.config.symbol,
          side,
          qty,
          orderType: 'Market',
          orderLinkId
        }),
      'createOrder'
    );

    const orderId = order?.result?.orderId;
    if (!orderId) {
      this.openOrderLinkId = null;
      return;
    }

    const filled = await this.waitForFill(orderId);
    if (!filled) {
      await this.orderManager.cancelOrder({
        symbol: this.config.symbol,
        orderId
      });
      this.openOrderLinkId = null;
      return;
    }

    const entryPrice = filled.avgPrice ? Number(filled.avgPrice) : lastClose;
    const stopLoss = side === 'Buy' ? entryPrice - stopDistance : entryPrice + stopDistance;
    const takeProfit = side === 'Buy'
      ? entryPrice + stopDistance * this.config.takeProfitMultiplier
      : entryPrice - stopDistance * this.config.takeProfitMultiplier;

    await this.withRetries(
      () =>
        this.orderManager.setTradingStop({
          symbol: this.config.symbol,
          stopLoss: this.roundPrice(stopLoss).toString(),
          takeProfit: this.roundPrice(takeProfit).toString(),
          slTriggerBy: 'MarkPrice',
          tpTriggerBy: 'MarkPrice'
        }),
      'setTradingStop'
    );

    this.lastTradeAt = Date.now();
    this.tradesToday += 1;
    this.openOrderLinkId = null;
  }

  private async waitForFill(orderId: string) {
    for (let attempt = 0; attempt < this.config.maxRetries; attempt += 1) {
      const orders = await this.orderManager.getOrders(this.config.category, this.config.symbol);
      const list = Array.isArray(orders?.result?.list) ? orders.result.list : [];
      const found = list.find((item: any) => item.orderId === orderId);
      if (found && (found.orderStatus === 'Filled' || found.orderStatus === 'PartiallyFilled')) {
        return found;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return null;
  }

  private checkPaperPosition(lastPrice: number) {
    if (!this.paperPosition) {
      return;
    }
    const { side, stopLoss, takeProfit } = this.paperPosition;
    if (side === 'Buy') {
      if (lastPrice <= stopLoss || lastPrice >= takeProfit) {
        const exitPrice = lastPrice;
        this.paperLogs.push({
          timestamp: Date.now(),
          message: `Close Buy @ ${exitPrice.toFixed(2)} (SL/TP hit)`
        });
        this.paperPosition = null;
      }
    } else if (side === 'Sell') {
      if (lastPrice >= stopLoss || lastPrice <= takeProfit) {
        const exitPrice = lastPrice;
        this.paperLogs.push({
          timestamp: Date.now(),
          message: `Close Sell @ ${exitPrice.toFixed(2)} (SL/TP hit)`
        });
        this.paperPosition = null;
      }
    }
  }

  private async withRetries<T>(fn: () => Promise<T>, label: string): Promise<T | null> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.config.maxRetries; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    if (lastError) {
      console.log(`[strategy] ${label} failed`, lastError.message);
    }
    return null;
  }

  private async reconcilePositions() {
    const positions = await this.orderManager.getPositions(this.config.category, this.config.symbol);
    const list = Array.isArray(positions?.result?.list) ? positions.result.list : [];
    this.positionState.reconcile(list);
    const open = this.positionState.getOpenPosition(this.config.symbol);
    this.openPositionSide = open ? open.side : null;
  }

  private async ensureInstrumentMeta() {
    if (this.instrumentMeta) {
      return;
    }
    const info = await this.orderManager.getInstrumentsInfo(this.config.category, this.config.symbol);
    const item = info?.result?.list?.[0];
    if (!item) {
      return;
    }
    this.instrumentMeta = {
      tickSize: Number(item.priceFilter?.tickSize ?? 0.5),
      qtyStep: Number(item.lotSizeFilter?.qtyStep ?? 0.001),
      minOrderQty: Number(item.lotSizeFilter?.minOrderQty ?? 0.001),
      maxOrderQty: Number(item.lotSizeFilter?.maxOrderQty ?? 1000)
    };
  }

  private async ensureLeverage() {
    if (this.leverageSet) {
      return;
    }
    await this.orderManager.setLeverage({
      category: this.config.category,
      symbol: this.config.symbol,
      buyLeverage: '1',
      sellLeverage: '1'
    });
    this.leverageSet = true;
  }

  private async getCandles(): Promise<Candle[]> {
    const response = await this.orderManager.getKlines({
      category: this.config.category,
      symbol: this.config.symbol,
      interval: this.config.interval,
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
    return candles;
  }

  private async refreshDayEquity() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.dayStartDate !== today) {
      this.dayStartDate = today;
      const equity = await this.getEquity();
      this.dayStartEquity = equity ?? null;
      this.tradesToday = 0;
    }
  }

  private async getEquity(): Promise<number | null> {
    const wallet = await this.orderManager.getWalletBalance('UNIFIED');
    const summary = wallet?.result?.list?.[0];
    const equity = summary?.totalWalletBalance;
    return equity ? Number(equity) : null;
  }

  private canTradeToday(): boolean {
    if (!this.dayStartEquity || !Number.isFinite(this.dayStartEquity)) {
      return true;
    }
    if (!this.lastEquity || !Number.isFinite(this.lastEquity)) {
      return true;
    }
    const drawdown = (this.dayStartEquity - this.lastEquity) / this.dayStartEquity;
    return drawdown <= this.config.dailyStopPct;
  }

  private roundQty(qty: number) {
    if (!this.instrumentMeta) {
      return qty;
    }
    const step = this.instrumentMeta.qtyStep;
    return Math.floor(qty / step) * step;
  }

  private roundPrice(price: number) {
    if (!this.instrumentMeta) {
      return price;
    }
    const step = this.instrumentMeta.tickSize;
    return Math.round(price / step) * step;
  }
}
