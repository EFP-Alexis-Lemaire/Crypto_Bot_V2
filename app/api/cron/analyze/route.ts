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
import { cronUnauthorized } from '@/lib/cron-auth';
import { v4 as uuidv4 } from 'uuid';

export const maxDuration = 60; // 60 seconds for Vercel

// Helper to safely extract first row value from neon result
function firstVal(result: unknown, field: string): string | undefined {
  const arr = result as Array<Record<string, unknown>>;
  return arr?.[0]?.[field] as string | undefined;
}

export async function GET(request: Request) {
  // cron-job.org doit envoyer le header Authorization: Bearer <CRON_SECRET>
  // (les crons natifs Vercel l'envoient automatiquement quand la var existe)
  const unauthorized = cronUnauthorized(request);
  if (unauthorized) return unauthorized;

  const cycleId = uuidv4();
  // DB cible : priorité au param explicite (?ctx=prod ou ?db=prod) puis header
  // x-db-context (utile pour cron-job.org), sinon APP_ENV (Vercel crons natifs).
  // Sans indication explicite sur l'URL de prod, on suppose PROD pour éviter
  // d'écrire les cycles prod en UAT.
  const url = new URL(request.url);
  const queryCtx = url.searchParams.get('ctx') ?? url.searchParams.get('db');
  const headerCtx = request.headers.get('x-db-context');
  const dbContext = (queryCtx === 'prod' || queryCtx === 'uat')
    ? queryCtx
    : (headerCtx === 'prod' || headerCtx === 'uat')
      ? headerCtx
      : process.env.APP_ENV === 'production'
        ? 'prod'
        : (url.hostname.includes('localhost') || url.hostname.includes('127.0.0.1') ? 'uat' : 'prod');
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

    // Un coin invalide (ex: trending "gram" délisté) ne doit jamais faire échouer le cycle
    await Promise.all(
      topCoins.map(async coin => {
        try {
          const coinId = SYMBOL_TO_COINGECKO_ID[coin.symbol] ??
            coin.symbol.toLowerCase();
          const history = await getCoinHistory(coinId, 60);
          const prices = history.map(h => h.price);

          if (prices.length >= 26) {
            const indicators = calculateTechnicalIndicators(prices);
            technicalIndicators.push({ symbol: coin.symbol, ...indicators });
          }
        } catch (e) {
          console.warn(`[Bot Cycle ${cycleId}] history skip ${coin.symbol}:`, String(e));
        }
      })
    );

    // Sync from exchange if live mode (live trader écrit en PROD : ne sync que si on est sur la DB prod)
    if (isLive && dbContext === 'prod') {
      await syncPortfolioFromExchange('both');
    }

    // Get current portfolio — on passe currentEnv explicitement pour ne pas
    // relire trading_mode sur la mauvaise DB
    const portfolio = await getPortfolioSummary(allMarketData, currentEnv, dbContext);

    // Check stop-loss / take-profit first (le filtre dust < 5€ est dans checkStopLossAndTakeProfit)
    console.log(`[Bot Cycle ${cycleId}] Checking stop-loss/take-profit...`);
    const stopLossActions = await checkStopLossAndTakeProfit(allMarketData, currentEnv, dbContext);

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

      const positionValue = portfolio.holdings.find(h => h.symbol === slAction.symbol)
        ?.current_value_eur ?? 0;
      // Filtre dust : ne jamais appeler l'exchange sous le minimum Kraken (~5€)
      if (positionValue < 5) {
        console.log(`[Bot Cycle ${cycleId}] Skipping SELL ${slAction.symbol} — dust ${positionValue.toFixed(2)}€ < 5€`);
        await db`
          INSERT INTO bot_decisions
            (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, market_data, technical_indicators, env)
          VALUES (
            ${cycleId}, ${slAction.symbol}, 'SKIP',
            ${`Poussière ignorée: position ${positionValue.toFixed(2)}€ < 5€ minimum exchange. ${slAction.reason}`},
            0, 0, 'dust-filter',
            ${JSON.stringify({ price: marketCoin.price_eur })},
            ${JSON.stringify({})}, ${currentEnv}
          )
        `;
        continue;
      }

      const slDecision: BotDecision = {
        symbol: slAction.symbol,
        action: 'SELL',
        amount_eur: positionValue,
        reasoning: slAction.reason,
        confidence: 95,
        risk_score: 10,
        timeframe: 'Immédiat',
      };

      const result = isLive
        ? await executeLiveTrade(slDecision, marketCoin, eurUsdRate)
        : await executePaperTrade(slDecision, marketCoin, eurUsdRate, currentEnv, dbContext);
      await sendTradeAlert(slDecision, result.success, marketCoin.price_eur, result.message, isLive);
      // Log decision
      await db`
        INSERT INTO bot_decisions
          (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, market_data, technical_indicators, env)
        VALUES (
          ${cycleId}, ${slAction.symbol}, 'SELL',
          ${slAction.reason}, 95, 10, 'stop-loss-trigger',
          ${JSON.stringify({ price: marketCoin.price_eur })},
          ${JSON.stringify({})}, ${currentEnv}
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
        INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, env)
        VALUES (
          ${cycleId}, NULL, 'SKIP',
          ${`Aucune opportunité identifiée. Fear & Greed: ${fearGreed.value}/100 (${fearGreed.label}). Aucun setup ne justifie les frais (~0.52% aller-retour). Portefeuille: ${portfolio.total_value_eur.toFixed(2)}€.`},
          0, 0, 'gpt-4o', ${currentEnv}
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
          INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, env)
          VALUES (${cycleId}, ${decision.symbol}, 'SKIP',
            ${'Rachat bloqué: ' + decision.symbol + ' a été vendu dans les 4 dernières heures. Délai de cooldown respecté.'},
            0, 0, 'cooldown-rule', ${currentEnv})
        `;
        continue;
      }
      if (decision.action === 'HOLD' || decision.action === 'SKIP') {
        // Log but don't execute
        await db`
          INSERT INTO bot_decisions
            (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, env)
          VALUES (
            ${cycleId}, ${decision.symbol}, ${decision.action},
            ${decision.reasoning}, ${decision.confidence}, ${decision.risk_score},
            'gpt-4o', ${currentEnv}
          )
        `;
        continue;
      }

      const marketCoin = allMarketData.find(m => m.symbol === decision.symbol);
      if (!marketCoin) continue;

      // Garde-fou SELL : position réellement détenue, sinon SKIP silencieux
      // (sans appel exchange ni alerte Telegram). Évite les SELL hallucinés
      // par l'IA sur des actifs non détenus + cap au montant détenu.
      if (decision.action === 'SELL') {
        const held = portfolio.holdings.find(h => h.symbol === decision.symbol);
        if (!held) {
          console.log(`[Bot Cycle ${cycleId}] Skipping SELL ${decision.symbol} — no position held`);
          await db`INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, env)
            VALUES (${cycleId}, ${decision.symbol}, 'SKIP',
              ${`Vente impossible: aucune position ${decision.symbol} en portefeuille. ${decision.reasoning}`},
              0, 0, 'no-position', ${currentEnv})`;
          continue;
        }
        if (held.current_value_eur < 5) {
          console.log(`[Bot Cycle ${cycleId}] Skipping SELL ${decision.symbol} — dust ${held.current_value_eur.toFixed(2)}€ < 5€`);
          await db`INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, env)
            VALUES (${cycleId}, ${decision.symbol}, 'SKIP',
              ${`Poussière ignorée: vente ${held.current_value_eur.toFixed(2)}€ < 5€ minimum exchange (Kraken). ${decision.reasoning}`},
              0, 0, 'dust-filter', ${currentEnv})`;
          continue;
        }
        if (decision.amount_eur > held.current_value_eur) {
          decision.amount_eur = parseFloat(held.current_value_eur.toFixed(2));
        }
      }

      // Hard cap: never attempt a BUY with more than available cash
      if (decision.action === 'BUY') {
        const cashEur = portfolio.cash_eur;
        if (cashEur < 5) {
          await db`INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, env)
            VALUES (${cycleId}, ${decision.symbol}, 'SKIP',
              ${`Cash insuffisant (${cashEur.toFixed(2)}€ < 5€ minimum). Trade annulé.`},
              0, 0, 'cash-guard', ${currentEnv})`;
          continue;
        }
        const maxAllowed = parseFloat((cashEur * 0.80).toFixed(2));
        if (decision.amount_eur > maxAllowed) {
          decision.amount_eur = maxAllowed;
        }
      }

      const result = isLive
        ? await executeLiveTrade(decision, marketCoin, eurUsdRate)
        : await executePaperTrade(decision, marketCoin, eurUsdRate, currentEnv, dbContext);
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
          (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, market_data, technical_indicators, news_summary, env)
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
          ${relevantNews.map(n => n.title).join(' | ')}, ${currentEnv}
        )
      `;

      await sendTradeAlert(decision, result.success, marketCoin.price_eur, result.message, isLive);
    }

    // Save portfolio snapshot
    const updatedPortfolio = await getPortfolioSummary(allMarketData, currentEnv, dbContext);
    await savePortfolioSnapshot(updatedPortfolio, currentEnv, dbContext);

    console.log(
      `[Bot Cycle ${cycleId}] Done. ${executedTrades.length} trades executed.`
    );

    return NextResponse.json({
      cycle_id: cycleId,
      ctx: dbContext,
      env: currentEnv,
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

