import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
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

export const maxDuration = 60;

// This route is for dashboard manual triggers — no CRON_SECRET required
// It uses the same logic as /api/cron/analyze
export async function POST() {
  const cycleId = uuidv4();

  try {
    const configResult = (await sql`
      SELECT value FROM bot_config WHERE key = 'is_active'
    `) as Array<{ value: string }>;

    if (configResult[0]?.value === 'false') {
      return NextResponse.json({ message: 'Bot est en pause', trades_executed: 0, decisions: [] });
    }

    const riskResult = (await sql`
      SELECT value FROM bot_config WHERE key = 'risk_level'
    `) as Array<{ value: string }>;
    const riskLevel = (riskResult[0]?.value ?? 'moderate') as 'conservative' | 'moderate' | 'aggressive';

    // Get trading mode early (needed for trade count filter)
    const modeResultEarly = (await sql`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
    const isLive = modeResultEarly[0]?.value === 'live';
    const currentEnv = isLive ? 'live' : 'paper';

    const tradesTodayResult = (await sql`
      SELECT COUNT(*) as count FROM trades
      WHERE executed_at > NOW() - INTERVAL '24 hours'
      AND action IN ('BUY', 'SELL')
      AND env = ${currentEnv}
    `) as Array<{ count: string }>;
    const tradesExecutedToday = parseInt(tradesTodayResult[0]?.count ?? '0');

    const maxTradesResult = (await sql`
      SELECT value FROM bot_config WHERE key = 'max_trades_per_day'
    `) as Array<{ value: string }>;
    const maxTrades = parseInt(maxTradesResult[0]?.value ?? '5');

    if (tradesExecutedToday >= maxTrades) {
      return NextResponse.json({
        message: `Max trades atteint (${tradesExecutedToday}/${maxTrades})`,
        trades_executed: 0,
        decisions: [],
      });
    }

    // Fetch all market data
    const [marketData, news, fearGreed, eurUsdRate, trendingCoins, defiTVL] = await Promise.all([
      getMarketData(WATCHLIST_COINS),
      getCryptoNews(),
      getFearGreedIndex() as Promise<{ value: number; label: string }>,
      getEurUsdRate(),
      getTrendingCoins(),
      getDefiTVL(),
    ]);

    const additionalCoins = trendingCoins.filter(id => !WATCHLIST_COINS.includes(id));
    let allMarketData = [...marketData];
    if (additionalCoins.length > 0) {
      const trendingData = await getMarketData(additionalCoins);
      allMarketData = [...marketData, ...trendingData];
    }

    // Technical indicators
    const technicalIndicators: TechnicalIndicators[] = [];
    await Promise.all(
      allMarketData.slice(0, 15).map(async coin => {
        const coinId = SYMBOL_TO_COINGECKO_ID[coin.symbol] ?? coin.symbol.toLowerCase();
        const history = await getCoinHistory(coinId, 60);
        const prices = history.map(h => h.price);
        if (prices.length >= 26) {
          technicalIndicators.push({
            symbol: coin.symbol,
            ...calculateTechnicalIndicators(prices),
          });
        }
      })
    );

    const portfolio = await getPortfolioSummary(allMarketData);

    // Check stop-loss / take-profit
    const stopLossActions = await checkStopLossAndTakeProfit(allMarketData);

    // Get trading mode — already read earlier, remove duplicate
    // Sync from exchange if live mode
    if (isLive) {
      await syncPortfolioFromExchange('both');
    }
    const recentlySoldResult = (await sql`
      SELECT DISTINCT symbol FROM trades
      WHERE action = 'SELL'
      AND executed_at > NOW() - INTERVAL '4 hours'
    `) as Array<{ symbol: string }>;
    const recentlySold = new Set(recentlySoldResult.map(r => r.symbol));
    for (const slAction of stopLossActions) {
      const marketCoin = allMarketData.find(m => m.symbol === slAction.symbol);
      if (!marketCoin) continue;
      const slDecision: BotDecision = {
        symbol: slAction.symbol,
        action: 'SELL',
        amount_eur: portfolio.holdings.find(h => h.symbol === slAction.symbol)?.current_value_eur ?? 0,
        reasoning: slAction.reason,
        confidence: 95,
        risk_score: 10,
        timeframe: 'Immédiat',
      };
      const result = isLive
        ? await executeLiveTrade(slDecision, marketCoin, eurUsdRate)
        : await executePaperTrade(slDecision, marketCoin, eurUsdRate);
      await sendTradeAlert(slDecision, result.success, marketCoin.price_eur, result.message);
      await sql`
        INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, market_data, technical_indicators)
        VALUES (${cycleId}, ${slAction.symbol}, 'SELL', ${slAction.reason}, 95, 10, 'stop-loss-trigger',
          ${JSON.stringify({ price: marketCoin.price_eur })}, ${JSON.stringify({})})
      `;
    }

    // AI analysis
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

    let tradesExecuted = 0;

    // Always log the cycle, even if no decisions
    if (decisions.length === 0) {
      await sql`
        INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used)
        VALUES (
          ${cycleId}, NULL, 'SKIP',
          ${`Aucune opportunité identifiée. Fear & Greed: ${fearGreed.value}/100 (${fearGreed.label}). Marché analysé mais aucun setup ne justifie les frais de transaction (~0.52% aller-retour). Portefeuille: ${portfolio.total_value_eur.toFixed(2)}€.`},
          0, 0, 'gpt-4o'
        )
      `;
    }
    for (const decision of decisions) {
      // Block immediate rebuy of recently sold symbols
      if (decision.action === 'BUY' && recentlySold.has(decision.symbol)) {
        console.log(`[Trigger] Skipping BUY ${decision.symbol} — sold within last 4h (cooldown)`);
        await sql`
          INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used)
          VALUES (${cycleId}, ${decision.symbol}, 'SKIP',
            ${'Rachat bloqué: ' + decision.symbol + ' a été vendu dans les 4 dernières heures. Cooldown actif.'},
            0, 0, 'cooldown-rule')
        `;
        continue;
      }

      if (decision.action === 'HOLD' || decision.action === 'SKIP') {
        await sql`
          INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used)
          VALUES (${cycleId}, ${decision.symbol}, ${decision.action}, ${decision.reasoning}, ${decision.confidence}, ${decision.risk_score}, 'gpt-4o')
        `;
        continue;
      }

      const marketCoin = allMarketData.find(m => m.symbol === decision.symbol);
      if (!marketCoin) continue;

      // Execute paper or live trade based on mode
      const result = isLive
        ? await executeLiveTrade(decision, marketCoin, eurUsdRate)
        : await executePaperTrade(decision, marketCoin, eurUsdRate);
      if (result.success) tradesExecuted++;

      const techIndicator = technicalIndicators.find(t => t.symbol === decision.symbol);
      const relevantNews = news.filter(n => !n.currencies || n.currencies.includes(decision.symbol)).slice(0, 3);

      await sql`
        INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, market_data, technical_indicators, news_summary)
        VALUES (
          ${cycleId}, ${decision.symbol}, ${decision.action}, ${decision.reasoning},
          ${decision.confidence}, ${decision.risk_score}, 'gpt-4o',
          ${JSON.stringify({ price_eur: marketCoin.price_eur, change_24h: marketCoin.change_24h, fear_greed: fearGreed.value })},
          ${JSON.stringify(techIndicator ?? {})},
          ${relevantNews.map(n => n.title).join(' | ')}
        )
      `;

      await sendTradeAlert(decision, result.success, marketCoin.price_eur, result.message);
    }

    const updatedPortfolio = await getPortfolioSummary(allMarketData);
    await savePortfolioSnapshot(updatedPortfolio);

    return NextResponse.json({
      cycle_id: cycleId,
      trades_executed: tradesExecuted,
      stop_loss_triggered: stopLossActions.length,
      portfolio_value_eur: updatedPortfolio.total_value_eur,
      decisions: decisions.map(d => ({ symbol: d.symbol, action: d.action, confidence: d.confidence })),
    });
  } catch (error) {
    console.error(`[Dashboard Trigger ${cycleId}] Error:`, error);
    return NextResponse.json(
      { error: 'Analyse échouée', details: String(error) },
      { status: 500 }
    );
  }
}
