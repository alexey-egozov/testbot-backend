import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { BYBIT_WS_URL } from './config';
import { BybitOrderBookData, BybitWSMessage } from './types/bybit';

type OrderBookLevel = [number, number];

export type OrderBookSnapshot = {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  bidDepth: number;
  askDepth: number;
  updatedAt: number;
};

export class TradeEngine {
  private ws: WebSocket | null = null;
  private emitter = new EventEmitter();
  public lastPrice: number | null = null;
  public orderBook: OrderBookSnapshot | null = null;

  onOrderBookUpdate(listener: (snapshot: OrderBookSnapshot) => void) {
    this.emitter.on('orderBook', listener);
  }

  connect() {
    if (!BYBIT_WS_URL) {
      throw new Error('BYBIT_WS_URL is not configured');
    }
    // Clean and validate URL
    const cleanUrl = BYBIT_WS_URL.trim();
    try {
      new URL(cleanUrl); // Validate URL format
    } catch (error) {
      throw new Error(`Invalid WebSocket URL format: ${cleanUrl}`);
    }
    this.ws = new WebSocket(cleanUrl);

    this.ws.on('open', () => {
      console.log('✅ Connected to Bybit Demo WebSocket');
      this.ws?.send(JSON.stringify({
        op: 'subscribe',
        args: ['tickers.BTCUSDT', 'orderbook.50.BTCUSDT']
      }));
    });

    this.ws.on('error', (error: Error) => {
      // Error handler for WebSocket errors
    });

    this.ws.on('message', (msg: string) => {
      const data: BybitWSMessage = JSON.parse(msg);
      if (data.topic?.startsWith('tickers') && data.data) {
        this.lastPrice = parseFloat(data.data.lastPrice);
      }
      if (data.topic?.startsWith('orderbook') && data.data) {
        const orderBookData = data.data as BybitOrderBookData;
        const symbol = orderBookData.s || 'BTCUSDT';
        const rawBids = Array.isArray(orderBookData.b) ? orderBookData.b : [];
        const rawAsks = Array.isArray(orderBookData.a) ? orderBookData.a : [];
        const bids: OrderBookLevel[] = [];
        for (const level of rawBids) {
          const price = parseFloat(level[0]);
          const size = parseFloat(level[1]);
          if (Number.isFinite(price) && Number.isFinite(size)) {
            bids.push([price, size]);
          }
        }
        const asks: OrderBookLevel[] = [];
        for (const level of rawAsks) {
          const price = parseFloat(level[0]);
          const size = parseFloat(level[1]);
          if (Number.isFinite(price) && Number.isFinite(size)) {
            asks.push([price, size]);
          }
        }
        const bestBid = bids.length > 0 ? bids[0][0] : null;
        const bestAsk = asks.length > 0 ? asks[0][0] : null;
        const bidDepth = bids.reduce((sum, level) => sum + level[1], 0);
        const askDepth = asks.reduce((sum, level) => sum + level[1], 0);

        this.orderBook = {
          symbol,
          bids,
          asks,
          bestBid,
          bestAsk,
          bidDepth,
          askDepth,
          updatedAt: Date.now()
        };
        this.emitter.emit('orderBook', this.orderBook);
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      console.log('⚠️ WebSocket disconnected. Reconnecting...');
      setTimeout(() => this.connect(), 2000);
    });
  }
}
