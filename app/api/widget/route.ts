import { NextResponse } from 'next/server';
import { sqlForContext } from '@/lib/db';
import { getMarketData, WATCHLIST_COINS } from '@/lib/market-data';
import { getPortfolioSummary } from '@/lib/portfolio';

// Endpoint minimal pour widget iPhone (Scriptable) : P&L totale PROD uniquement.
// Protégé par ?token=<WIDGET_TOKEN> (variable d'env Vercel). Ne expose ni les
// positions détaillées ni les clés. Sans token configuré : 500 (fail-closed).
export async function GET(request: Request) {
  const expected = process.env.WIDGET_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: 'WIDGET_TOKEN non configuré' }, { status: 500 });
  }
  const given = new URL(request.url).searchParams.get('token');
  if (given !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const db = sqlForContext('prod');
    const modeRows = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
    const env = modeRows[0]?.value === 'live' ? 'live' : 'paper';

    const marketData = await getMarketData(WATCHLIST_COINS);
    const portfolio = await getPortfolioSummary(marketData, env, 'prod');

    return NextResponse.json({
      total_value_eur: Number(portfolio.total_value_eur.toFixed(2)),
      pnl_eur: Number(portfolio.pnl_eur.toFixed(2)),
      pnl_percent: Number(portfolio.pnl_percent.toFixed(2)),
      env,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Widget failed', details: String(error) }, { status: 500 });
  }
}
