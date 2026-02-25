export type PositionSnapshot = {
  symbol: string;
  side: 'Buy' | 'Sell';
  size: number;
  entryPrice: number;
  unrealisedPnl: number;
  leverage: number;
};

export class PositionState {
  private positions = new Map<string, PositionSnapshot>();
  private lastSyncAt = 0;

  reconcile(rawPositions: any[]) {
    this.positions.clear();
    for (const item of rawPositions) {
      const size = Number(item.size);
      if (!Number.isFinite(size) || size <= 0) {
        continue;
      }
      const symbol = item.symbol;
      this.positions.set(symbol, {
        symbol,
        side: item.side,
        size,
        entryPrice: Number(item.avgPrice ?? 0),
        unrealisedPnl: Number(item.unrealisedPnl ?? 0),
        leverage: Number(item.leverage ?? 0)
      });
    }
    this.lastSyncAt = Date.now();
  }

  getOpenPosition(symbol: string): PositionSnapshot | null {
    return this.positions.get(symbol) ?? null;
  }

  getLastSyncAt() {
    return this.lastSyncAt;
  }
}
