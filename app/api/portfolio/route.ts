import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { getMarketData } from '@/lib/market-data';
import { getPortfolioSummary } from '@/lib/portfolio';
import { WATCHLIST_COINS } from '@/lib/market-data';

export async function GET() {
  try {
    const marketData = await getMarketData(WATCHLIST_COINS);
    const portfolio = await getPortfolioSummary(marketData);

    // Get snapshots for chart (last 30 days)
    const snapshots = await sql`
      SELECT 
        total_value_eur,
        cash_eur,
        crypto_value_eur,
        pnl_eur,
        pnl_percent,
        snapshotted_at
      FROM portfolio_snapshots
      WHERE snapshotted_at > NOW() - INTERVAL '30 days'
      ORDER BY snapshotted_at ASC
    `;

    return NextResponse.json({
      portfolio,
      snapshots,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch portfolio', details: String(error) },
      { status: 500 }
    );
  }
}
