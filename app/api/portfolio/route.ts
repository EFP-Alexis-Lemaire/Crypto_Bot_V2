import { NextResponse } from 'next/server';
import { sqlForContext, getDbContext } from '@/lib/db';
import { getMarketData } from '@/lib/market-data';
import { getPortfolioSummary } from '@/lib/portfolio';
import { WATCHLIST_COINS } from '@/lib/market-data';

export async function GET(request: Request) {
  try {
    const ctx = getDbContext(request);
    const db = sqlForContext(ctx);

    // Read trading_mode from the correct DB
    const configResult = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
    const env = (configResult[0]?.value ?? 'paper') as 'paper' | 'live';

    const marketData = await getMarketData(WATCHLIST_COINS);
    const portfolio = await getPortfolioSummary(marketData, env, ctx);

    const snapshots = await db`
      SELECT total_value_eur, cash_eur, crypto_value_eur, pnl_eur, pnl_percent, snapshotted_at
      FROM portfolio_snapshots
      WHERE snapshotted_at > NOW() - INTERVAL '30 days'
      AND env = ${env}
      ORDER BY snapshotted_at ASC
    `;

    return NextResponse.json({ portfolio, snapshots, env, ctx });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch portfolio', details: String(error) },
      { status: 500 }
    );
  }
}
