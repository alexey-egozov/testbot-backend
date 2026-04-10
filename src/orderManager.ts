import axios from 'axios';
import crypto from 'crypto';
import { API_KEY, API_SECRET, BYBIT_REST_URL } from './config';

export class OrderManager {
  private timeOffsetMs = 0;
  private lastTimeSyncMs = 0;
  private lastRequestAt = 0;
  private minRequestIntervalMs = 200;

  private buildQueryString(params: Record<string, string | number | boolean | undefined>): string {
    const entries = Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]);
    entries.sort(([a], [b]) => a.localeCompare(b));
    return entries
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
  }

  private sign(
    timestamp: string,
    recvWindow: string,
    body: string
  ): string {
    const payload = timestamp + API_KEY + recvWindow + body;
    return crypto
      .createHmac('sha256', API_SECRET)
      .update(payload)
      .digest('hex');
  }

  private async syncTimeIfNeeded(force = false) {
    const now = Date.now();
    if (!force && now - this.lastTimeSyncMs < 15000) {
      return;
    }
    try {
      const response = await axios.get(`${BYBIT_REST_URL}/v5/market/time`);
      const serverTimeSecond = response?.data?.result?.timeSecond;
      const serverTimeMs = serverTimeSecond ? Number(serverTimeSecond) * 1000 : response?.data?.time;
      if (Number.isFinite(serverTimeMs)) {
        this.timeOffsetMs = serverTimeMs - now;
        this.lastTimeSyncMs = now;
      }
    } catch (error) {
    }
  }

  private async signedGet(path: string, params: Record<string, string | number | boolean | undefined>) {
    await this.applyRateLimit();
    await this.syncTimeIfNeeded();
    return this.requestWithRetry(() => this.doSignedGet(path, params));
  }

  private async signedPost(path: string, body: Record<string, unknown>) {
    await this.applyRateLimit();
    await this.syncTimeIfNeeded();
    return this.requestWithRetry(() => this.doSignedPost(path, body));
  }

  private async applyRateLimit() {
    const now = Date.now();
    const delta = now - this.lastRequestAt;
    if (delta < this.minRequestIntervalMs) {
      await new Promise(resolve => setTimeout(resolve, this.minRequestIntervalMs - delta));
    }
    this.lastRequestAt = Date.now();
  }

  private async requestWithRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        const response: any = await fn();
        const retCode = response?.retCode;
        if (retCode === 10002) {
          await this.syncTimeIfNeeded(true);
          if (attempt < retries) {
            attempt += 1;
            continue;
          }
        }
        if (retCode === 10006) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (attempt < retries) {
            attempt += 1;
            continue;
          }
        }
        return response;
      } catch (error) {
        if (attempt < retries) {
          attempt += 1;
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        throw error;
      }
    }
  }

  private async doSignedGet(path: string, params: Record<string, string | number | boolean | undefined>) {
    const timestamp = (Date.now() + this.timeOffsetMs).toString();
    const recvWindow = '5000';
    const queryString = this.buildQueryString(params);
    const signature = this.sign(timestamp, recvWindow, queryString);
    const url = `${BYBIT_REST_URL}${path}${queryString ? `?${queryString}` : ''}`;

    const response = await axios.get(url, {
      headers: {
        'X-BAPI-API-KEY': API_KEY,
        'X-BAPI-SIGN': signature,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow
      }
    });

    return response.data;
  }

  private async doSignedPost(path: string, body: Record<string, unknown>) {
    const timestamp = (Date.now() + this.timeOffsetMs).toString();
    const recvWindow = '5000';
    const bodyString = JSON.stringify(body);
    const signature = this.sign(timestamp, recvWindow, bodyString);

    const response = await axios.post(`${BYBIT_REST_URL}${path}`, bodyString, {
      headers: {
        'X-BAPI-API-KEY': API_KEY,
        'X-BAPI-SIGN': signature,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
        'Content-Type': 'application/json'
      }
    });

    return response.data;
  }

  async getWalletBalance(accountType: 'UNIFIED' | 'CONTRACT' | 'SPOT' = 'UNIFIED') {
    return this.signedGet('/v5/account/wallet-balance', { accountType });
  }

  async getAccountInfo() {
    return this.signedGet('/v5/account/info', {});
  }

  async getPositions(
    category: 'linear' | 'inverse' | 'option' = 'linear',
    symbol?: string,
    settleCoin?: string
  ) {
    return this.signedGet('/v5/position/list', {
      category,
      symbol,
      settleCoin: symbol ? undefined : settleCoin ?? 'USDT'
    });
  }

  async getOrders(category: 'linear' | 'inverse' | 'option' = 'linear', symbol?: string) {
    return this.signedGet('/v5/order/realtime', { category, symbol });
  }

  async getOrderHistory(category: 'linear' | 'inverse' | 'option' = 'linear', symbol?: string) {
    return this.signedGet('/v5/order/history', { category, symbol, limit: 20 });
  }

  async cancelOrder(params: {
    category?: 'linear' | 'inverse' | 'option';
    symbol: string;
    orderId?: string;
    orderLinkId?: string;
  }) {
    const body = {
      category: params.category ?? 'linear',
      symbol: params.symbol,
      orderId: params.orderId,
      orderLinkId: params.orderLinkId
    };
    return this.signedPost('/v5/order/cancel', body);
  }

  async getExecutions(category: 'linear' | 'inverse' | 'option' = 'linear', symbol?: string) {
    return this.signedGet('/v5/execution/list', { category, symbol });
  }

  async getClosedPnl(category: 'linear' | 'inverse' = 'linear', symbol?: string) {
    return this.signedGet('/v5/position/closed-pnl', { category, symbol, limit: 20 });
  }

  async setTradingStop(params: {
    category?: 'linear' | 'inverse';
    symbol: string;
    stopLoss?: string;
    takeProfit?: string;
    slTriggerBy?: string;
    tpTriggerBy?: string;
    positionIdx?: number;
  }) {
    const body = {
      category: params.category ?? 'linear',
      symbol: params.symbol,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
      slTriggerBy: params.slTriggerBy,
      tpTriggerBy: params.tpTriggerBy,
      positionIdx: params.positionIdx
    };
    return this.signedPost('/v5/position/trading-stop', body);
  }

  async setLeverage(params: {
    category?: 'linear' | 'inverse';
    symbol: string;
    buyLeverage: string;
    sellLeverage: string;
  }) {
    const body = {
      category: params.category ?? 'linear',
      symbol: params.symbol,
      buyLeverage: params.buyLeverage,
      sellLeverage: params.sellLeverage
    };
    return this.signedPost('/v5/position/set-leverage', body);
  }

  async getInstrumentsInfo(category: 'linear' | 'inverse' | 'option' | 'spot' = 'linear', symbol?: string) {
    const queryString = this.buildQueryString({ category, symbol });
    const url = `${BYBIT_REST_URL}/v5/market/instruments-info${queryString ? `?${queryString}` : ''}`;
    const response = await axios.get(url);
    return response.data;
  }

  async getKlines(params: {
    category: 'linear' | 'inverse' | 'option' | 'spot';
    symbol: string;
    interval: string;
    limit?: number;
  }) {
    const queryString = this.buildQueryString({
      category: params.category,
      symbol: params.symbol,
      interval: params.interval,
      limit: params.limit ?? 200
    });
    const url = `${BYBIT_REST_URL}/v5/market/kline${queryString ? `?${queryString}` : ''}`;
    const response = await axios.get(url);
    return response.data;
  }

  async getTickers(category: 'linear' | 'inverse' | 'option' | 'spot' = 'linear', symbol?: string) {
    const queryString = this.buildQueryString({ category, symbol });
    const url = `${BYBIT_REST_URL}/v5/market/tickers${queryString ? `?${queryString}` : ''}`;
    const response = await axios.get(url);
    return response.data;
  }

  async createOrder(params: {
    symbol: string;
    side: 'Buy' | 'Sell';
    qty: number;
    orderType: 'Market' | 'Limit';
    orderLinkId?: string;
  }) {
    const body = {
      category: 'linear',
      symbol: params.symbol,
      side: params.side,
      orderType: params.orderType,
      qty: params.qty.toString(),
      timeInForce: 'IOC',
      orderLinkId: params.orderLinkId
    };
    return this.signedPost('/v5/order/create', body);
  }

  async createTestOrder(
    symbol: string,
    side: 'Buy' | 'Sell',
    qty: number
  ) {
    return this.createOrder({
      symbol,
      side,
      qty,
      orderType: 'Market'
    });
  }
}