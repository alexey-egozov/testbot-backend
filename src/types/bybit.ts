export interface BybitTickerData {
  symbol: string;
  lastPrice: string;
  highPrice24h: string;
  lowPrice24h: string;
  prevPrice24h: string;
  price24hPcnt: string;
  turnover24h: string;
  volume24h: string;
}

export interface BybitWSMessage {
  topic?: string;
  type?: string;
  ts?: number;
  data?: BybitTickerData;
}
