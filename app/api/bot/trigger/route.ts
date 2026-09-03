import { NextResponse } from 'next/server';
import { sqlForContext, getDbContext, DbContext } from '@/lib/db';
import {
  getMarketData, getCryptoNews, getFearGreedIndex, getEurUsdRate,
  getTrendingCoins, getCoinHistory, calculateTechnicalIndicators,
  getDefiTVL, WATCHLIST_COINS, SYMBOL_TO_COINGECKO_ID,
} from '@/lib/market-data';
import { analyzeMarketWithAI } from '@/lib/ai-engine';
import { getPortfolioSummary, executePaperTrade, savePortfolioSnapshot, checkStopLossAndTakeProfit } from '@/lib/portfolio';
import { executeLiveTrade, syncPortfolioFromExchange } from '@/lib/exchanges/live-trader';
import { sendTradeAlert } from '@/lib/telegram';
import { TechnicalIndicators, BotDecision } from '@/lib/types';
import { v4 as uuidv4 } from 'uuid';

export const maxDuration = 60;

export async function POST(request: Request) {
  const cycleId = uuidv4();
  const ctx: DbContext = getDbContext(request);
  const db = sqlForContext(ctx);

  try {
    const configResult = (await db`SELECT value FROM bot_config WHERE key = 'is_active'`) as Array<{ value: string }>;
    if (configResult[0]?.value === 'false') {
      return NextResponse.json({ message: 'Bot est en pause', trades_executed: 0, decisions: [] });
    }

    const riskResult = (await db`SELECT value FROM bot_config WHERE key = 'risk_level'`) as Array<{ value: string }>;
    const riskLevel = (riskResult[0]?.value ?? 'moderate') as 'conservative' | 'moderate' | 'aggressive';

    const modeResult = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
    const isLive = modeResult[0]?.value === 'live';
    const currentEnv = isLive ? 'live' : 'paper';

    const tradesTodayResult = (await db`
      SELECT COUNT(*) as count FROM trades
      WHERE executed_at > NOW() - INTERVAL '24 hours'
      AND action IN ('BUY', 'SELL') AND env = ${currentEnv}
    `) as Array<{ count: string }>;
    const tradesExecutedToday = parseInt(tradesTodayResult[0]?.count ?? '0');

    const maxTradesResult = (await db`SELECT value FROM bot_config WHERE key = 'max_trades_per_day'`) as Array<{ value: string }>;
    const maxTrades = parseInt(maxTradesResult[0]?.value ?? '5');

    if (tradesExecutedToday >= maxTrades) {
      return NextResponse.json({ message: `Max trades atteint (${tradesExecutedToday}/${maxTrades})`, trades_executed: 0, decisions: [] });
    }

    const [marketData, news, fearGreed, eurUsdRate, trendingCoins, defiTVL] = await Promise.all([
      getMarketData(WATCHLIST_COINS),
      getCryptoNews(),
      getFearGreedIndex() as Promise<{ value: number; label: string }>,
      getEurUsdRate(), getTrendingCoins(), getDefiTVL(),
    ]);

    const additionalCoins = trendingCoins.filter(id => !WATCHLIST_COINS.includes(id));
    let allMarketData = [...marketData];
    if (additionalCoins.length > 0) {
      const trendingData = await getMarketData(additionalCoins);
      allMarketData = [...marketData, ...trendingData];
    }

    const technicalIndicators: TechnicalIndicators[] = [];
    await Promise.all(
      allMarketData.slice(0, 15).map(async coin => {
        const coinId = SYMBOL_TO_COINGECKO_ID[coin.symbol] ?? coin.symbol.toLowerCase();
        const history = await getCoinHistory(coinId, 60);
        const prices = history.map(h => h.price);
        if (prices.length >= 26) technicalIndicators.push({ symbol: coin.symbol, ...calculateTechnicalIndicators(prices) });
      })
    );

    const portfolio = await getPortfolioSummary(allMarketData, undefined, ctx);
    const stopLossActions = await checkStopLossAndTakeProfit(allMarketData, undefined, ctx);

    if (isLive) await syncPortfolioFromExchange('both');

    const recentlySoldResult = (await db`
      SELECT DISTINCT symbol FROM trades
      WHERE action = 'SELL' AND executed_at > NOW() - INTERVAL '4 hours' AND env = ${currentEnv}
    `) as Array<{ symbol: string }>;
    const recentlySold = new Set(recentlySoldResult.map(r => r.symbol));

    for (const slAction of stopLossActions) {
      const marketCoin = allMarketData.find(m => m.symbol === slAction.symbol);
      if (!marketCoin) continue;
      const slDecision: BotDecision = {
        symbol: slAction.symbol, action: 'SELL',
        amount_eur: portfolio.holdings.find(h => h.symbol === slAction.symbol)?.current_value_eur ?? 0,
        reasoning: slAction.reason, confidence: 95, risk_score: 10, timeframe: 'Immédiat',
      };
      const result = isLive
        ? await executeLiveTrade(slDecision, marketCoin, eurUsdRate)
        : await executePaperTrade(slDecision, marketCoin, eurUsdRate, undefined, ctx);
      await sendTradeAlert(slDecision, result.success, marketCoin.price_eur, result.message, isLive);
          ${JSON.stringify({ price: marketCoin.price_eur })}, ${JSON.stringify({})}, ${currentEnv})`;
    }

    const decisions = await analyzeMarketWithAI({
      marketData: allMarketData, technicalIndicators, news, fearGreedIndex: fearGreed, defiTVL,
      currentPortfolio: {
        cash_eur: portfolio.cash_eur, total_value_eur: portfolio.total_value_eur,
        holdings: portfolio.holdings.map(h => ({ symbol: h.symbol, amount: h.amount, current_value_eur: h.current_value_eur, pnl_percent: h.pnl_percent })),
      },
      riskLevel, tradesExecutedToday: tradesExecutedToday + stopLossActions.length, eurUsdRate,
    });

    let tradesExecuted = 0;

    if (decisions.length === 0) {
      await db`INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, env)
        VALUES (${cycleId}, NULL, 'SKIP',
          ${`Aucune opportunité. Fear & Greed: ${fearGreed.value}/100 (${fearGreed.label}). Portefeuille: ${portfolio.total_value_eur.toFixed(2)}€.`},
          0, 0, 'gpt-4o', ${currentEnv})`;
    }

    for (const decision of decisions) {
      if (decision.action === 'BUY' && recentlySold.has(decision.symbol)) {
        await db`INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, env)
          VALUES (${cycleId}, ${decision.symbol}, 'SKIP', ${'Cooldown: vendu dans les 4h'}, 0, 0, 'cooldown-rule', ${currentEnv})`;
        continue;
      }
      if (decision.action === 'HOLD' || decision.action === 'SKIP') {
        await db`INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, env)
          VALUES (${cycleId}, ${decision.symbol}, ${decision.action}, ${decision.reasoning}, ${decision.confidence}, ${decision.risk_score}, 'gpt-4o', ${currentEnv})`;
        continue;
      }

      const marketCoin = allMarketData.find(m => m.symbol === decision.symbol);
      if (!marketCoin) continue;

      const result = isLive
        ? await executeLiveTrade(decision, marketCoin, eurUsdRate)
        : await executePaperTrade(decision, marketCoin, eurUsdRate, undefined, ctx);
      if (result.success) tradesExecuted++;

      const techIndicator = technicalIndicators.find(t => t.symbol === decision.symbol);
      const relevantNews = news.filter(n => !n.currencies || n.currencies.includes(decision.symbol)).slice(0, 3);

      await db`INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, market_data, technical_indicators, news_summary, env)
        VALUES (${cycleId}, ${decision.symbol}, ${decision.action}, ${decision.reasoning}, ${decision.confidence}, ${decision.risk_score}, 'gpt-4o',
          ${JSON.stringify({ price_eur: marketCoin.price_eur, change_24h: marketCoin.change_24h, fear_greed: fearGreed.value })},
          ${JSON.stringify(techIndicator ?? {})}, ${relevantNews.map(n => n.title).join(' | ')}, ${currentEnv})`;

      await sendTradeAlert(decision, result.success, marketCoin.price_eur, result.message, isLive);
    }

    const updatedPortfolio = await getPortfolioSummary(allMarketData, undefined, ctx);
    await savePortfolioSnapshot(updatedPortfolio, undefined, ctx);

    return NextResponse.json({
      cycle_id: cycleId, trades_executed: tradesExecuted,
      stop_loss_triggered: stopLossActions.length,
      portfolio_value_eur: updatedPortfolio.total_value_eur, ctx,
      decisions: decisions.map(d => ({ symbol: d.symbol, action: d.action, confidence: d.confidence })),
    });
  } catch (error) {
    console.error(`[Trigger ${cycleId}] Error:`, error);
    return NextResponse.json({ error: 'Analyse échouée', details: String(error) }, { status: 500 });
  }
}
