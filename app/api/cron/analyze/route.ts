import { NextResponse } from 'next/server';
import { sqlForContext } from '@/lib/db';
import {
  getMarketData,
  getCryptoNews,
  getFearGreedIndex,
  getEurUsdRate,
  getTrendingCoins,
  getCoinHistory,
  calculateTechnicalIndicators,
  getDefiTVL,
  WATCHLIST_COINS,
  SYMBOL_TO_COINGECKO_ID,
} from '@/lib/market-data';
import { analyzeMarketWithAI } from '@/lib/ai-engine';
import {
  getPortfolioSummary,
  executePaperTrade,
  savePortfolioSnapshot,
  checkStopLossAndTakeProfit,
} from '@/lib/portfolio';
import { executeLiveTrade, syncPortfolioFromExchange } from '@/lib/exchanges/live-trader';
import { sendTradeAlert } from '@/lib/telegram';
import { TechnicalIndicators, BotDecision } from '@/lib/types';
import { v4 as uuidv4 } from 'uuid';

export const maxDuration = 60; // 60 seconds for Vercel

// Helper to safely extract first row value from neon result
function firstVal(result: unknown, field: string): string | undefined {
  const arr = result as Array<Record<string, unknown>>;
  return arr?.[0]?.[field] as string | undefined;
}

