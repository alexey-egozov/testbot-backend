import fs from 'fs';
import path from 'path';

export type StrategyConfigSnapshot = {
  rsiOversold: number;
  rsiOverbought: number;
  minSpreadTicks: number;
  minBidDepth: number;
  minAskDepth: number;
};

const CONFIG_PATH = path.join(__dirname, '..', 'strategy-config.json');

export function loadStrategyConfig(): StrategyConfigSnapshot | null {
  try {
    const exists = fs.existsSync(CONFIG_PATH);
    if (!exists) {
      return null;
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (
      typeof data.rsiOversold === 'number' &&
      typeof data.rsiOverbought === 'number' &&
      typeof data.minSpreadTicks === 'number' &&
      typeof data.minBidDepth === 'number' &&
      typeof data.minAskDepth === 'number'
    ) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveStrategyConfig(snapshot: StrategyConfigSnapshot) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(snapshot, null, 2));
}
