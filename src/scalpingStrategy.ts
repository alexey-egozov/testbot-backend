import { TradeEngine } from './tradeEngine';
import { OrderManager } from './orderManager';
import { Candle, computeATR, computeRSI } from './indicators';
import { PositionState } from './positionState';

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
  private leverageSet = false;
  private positionState = new PositionState();
  private paperPosition: {
    side: PositionSide;
    entryPrice: number;
    qty: number;
    stopLoss: number;
    takeProfit: number;
  } | null = null;

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

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick() {
    const now = Date.now();
    if (now - this.lastTradeAt < this.config.cooldownMs) {
      return;
    }
    await this.ensureInstrumentMeta();
    if (!this.instrumentMeta) {
      return;
    }
    await this.ensureLeverage();
    await this.reconcilePositions();
    await this.refreshDayEquity();
    this.lastEquity = await this.getEquity();

    if (!this.canTradeToday()) {
      return;
    }
    if (this.tradesToday >= this.config.maxTradesPerDay) {
      return;
    }

    const candles = await this.getCandles();
    if (candles.length === 0) {
      return;
    }
    const closes = candles.map(candle => candle.close);
    const rsi = computeRSI(closes, this.config.rsiPeriod);
    const atr = computeATR(candles, 14);
    if (rsi === null || atr === null) {
      return;
    }
    this.checkPaperPosition(closes[closes.length - 1]);

    if (!this.passesLiquidityFilters()) {
      return;
    }

    const signal = this.getSignal(rsi);
    if (!signal || signal === this.lastSignal) {
      return;
    }

    if (this.openPositionSide || this.paperPosition) {
      return;
    }
    if (this.openOrderLinkId) {
      return;
    }

    await this.executeSignal(signal, atr, closes[closes.length - 1]);
    this.lastSignal = signal;
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

  private passesLiquidityFilters(): boolean {
    const orderBook = this.tradeEngine.orderBook;
    if (!orderBook) {
      return false;
    }
    if (!this.instrumentMeta) {
      return false;
    }
    if (!orderBook.bestAsk || !orderBook.bestBid) {
      return false;
    }
    const spread = orderBook.bestAsk - orderBook.bestBid;
    const spreadTicks = spread / this.instrumentMeta.tickSize;
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
      return;
    }

    const stopDistance = Math.max(atr * this.config.stopAtrMultiplier, this.instrumentMeta.tickSize * 10);
    const riskAmount = equity * this.config.riskPerTradePct;
    let qty = riskAmount / stopDistance;
    qty = this.roundQty(qty);
    if (qty < this.instrumentMeta.minOrderQty) {
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
        this.paperPosition = null;
      }
    } else if (side === 'Sell') {
      if (lastPrice >= stopLoss || lastPrice <= takeProfit) {
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
