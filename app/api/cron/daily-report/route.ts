import { NextResponse } from 'next/server';
import { sqlForContext, DbContext } from '@/lib/db';
import { getMarketData, getFearGreedIndex } from '@/lib/market-data';
import { getPortfolioSummary } from '@/lib/portfolio';
import { sendDailyReport } from '@/lib/telegram';
import { BotDecision } from '@/lib/types';
import { cronUnauthorized } from '@/lib/cron-auth';
import { WATCHLIST_COINS } from '@/lib/market-data';

export const maxDuration = 30;

type Row = Record<string, unknown>;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const secret = process.env.CRON_SECRET;
  const authorizedByQuery = Boolean(secret) && url.searchParams.get('secret') === secret;
  const unauthorized = authorizedByQuery ? null : cronUnauthorized(request);
  if (unauthorized) return unauthorized;

  // Contexte DB : ?ctx=prod (ou ?db=) > header x-db-context > APP_ENV, défaut UAT
  const queryCtx = url.searchParams.get('ctx') ?? url.searchParams.get('db');
  const headerCtx = request.headers.get('x-db-context');
  const dbContext: DbContext = (queryCtx === 'prod' || queryCtx === 'uat')
    ? queryCtx
    : (headerCtx === 'prod' || headerCtx === 'uat')
      ? headerCtx
      : process.env.APP_ENV === 'production' ? 'prod' : 'uat';
  const db = sqlForContext(dbContext);

  try {
    const modeRows = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
    const isLive = modeRows[0]?.value === 'live';
    const env = isLive ? 'live' : 'paper';

    const [marketData, fearGreedRaw] = await Promise.all([
      getMarketData(WATCHLIST_COINS),
      getFearGreedIndex(),
    ]);
    const fearGreed = fearGreedRaw as { value: number; label: string };

    const portfolio = await getPortfolioSummary(marketData, env, dbContext);

    // Get today's actual trades WITH amounts (from trades table, not bot_decisions)
    const todayTrades = (await db`
      SELECT
        t.symbol,
        t.action,
        t.total_eur,
        t.price_eur,
        t.confidence,
        t.reasoning,
        t.executed_at
      FROM trades t
      WHERE t.executed_at > NOW() - INTERVAL '24 hours'
      AND t.action IN ('BUY', 'SELL')
      ORDER BY t.executed_at DESC
      LIMIT 10
    `) as Row[];

    const decisions: BotDecision[] = todayTrades.map((t) => ({
      symbol: String(t.symbol ?? ''),
      action: String(t.action ?? 'BUY') as 'BUY' | 'SELL',
      amount_eur: parseFloat(String(t.total_eur ?? 0)),
      reasoning: String(t.reasoning ?? ''),
      confidence: Number(t.confidence ?? 0),
      risk_score: 0,
      timeframe: '',
    }));

    const tradesCount = todayTrades.length;

    const marketSentiment =
      fearGreed.value < 25
        ? '🔴 Marché en peur extrême — prudence maximale'
        : fearGreed.value < 45
        ? '🟠 Marché craintif — opportunités pour les acheteurs patients'
        : fearGreed.value < 55
        ? '🟡 Marché neutre — attente de signal clair'
        : fearGreed.value < 75
        ? '🟢 Marché euphorique modéré — prendre des profits progressifs'
        : '⚠️ Marché en euphorie extrême — risque de correction élevé';

    await sendDailyReport(
      portfolio,
      decisions,
      tradesCount,
      fearGreed,
      marketSentiment,
      isLive,
      dbContext
    );

    return NextResponse.json({
      success: true,
      portfolio_value_eur: portfolio.total_value_eur,
      trades_today: tradesCount,
      ctx: dbContext,
      env,
    });
  } catch (error) {
    console.error('Daily report error:', error);
    return NextResponse.json(
      { error: 'Report failed', details: String(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
