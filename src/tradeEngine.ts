import WebSocket from 'ws';
import { BYBIT_WS_URL } from './config';
import { BybitWSMessage } from './types/bybit';

export class TradeEngine {
  private ws: WebSocket | null = null;
  public lastPrice: number | null = null;

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
        args: ['tickers.BTCUSDT']
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
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      console.log('⚠️ WebSocket disconnected. Reconnecting...');
      setTimeout(() => this.connect(), 2000);
    });
  }
}