export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const cycleId = uuidv4();
  // Use PROD DB when APP_ENV=production, UAT otherwise
  const dbContext = process.env.APP_ENV === 'production' ? 'prod' : 'uat';
  const db = sqlForContext(dbContext);
  console.log(`[Bot Cycle ${cycleId}] Starting analysis on ${dbContext} DB...`);

  try {
    // Check if bot is active
    const configResult = await db`
      SELECT value FROM bot_config WHERE key = 'is_active'
    `;
    if (firstVal(configResult, 'value') === 'false') {
      return NextResponse.json({ message: 'Bot is paused' });
    }

    // Get risk level
    const riskResult = await db`
      SELECT value FROM bot_config WHERE key = 'risk_level'
    `;
    const riskLevel = (firstVal(riskResult, 'value') ?? 'moderate') as 'conservative' | 'moderate' | 'aggressive';

    // Get trading mode early (needed for trade count filter and execution)
    const modeResult = await db`
      SELECT value FROM bot_config WHERE key = 'trading_mode'
    `;
    const isLive = firstVal(modeResult, 'value') === 'live';
    const currentEnv = isLive ? 'live' : 'paper';

    // Count trades today — filtered by current env to avoid cross-contamination
    const tradesTodayResult = await db`
      SELECT COUNT(*) as count FROM trades 
      WHERE executed_at > NOW() - INTERVAL '24 hours'
      AND action IN ('BUY', 'SELL')
      AND env = ${currentEnv}
    `;
    const tradesExecutedToday = parseInt(firstVal(tradesTodayResult, 'count') ?? '0');

    const maxTradesResult = await db`
      SELECT value FROM bot_config WHERE key = 'max_trades_per_day'
    `;
    const maxTrades = parseInt(firstVal(maxTradesResult, 'value') ?? '5');

    if (tradesExecutedToday >= maxTrades) {
      console.log(`[Bot Cycle ${cycleId}] Max trades reached (${tradesExecutedToday}/${maxTrades})`);
      return NextResponse.json({
        message: `Max daily trades reached: ${tradesExecutedToday}/${maxTrades}`,
      });
    }

    // Fetch all data in parallel
    console.log(`[Bot Cycle ${cycleId}] Fetching market data...`);
    const [
      marketData,
      news,
      fearGreed,
      eurUsdRate,
      trendingCoins,
      defiTVL,
    ] = await Promise.all([
      getMarketData(WATCHLIST_COINS),
      getCryptoNews(),
      getFearGreedIndex() as Promise<{ value: number; label: string }>,
      getEurUsdRate(),
      getTrendingCoins(),
      getDefiTVL(),
    ]);

    // Add trending coins to market data if not already there
    const additionalCoins = trendingCoins.filter(
      id => !WATCHLIST_COINS.includes(id)
    );
    let allMarketData = [...marketData];
    if (additionalCoins.length > 0) {
      const trendingData = await getMarketData(additionalCoins);
      allMarketData = [...marketData, ...trendingData];
    }

    // Calculate technical indicators for top coins
    console.log(`[Bot Cycle ${cycleId}] Calculating technical indicators...`);
    const technicalIndicators: TechnicalIndicators[] = [];
    const topCoins = allMarketData.slice(0, 15);

    await Promise.all(
      topCoins.map(async coin => {
        const coinId = SYMBOL_TO_COINGECKO_ID[coin.symbol] ??
          coin.symbol.toLowerCase();
        const history = await getCoinHistory(coinId, 60);
        const prices = history.map(h => h.price);

        if (prices.length >= 26) {
          const indicators = calculateTechnicalIndicators(prices);
          technicalIndicators.push({ symbol: coin.symbol, ...indicators });
        }
      })
    );

    // Get current portfolio
    const portfolio = await getPortfolioSummary(allMarketData, undefined, dbContext);

    // Check stop-loss / take-profit first
    console.log(`[Bot Cycle ${cycleId}] Checking stop-loss/take-profit...`);
    const stopLossActions = await checkStopLossAndTakeProfit(allMarketData, undefined, dbContext);

    // Sync from exchange if live mode
    if (isLive) {
      await syncPortfolioFromExchange('both');
    }

    // Track recently sold symbols to prevent immediate rebuy
    const recentlySoldResult = (await db`
      SELECT DISTINCT symbol FROM trades
      WHERE action = 'SELL'
      AND executed_at > NOW() - INTERVAL '4 hours'
      AND env = ${currentEnv}
    `) as Array<{ symbol: string }>;
    const recentlySold = new Set(recentlySoldResult.map(r => r.symbol));
    
    for (const slAction of stopLossActions) {
      const marketCoin = allMarketData.find(m => m.symbol === slAction.symbol);
      if (!marketCoin) continue;

      const slDecision: BotDecision = {
        symbol: slAction.symbol,
        action: 'SELL',
        amount_eur:
          (portfolio.holdings.find(h => h.symbol === slAction.symbol)
            ?.current_value_eur ?? 0),
        reasoning: slAction.reason,
        confidence: 95,
        risk_score: 10,
        timeframe: 'Immédiat',
      };

      const result = isLive
        ? await executeLiveTrade(slDecision, marketCoin, eurUsdRate)
        : await executePaperTrade(slDecision, marketCoin, eurUsdRate, undefined, dbContext);
      await sendTradeAlert(slDecision, result.success, marketCoin.price_eur, result.message, isLive);
      // Log decision
      await db`
        INSERT INTO bot_decisions 
          (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, market_data, technical_indicators)
        VALUES (
          ${cycleId}, ${slAction.symbol}, 'SELL',
          ${slAction.reason}, 95, 10, 'stop-loss-trigger',
          ${JSON.stringify({ price: marketCoin.price_eur })},
          ${JSON.stringify({})}
        )
      `;
    }

    // AI Analysis
    console.log(`[Bot Cycle ${cycleId}] Running AI analysis...`);
    const decisions = await analyzeMarketWithAI({
      marketData: allMarketData,
      technicalIndicators,
      news,
      fearGreedIndex: fearGreed,
      defiTVL,
      currentPortfolio: {
        cash_eur: portfolio.cash_eur,
        total_value_eur: portfolio.total_value_eur,
        holdings: portfolio.holdings.map(h => ({
          symbol: h.symbol,
          amount: h.amount,
          current_value_eur: h.current_value_eur,
          pnl_percent: h.pnl_percent,
        })),
      },
      riskLevel,
      tradesExecutedToday: tradesExecutedToday + stopLossActions.length,
      eurUsdRate,
    });

    // Always log the cycle, even if no decisions
    if (decisions.length === 0) {
      await db`
        INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used)
        VALUES (
          ${cycleId}, NULL, 'SKIP',
          ${`Aucune opportunité identifiée. Fear & Greed: ${fearGreed.value}/100 (${fearGreed.label}). Aucun setup ne justifie les frais (~0.52% aller-retour). Portefeuille: ${portfolio.total_value_eur.toFixed(2)}€.`},
          0, 0, 'gpt-4o'
        )
      `;
    }

    // Execute decisions
    const executedTrades: { decision: BotDecision; result: { success: boolean; message: string } }[] = [];

    for (const decision of decisions) {
      // Block immediate rebuy of recently sold symbols
      if (decision.action === 'BUY' && recentlySold.has(decision.symbol)) {
        console.log(`[Bot Cycle ${cycleId}] Skipping BUY ${decision.symbol} — sold within last 4h`);
        await db`
          INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used)
          VALUES (${cycleId}, ${decision.symbol}, 'SKIP',
            ${'Rachat bloqué: ' + decision.symbol + ' a été vendu dans les 4 dernières heures. Délai de cooldown respecté.'},
            0, 0, 'cooldown-rule')
        `;
        continue;
      }
      if (decision.action === 'HOLD' || decision.action === 'SKIP') {
        // Log but don't execute
        await db`
          INSERT INTO bot_decisions 
            (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used)
          VALUES (
            ${cycleId}, ${decision.symbol}, ${decision.action},
            ${decision.reasoning}, ${decision.confidence}, ${decision.risk_score},
            'gpt-4o'
          )
        `;
        continue;
      }

      const marketCoin = allMarketData.find(m => m.symbol === decision.symbol);
      if (!marketCoin) continue;

      const result = isLive
        ? await executeLiveTrade(decision, marketCoin, eurUsdRate)
        : await executePaperTrade(decision, marketCoin, eurUsdRate, undefined, dbContext);
      executedTrades.push({ decision, result });

      // Log decision with full market data
      const techIndicator = technicalIndicators.find(
        t => t.symbol === decision.symbol
      );
      const relevantNews = news
        .filter(
          n => !n.currencies || n.currencies.includes(decision.symbol)
        )
        .slice(0, 3);

      await db`
        INSERT INTO bot_decisions 
          (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, market_data, technical_indicators, news_summary)
        VALUES (
          ${cycleId}, ${decision.symbol}, ${decision.action},
          ${decision.reasoning}, ${decision.confidence}, ${decision.risk_score},
          'gpt-4o',
          ${JSON.stringify({
            price_eur: marketCoin.price_eur,
            change_24h: marketCoin.change_24h,
            volume: marketCoin.volume_24h_usd,
            fear_greed: fearGreed.value,
          })},
          ${JSON.stringify(techIndicator ?? {})},
          ${relevantNews.map(n => n.title).join(' | ')}
        )
      `;

      await sendTradeAlert(decision, result.success, marketCoin.price_eur, result.message, isLive);
    await savePortfolioSnapshot(updatedPortfolio, undefined, dbContext);

    console.log(
      `[Bot Cycle ${cycleId}] Done. ${executedTrades.length} trades executed.`
    );

    return NextResponse.json({
      cycle_id: cycleId,
      trades_executed: executedTrades.length,
      stop_loss_triggered: stopLossActions.length,
      portfolio_value_eur: updatedPortfolio.total_value_eur,
      decisions: decisions.map(d => ({
        symbol: d.symbol,
        action: d.action,
        confidence: d.confidence,
      })),
    });
  } catch (error) {
    console.error(`[Bot Cycle ${cycleId}] Error:`, error);
    return NextResponse.json(
      { error: 'Analysis failed', details: String(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}

