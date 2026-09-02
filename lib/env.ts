import { sql } from './db';

export type TradingEnv = 'paper' | 'live';

/**
 * Returns the current trading environment from DB config.
 * All queries should filter by this value to keep paper/live data separate.
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
