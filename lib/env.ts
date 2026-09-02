import { sql } from './db';

export type TradingEnv = 'paper' | 'live';

/**
 * Returns the current trading environment.
 *
 * Priority order:
 *   1. TRADING_MODE env var (set per-environment in Vercel: prod=live, UAT=paper)
 *   2. bot_config DB key 'trading_mode' (fallback for runtime toggle)
 *   3. Default: 'paper'
 *
 * This ensures prod and UAT deployments never share the same env
 * even when they point to the same database.
 */
export async function getCurrentEnv(): Promise<TradingEnv> {
  // 1. Check process env var first — set this in Vercel per deployment
  const envVar = process.env.TRADING_MODE;
  if (envVar === 'live' || envVar === 'paper') {
    return envVar;
  }

  // 2. Fall back to DB config (runtime toggle from dashboard)
  try {
    const result = (await sql`
      SELECT value FROM bot_config WHERE key = 'trading_mode'
    `) as Array<{ value: string }>;
    return (result[0]?.value ?? 'paper') as TradingEnv;
  } catch {
    return 'paper';
  }
}
