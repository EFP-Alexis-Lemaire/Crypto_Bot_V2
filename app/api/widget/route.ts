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
    const url = new URL(request.url);
    // ?top=N : ajoute les N meilleures positions (triées par P&L %, max 5)
    const topN = Math.min(Math.max(parseInt(url.searchParams.get('top') ?? '0') || 0, 0), 5);

    const db = sqlForContext('prod');
    const modeRows = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
    const env = modeRows[0]?.value === 'live' ? 'live' : 'paper';

    const marketData = await getMarketData(WATCHLIST_COINS);
    const portfolio = await getPortfolioSummary(marketData, env, 'prod');

    const topPerformers = topN > 0
      ? portfolio.holdings
          .filter(h => h.current_value_eur >= 1)
          .map(h => ({
            symbol: h.symbol,
            value_eur: Number(h.current_value_eur.toFixed(2)),
            pnl_eur: Number(h.pnl_eur.toFixed(2)),
            pnl_percent: Number(h.pnl_percent.toFixed(2)),
          }))
          .sort((a, b) => b.pnl_percent - a.pnl_percent)
          .slice(0, topN)
      : undefined;

    return NextResponse.json({
      total_value_eur: Number(portfolio.total_value_eur.toFixed(2)),
      pnl_eur: Number(portfolio.pnl_eur.toFixed(2)),
      pnl_percent: Number(portfolio.pnl_percent.toFixed(2)),
      env,
      ...(topPerformers ? { top_performers: topPerformers } : {}),
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Widget failed', details: String(error) }, { status: 500 });
  }
}
