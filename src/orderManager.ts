import axios from 'axios';
import crypto from 'crypto';
import { API_KEY, API_SECRET, BYBIT_REST_URL } from './config';

export class OrderManager {
  private timeOffsetMs = 0;
  private lastTimeSyncMs = 0;

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

  private async syncTimeIfNeeded() {
    const now = Date.now();
    if (now - this.lastTimeSyncMs < 15000) {
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
    await this.syncTimeIfNeeded();
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

  private async signedPost(path: string, body: Record<string, unknown>) {
    await this.syncTimeIfNeeded();
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

  async getExecutions(category: 'linear' | 'inverse' | 'option' = 'linear', symbol?: string) {
    return this.signedGet('/v5/execution/list', { category, symbol });
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

  async getInstrumentsInfo(category: 'linear' | 'inverse' | 'option' | 'spot' = 'linear', symbol?: string) {
    const queryString = this.buildQueryString({ category, symbol });
    const url = `${BYBIT_REST_URL}/v5/market/instruments-info${queryString ? `?${queryString}` : ''}`;
    const response = await axios.get(url);
    return response.data;
  }

  async getTickers(category: 'linear' | 'inverse' | 'option' | 'spot' = 'linear', symbol?: string) {
    const queryString = this.buildQueryString({ category, symbol });
    const url = `${BYBIT_REST_URL}/v5/market/tickers${queryString ? `?${queryString}` : ''}`;
    const response = await axios.get(url);
    return response.data;
  }

  async createTestOrder(
    symbol: string,
    side: 'Buy' | 'Sell',
    qty: number
  ) {
    const body = {
      category: 'linear', //spot, linear, inverse, option
      symbol,
      side,
      orderType: 'Market', //рыночная или лимитированая
      qty: qty.toString(),
      timeInForce: 'IOC'
    };

    return this.signedPost('/v5/order/create', body);
  }
}