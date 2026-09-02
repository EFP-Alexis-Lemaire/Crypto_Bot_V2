import { NextResponse } from 'next/server';
import { sqlForContext, getDbContext } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const ctx = getDbContext(request);
    const db = sqlForContext(ctx);

    const [portfolioAll, tradesCount, decisionsCount, config] = await Promise.all([
      db`SELECT id, symbol, amount, env FROM portfolio ORDER BY env, symbol` as Promise<Array<{ id: number; symbol: string; amount: string; env: string }>>,
      db`SELECT env, COUNT(*) as count FROM trades GROUP BY env` as Promise<Array<{ env: string; count: string }>>,
      db`SELECT env, COUNT(*) as count FROM bot_decisions GROUP BY env` as Promise<Array<{ env: string; count: string }>>,
      db`SELECT key, value FROM bot_config ORDER BY key` as Promise<Array<{ key: string; value: string }>>,
    ]);

    return NextResponse.json({
      ctx,
      portfolio_all_rows: portfolioAll,
      trades_by_env: tradesCount,
      decisions_by_env: decisionsCount,
      config: Object.fromEntries(config.map(c => [c.key, c.value])),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
