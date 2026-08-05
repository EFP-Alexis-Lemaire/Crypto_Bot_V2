import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { getMarketData, getFearGreedIndex } from '@/lib/market-data';
import { getPortfolioSummary } from '@/lib/portfolio';
import { sendDailyReport } from '@/lib/telegram';
import { BotDecision } from '@/lib/types';
import { WATCHLIST_COINS } from '@/lib/market-data';

export const maxDuration = 30;

type Row = Record<string, unknown>;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [marketData, fearGreedRaw] = await Promise.all([
      getMarketData(WATCHLIST_COINS),
      getFearGreedIndex(),
    ]);
    const fearGreed = fearGreedRaw as { value: number; label: string };

    const portfolio = await getPortfolioSummary(marketData);

    // Get today's actual trades WITH amounts (from trades table, not bot_decisions)
    const todayTrades = (await sql`
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
      marketSentiment
    );

    return NextResponse.json({
      success: true,
      portfolio_value_eur: portfolio.total_value_eur,
      trades_today: tradesCount,
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
