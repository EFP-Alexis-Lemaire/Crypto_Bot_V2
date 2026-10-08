import { NextResponse } from 'next/server';
import { sqlForContext, DbContext } from '@/lib/db';
import {
  getMarketData,
  getCoinHistory,
  calculateVolatilityPct,
  WATCHLIST_COINS,
  SYMBOL_TO_COINGECKO_ID,
} from '@/lib/market-data';
import {
  getPortfolioSummary,
  checkStopLossAndTakeProfit,
  savePortfolioSnapshot,
  executePaperTrade,
} from '@/lib/portfolio';
import { executeLiveTrade } from '@/lib/exchanges/live-trader';
import { sendTradeAlert } from '@/lib/telegram';
import { cronUnauthorized } from '@/lib/cron-auth';
import { acquireCycleLock, releaseCycleLock } from '@/lib/cycle-lock';
import { BotDecision, TechnicalIndicators } from '@/lib/types';

export const maxDuration = 60;

// Guardian : vérifie stops / TP / trailing SANS analyse IA (0 coût OpenAI).
// À pointer depuis cron-job.org toutes les 30-60 min : entre deux cycles complets,
// il vend les stops touchés au lieu de laisser filer. Les cycles complets
// restent responsables de la stratégie d'achat.
// Ex: /api/cron/guard?ctx=prod + Bearer CRON_SECRET (ou ?secret=).
export async function GET(request: Request) {
  const url = new URL(request.url);
  const secret = process.env.CRON_SECRET;
  const authorizedByQuery = Boolean(secret) && url.searchParams.get('secret') === secret;
  const unauthorized = authorizedByQuery ? null : cronUnauthorized(request);
  if (unauthorized) return unauthorized;

  const queryCtx = url.searchParams.get('ctx') ?? url.searchParams.get('db');
  const headerCtx = request.headers.get('x-db-context');
  const dbContext: DbContext = (queryCtx === 'prod' || queryCtx === 'uat')
    ? queryCtx
    : (headerCtx === 'prod' || headerCtx === 'uat')
      ? headerCtx
      : process.env.APP_ENV === 'production' ? 'prod' : 'uat';
  const db = sqlForContext(dbContext);
  const cycleId = `guard-${Date.now()}`;

  // Respecte le verrou : si un cycle complet tourne, on ne double pas les ventes
  if (!(await acquireCycleLock(db, cycleId))) {
    return NextResponse.json({ message: 'Cycle en cours — guardian ignoré', skipped: true, ctx: dbContext });
  }

  try {
    const modeRows = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
    const isLive = modeRows[0]?.value === 'live';
    const env = isLive ? 'live' : 'paper';

    const activeRows = (await db`SELECT value FROM bot_config WHERE key = 'is_active'`) as Array<{ value: string }>;
    if ((activeRows[0]?.value ?? 'true') === 'false') {
      await releaseCycleLock(db);
      return NextResponse.json({ message: 'Bot en pause', ctx: dbContext });
    }

    const marketData = await getMarketData(WATCHLIST_COINS);
    const eurUsdRate = 1.08; // fixe approx : le guardian n'a pas besoin du taux exact
    const portfolio = await getPortfolioSummary(marketData, env, dbContext);

    // Volatilité sur les positions significatives uniquement (quelques appels)
    const significant = portfolio.holdings.filter(h => h.current_value_eur >= 5).slice(0, 10);
    const technicalIndicators: TechnicalIndicators[] = [];
    await Promise.all(
      significant.map(async h => {
        try {
          const coinId = SYMBOL_TO_COINGECKO_ID[h.symbol] ?? h.symbol.toLowerCase();
          const history = await getCoinHistory(coinId, 60);
          const prices = history.map(p => p.price);
          if (prices.length >= 26) {
            technicalIndicators.push({
              symbol: h.symbol,
              rsi_14: null, macd: null, macd_signal: null, macd_histogram: null,
              sma_20: null, sma_50: null, ema_12: null, ema_26: null,
              bb_upper: null, bb_middle: null, bb_lower: null, trend: 'neutral',
              volatility_pct: calculateVolatilityPct(prices),
              volume_zscore: null, bb_width_pct: null, bb_squeeze: false,
              roc_30d: null, macd_hist_slope: null,
            });
          }
        } catch { /* position sans vol = stop config */ }
      })
    );
    const volMap: Record<string, number> = {};
    for (const t of technicalIndicators) {
      if (t.volatility_pct !== null && t.volatility_pct !== undefined && t.volatility_pct > 0) {
        volMap[t.symbol] = t.volatility_pct;
      }
    }

    const actions = await checkStopLossAndTakeProfit(marketData, env, dbContext, volMap);

    let sold = 0;
    const results: Array<{ symbol: string; ok: boolean; message: string }> = [];
    for (const action of actions) {
      const marketCoin = marketData.find(m => m.symbol === action.symbol);
      if (!marketCoin) continue;
      const positionValue = portfolio.holdings.find(h => h.symbol === action.symbol)?.current_value_eur ?? 0;
      const sellAmount = positionValue * (action.ratio ?? 1);
      if (sellAmount < 5) continue;
      const slDecision: BotDecision = {
        symbol: action.symbol,
        action: 'SELL',
        amount_eur: sellAmount,
        reasoning: `[Guardian] ${action.reason}`,
        confidence: 95,
        risk_score: 10,
        timeframe: 'Immédiat',
        partial: (action.ratio ?? 1) < 1,
      };
      const result = isLive
        ? await executeLiveTrade(slDecision, marketCoin, eurUsdRate)
        : await executePaperTrade(slDecision, marketCoin, eurUsdRate, env, dbContext);
      if (result.success) sold++;
      results.push({ symbol: action.symbol, ok: result.success, message: result.message });
      await sendTradeAlert(slDecision, result.success, marketCoin.price_eur, result.message, isLive, dbContext);
    }

    // Snapshot pour garder le graphique à jour après les ventes
    const updated = await getPortfolioSummary(marketData, env, dbContext);
    await savePortfolioSnapshot(updated, env, dbContext);

    await releaseCycleLock(db);
    return NextResponse.json({
      cycle_id: cycleId, ctx: dbContext, env,
      checked: significant.length,
      stop_loss_triggered: actions.length,
      sold,
      results,
      portfolio_value_eur: updated.total_value_eur,
    });
  } catch (error) {
    console.error(`[Guard ${cycleId}] Error:`, error);
    await releaseCycleLock(db);
    return NextResponse.json({ error: 'Guard failed', details: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
