import { sql } from './db';

export type TradingEnv = 'paper' | 'live';

/**
 * Returns the current trading environment from DB config.
 * Each deployment (prod/UAT) has its own database, so this value
 * is independent per environment and toggleable from the dashboard.
 */
export async function getCurrentEnv(): Promise<TradingEnv> {
  try {
    const result = (await sql`
      SELECT value FROM bot_config WHERE key = 'trading_mode'
    `) as Array<{ value: string }>;
    return (result[0]?.value ?? 'paper') as TradingEnv;
  } catch {
    return 'paper';
  }
}
