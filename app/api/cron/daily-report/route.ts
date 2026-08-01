import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { getMarketData, getFearGreedIndex } from '@/lib/market-data';
import { getPortfolioSummary } from '@/lib/portfolio';
import { sendDailyReport } from '@/lib/telegram';
import { BotDecision } from '@/lib/types';
import { WATCHLIST_COINS } from '@/lib/market-data';

export const maxDuration = 30;

type Row = Record<string, unknown>;

function strVal(row: Row | undefined, field: string): string {
  return String(row?.[field] ?? '0');
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [marketData, fearGreed] = await Promise.all([
      getMarketData(WATCHLIST_COINS),
      getFearGreedIndex(),
    ]);

    const portfolio = await getPortfolioSummary(marketData);

    // Get today's decisions
    const todayDecisions = (await sql`
      SELECT * FROM bot_decisions
      WHERE decided_at > NOW() - INTERVAL '24 hours'
      AND action IN ('BUY', 'SELL')
      ORDER BY decided_at DESC
    `) as Row[];

    const decisions: BotDecision[] = todayDecisions.map((d) => ({
      symbol: String(d.symbol ?? ''),
      action: String(d.action ?? 'HOLD') as 'BUY' | 'SELL',
      amount_eur: 0,
      reasoning: String(d.reasoning ?? ''),
      confidence: Number(d.confidence ?? 0),
      risk_score: Number(d.risk_score ?? 0),
      timeframe: '',
    }));

    // Count actual trades
    const tradeCountResult = (await sql`
      SELECT COUNT(*) as count FROM trades
      WHERE executed_at > NOW() - INTERVAL '24 hours'
      AND action IN ('BUY', 'SELL')
    `) as Row[];

    const tradesCount = parseInt(strVal(tradeCountResult[0], 'count'));

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
