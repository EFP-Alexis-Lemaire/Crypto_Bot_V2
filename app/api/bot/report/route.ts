import { NextResponse } from 'next/server';
import { sqlForContext, getDbContext } from '@/lib/db';
import { getMarketData, getFearGreedIndex } from '@/lib/market-data';
import { getPortfolioSummary } from '@/lib/portfolio';
import { sendDailyReport } from '@/lib/telegram';
import { BotDecision } from '@/lib/types';
import { WATCHLIST_COINS } from '@/lib/market-data';

export const maxDuration = 30;

type Row = Record<string, unknown>;

// Dashboard manual trigger — no CRON_SECRET required.
// Suit le contexte de la vue (header x-db-context : UAT/PROD).
export async function POST(request: Request) {
  try {
    const ctx = getDbContext(request);
    const db = sqlForContext(ctx);

    const modeRows = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
    const isLive = modeRows[0]?.value === 'live';
    const env = isLive ? 'live' : 'paper';

    const [marketData, fearGreed] = await Promise.all([
      getMarketData(WATCHLIST_COINS),
      getFearGreedIndex(),
    ]);
    const fg = fearGreed as { value: number; label: string };

    const portfolio = await getPortfolioSummary(marketData, env, ctx);

    // Get today's actual trades WITH amounts (filtrés sur l'env courant)
    const todayTrades = (await db`
      SELECT symbol, action, total_eur, price_eur, confidence, reasoning, executed_at
      FROM trades
      WHERE executed_at > NOW() - INTERVAL '24 hours'
      AND action IN ('BUY', 'SELL')
      AND env = ${env}
      ORDER BY executed_at DESC
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

    const marketSentiment =
      fg.value < 25 ? '🔴 Marché en peur extrême — prudence maximale' :
      fg.value < 45 ? '🟠 Marché craintif — opportunités pour les acheteurs patients' :
      fg.value < 55 ? '🟡 Marché neutre — attente de signal clair' :
      fg.value < 75 ? '🟢 Marché euphorique modéré — prendre des profits progressifs' :
      '⚠️ Marché en euphorie extrême — risque de correction élevé';

    await sendDailyReport(portfolio, decisions, todayTrades.length, fg, marketSentiment, isLive, ctx);

    return NextResponse.json({ success: true, trades_today: todayTrades.length, ctx, env });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
