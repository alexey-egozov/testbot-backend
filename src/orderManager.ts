import axios from 'axios';
import crypto from 'crypto';
import { API_KEY, API_SECRET, BYBIT_REST_URL } from './config';

export class OrderManager {
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

    const timestamp = Date.now().toString();
    const recvWindow = '5000';
    const bodyString = JSON.stringify(body);

    const signature = this.sign(timestamp, recvWindow, bodyString);

    const response = await axios.post(
      `${BYBIT_REST_URL}/v5/order/create`,
      bodyString,
      {
        headers: {
          'X-BAPI-API-KEY': API_KEY,
          'X-BAPI-SIGN': signature,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  }
}