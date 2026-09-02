import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET() {
  try {
    const [portfolioAll, tradesCount, decisionsCount, config] = await Promise.all([
      sql`SELECT id, symbol, amount, env FROM portfolio ORDER BY env, symbol` as Promise<Array<{ id: number; symbol: string; amount: string; env: string }>>,
      sql`SELECT env, COUNT(*) as count FROM trades GROUP BY env` as Promise<Array<{ env: string; count: string }>>,
      sql`SELECT env, COUNT(*) as count FROM bot_decisions GROUP BY env` as Promise<Array<{ env: string; count: string }>>,
      sql`SELECT key, value FROM bot_config ORDER BY key` as Promise<Array<{ key: string; value: string }>>,
    ]);

    return NextResponse.json({
      portfolio_all_rows: portfolioAll,
      trades_by_env: tradesCount,
      decisions_by_env: decisionsCount,
      config: Object.fromEntries(config.map(c => [c.key, c.value])),
      vercel_env: process.env.VERCEL_ENV ?? '(not set)',
      db_used: (process.env.VERCEL_ENV ?? process.env.APP_ENV) === 'production' ? 'DATABASE_URL_PROD' : 'DATABASE_URL',
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
