import 'dotenv/config';

// export const BYBIT_WS_URL = 'wss://stream-testnet.bybit.com/v5/public/spot';
// export const BYBIT_REST_URL = 'https://api-demo.bybit.com';
// export const BYBIT_REST_URL = 'https://api-testnet.bybit.com';

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (!value && !defaultValue) {
    throw new Error(`Environment variable ${name} is not set`);
  }
  // Get raw value and trim
  let result = (value || defaultValue || '').trim();
  console.log(`[DEBUG] ${name} raw value:`, JSON.stringify(result));
  
  // Remove quotes, semicolons, and whitespace from start and end
  // Keep removing until no more quotes/semicolons at edges
  let previousResult = '';
  while (result !== previousResult) {
    previousResult = result;
    // Remove from start
    while (result.length > 0 && (result[0] === '"' || result[0] === "'" || result[0] === ';' || result[0] === ' ')) {
      result = result.slice(1);
    }
    // Remove from end
    while (result.length > 0 && (result[result.length - 1] === '"' || result[result.length - 1] === "'" || result[result.length - 1] === ';' || result[result.length - 1] === ' ')) {
      result = result.slice(0, -1);
    }
    result = result.trim();
  }
  
  if (!result) {
    throw new Error(`Environment variable ${name} is empty`);
  }
  console.log(`[DEBUG] ${name} cleaned value:`, JSON.stringify(result));
  return result;
}

export const BYBIT_WS_URL: string = getEnvVar('BYBIT_WS_URL', 'wss://stream-testnet.bybit.com/v5/public/spot');
export const BYBIT_REST_URL: string = getEnvVar('BYBIT_REST_URL', 'https://api-testnet.bybit.com');

export const API_KEY: string = getEnvVar('API_KEY');
export const API_SECRET: string = getEnvVar('API_SECRET');