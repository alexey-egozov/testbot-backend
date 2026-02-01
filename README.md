## Run

```
npx ts-node .\src\index.ts
```

## Test Plan (Backtest + Paper Trading)

### Scope and goals
- Instruments: top-liquid linear USDT-perp pairs (e.g., BTCUSDT, ETHUSDT, SOLUSDT).
- Focus: scalping with minimal risk using 1-2x leverage.
- Must include: strict risk management, liquidity and spread filters.

### Current integration touchpoints (for testing)
- Market data (live ticker via WS): `src/tradeEngine.ts` (subscribes to `tickers.BTCUSDT`).
- Order placement (Bybit REST demo): `src/orderManager.ts` (`/v5/order/create`, `category: linear`).
- API endpoints: `src/index.ts` (`/api/price`, `/api/order`).

### Backtest plan
1) **Data source**
   - Bybit tick/execution data (preferred) for top-liquid USDT-perp pairs.
   - Periods: at least 2-3 months, with a separate out-of-sample window.

2) **Instrument selection**
   - Rank by volume, depth, and stable tight spreads.
   - Exclude pairs with thin order book or frequent spread spikes.

3) **Cost model**
   - Include taker/maker fees from Bybit for linear contracts.
   - Model slippage based on tick size and recent spread:
     - Base slippage = half-spread * trade size factor.
     - Stress test with 2x-3x base slippage.

4) **Risk management rules**
   - Leverage: 1-2x only.
   - Risk per trade: 0.1%-0.3% of equity.
   - Daily max loss: 1%-2% of equity (stop trading for the day).
   - Max trades per session: cap to avoid overtrading.
   - Stop-loss: ATR-based or fixed ticks; take-profit set by RR >= 1.2.

5) **Liquidity and spread filters**
   - Min 1-minute volume threshold.
   - Max spread threshold (e.g., <= 0.5-1.0 tick sizes).
   - Skip trades if order book depth at top levels is insufficient.

6) **Pair-specific thresholds (very low risk, initial defaults)**
   - These are conservative starting values to be calibrated in backtest.
   - Spread = max allowed bid/ask spread in ticks.
   - 1m Volume = minimum 1-minute notional volume in USDT.
   - Risk per trade = fixed risk fraction of equity (leverage 1-2x).
   - Daily max loss = stop trading for the day when reached.

| Pair    | Max spread (ticks) | Min 1m volume (USDT) | Risk per trade | Daily max loss |
|---------|---------------------|-----------------------|----------------|----------------|
| BTCUSDT | 1                   | 1,000,000             | 0.10%          | 1.0%           |
| ETHUSDT | 1                   | 600,000               | 0.10%          | 1.0%           |
| SOLUSDT | 2                   | 300,000               | 0.10%          | 1.0%           |
| XRPUSDT | 2                   | 200,000               | 0.10%          | 1.0%           |
| ADAUSDT | 3                   | 150,000               | 0.10%          | 1.0%           |

7) **Scenarios**
   - Base: normal volatility, stable spreads.
   - Stress: high volatility windows, news spikes.
   - Low liquidity: off-peak hours.

8) **Metrics**
   - Net profit, win rate, profit factor.
   - Max drawdown, average trade, exposure time.
   - Fee impact, slippage impact.
   - Trade duration and missed/filtered signal rate.

9) **Acceptance criteria (initial)**
   - Profit factor > 1.2 on out-of-sample.
   - Max drawdown <= 5% on out-of-sample.
   - Slippage + fees do not exceed 35%-40% of gross profit.

### Paper trading plan (Bybit demo)
1) **Environment**
   - Use demo API with the same instruments as backtest shortlist.
   - Use real-time WS data from `TradeEngine` and demo order placement.

2) **Checks**
   - Order lifecycle correctness: submit, fill, position updates.
   - Slippage and fees observed vs backtest assumptions.
   - Filters and risk limits block trades as expected.

3) **Operational safety**
   - If 3 consecutive errors from data/order endpoints, pause trading.
   - Cooldown after stop-loss hit to avoid revenge trading.

4) **Paper trading acceptance criteria**
   - Consistent adherence to risk limits (no violations).
   - Execution latency within target budget.
   - Results align with backtest within tolerance band (e.g., 20%-30% variance).