import { sql, sqlForContext, DbContext } from './db';

export type TradingEnv = 'paper' | 'live';

export async function getCurrentEnv(ctx?: DbContext): Promise<TradingEnv> {
  try {
    const db = ctx ? sqlForContext(ctx) : sql;
    const result = (await db`
      SELECT value FROM bot_config WHERE key = 'trading_mode'
    `) as Array<{ value: string }>;
    return (result[0]?.value ?? 'paper') as TradingEnv;
  } catch {
    return 'paper';
  }
}
