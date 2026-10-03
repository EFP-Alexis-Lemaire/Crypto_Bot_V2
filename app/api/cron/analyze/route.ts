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
  getBtcDominance,
  WATCHLIST_COINS,
  SYMBOL_TO_COINGECKO_ID,
} from '@/lib/market-data';
import { analyzeMarketWithAI } from '@/lib/ai-engine';
import {
  getPortfolioSummary,
  executePaperTrade,
  savePortfolioSnapshot,
  checkStopLossAndTakeProfit,
  applyTradeToMemSummary,
  getDrawdown24h,
} from '@/lib/portfolio';
import { executeLiveTrade, syncPortfolioFromExchange } from '@/lib/exchanges/live-trader';
import { getSymbolsUntradableOnCoinbase, SYMBOL_TO_COINBASE_PRODUCT } from '@/lib/exchanges/coinbase';
import { getDrawdownReview } from '@/lib/memory';
import { runScheduledDca } from '@/lib/dca';
import { sendTelegramMessage } from '@/lib/telegram';
import { acquireCycleLock, releaseCycleLock } from '@/lib/cycle-lock';
import { sendTradeAlert } from '@/lib/telegram';
import { TechnicalIndicators, BotDecision, sectorOf, MAX_BUYS_PER_SECTOR_PER_CYCLE, DIP_DRAWDOWN_PCT, DIP_FEAR_GREED_MAX, RISK_CONFIGS, MAJOR_SYMBOLS, DIP_MAX_POSITION_PCT } from '@/lib/types';
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

    // Verrou anti-chevauchement : 2 cycles qui tournent ensemble lisent les mêmes
    // soldes et le 2e se prend "Insufficient funds". Libéré en finally + catch.
    if (!(await acquireCycleLock(db, cycleId))) {
      return NextResponse.json({
        message: 'Un cycle est déjà en cours — analyse ignorée (anti double-dépense)',
        skipped: true,
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
      btcDominance,
    ] = await Promise.all([
      getMarketData(WATCHLIST_COINS),
      getCryptoNews(),
      getFearGreedIndex() as Promise<{ value: number; label: string }>,
      getEurUsdRate(),
      getTrendingCoins(),
      getDefiTVL(),
      getBtcDominance(),
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
    let btcPrices: number[] = [];
    await Promise.all(
      topCoins.map(async coin => {
        try {
          const coinId = SYMBOL_TO_COINGECKO_ID[coin.symbol] ??
            coin.symbol.toLowerCase();
          const history = await getCoinHistory(coinId, 60);
          const prices = history.map(h => h.price);
          if (coin.symbol === 'BTC') btcPrices = prices;
          const volumes = history.map(h => h.volume ?? 0);

          if (prices.length >= 26) {
            const indicators = calculateTechnicalIndicators(
              prices,
              volumes.some(v => v > 0) ? volumes : undefined
            );
            technicalIndicators.push({ symbol: coin.symbol, ...indicators });
          }
        } catch (e) {
          console.warn(`[Bot Cycle ${cycleId}] history skip ${coin.symbol}:`, String(e));
        }
      })
    );

    // Régime de marché : breadth (% > SMA50) + dominance BTC (cache 10 min)
    let breadth: number | null = null;
    {
      const withSma = technicalIndicators.filter(t => t.sma_50 !== null && t.sma_50 !== undefined);
      if (withSma.length >= 5) {
        const above = withSma.filter(t => {
          const px = allMarketData.find(m => m.symbol === t.symbol)?.price_eur;
          return px !== undefined && t.sma_50 !== null && t.sma_50 !== undefined && px > (t.sma_50 as number);
        }).length;
        breadth = (above / withSma.length) * 100;
      }
    }
    const volMap: Record<string, number> = {};
    for (const t of technicalIndicators) {
      if (t.volatility_pct !== null && t.volatility_pct !== undefined && t.volatility_pct > 0) {
        volMap[t.symbol] = t.volatility_pct;
      }
    }

    // Mode dip (crash objectif) : drawdown BTC 30j <= -15% OU Fear&Greed <= 25
    // → plafond BTC/ETH relevé à 50% pour acheter la peur
    let btcDrawdown: number | null = null;
    if (btcPrices.length >= 31) {
      const window = btcPrices.slice(-31);
      const high = Math.max(...window);
      const last = window[window.length - 1];
      if (high > 0) btcDrawdown = ((last - high) / high) * 100;
    }
    const dipMode = (btcDrawdown !== null && btcDrawdown <= DIP_DRAWDOWN_PCT)
      || fearGreed.value <= DIP_FEAR_GREED_MAX;
    if (dipMode) console.log(`[Bot Cycle ${cycleId}] DIP MODE actif (drawdown BTC: ${btcDrawdown?.toFixed(1)}%, F&G: ${fearGreed.value})`);

    // Sync from exchange if live mode (live trader écrit en PROD : ne sync que si on est sur la DB prod)
    if (isLive && dbContext === 'prod') {
      await syncPortfolioFromExchange('both');
    }

    // Get current portfolio — on passe currentEnv explicitement pour ne pas
    // relire trading_mode sur la mauvaise DB
    const portfolio = await getPortfolioSummary(allMarketData, currentEnv, dbContext);

    // Coupe-circuit : chute >= seuil sur 24h → BUYs en pause ce cycle.
    // Les ventes/stops continuent (protection), le DCA continue (mécanique).
    let breakerTripped = false;
    let breakerDd: number | null = null;
    {
      const bCfg = (await db`SELECT key, value FROM bot_config WHERE key IN ('circuit_breaker_enabled', 'circuit_breaker_pct', 'circuit_breaker_tripped')`) as Array<{ key: string; value: string }>;
      const bmap: Record<string, string> = {};
      bCfg.forEach(r => { bmap[r.key] = r.value; });
      const breakerOn = (bmap.circuit_breaker_enabled ?? 'true') === 'true';
      const breakerPct = Math.abs(parseFloat(bmap.circuit_breaker_pct ?? '8') || 8);
      if (breakerOn) {
        breakerDd = await getDrawdown24h(dbContext, currentEnv);
        if (breakerDd !== null && breakerDd <= -breakerPct) {
          breakerTripped = true;
          const today = new Date().toISOString().slice(0, 10);
          if (bmap.circuit_breaker_tripped !== today) {
            await db`INSERT INTO bot_config (key, value, updated_at) VALUES ('circuit_breaker_tripped', ${today}, NOW()) ON CONFLICT (key) DO UPDATE SET value = ${today}, updated_at = NOW()`;
            await sendTelegramMessage(`🛑 <b>Coupe-circuit déclenché</b> : ${breakerDd.toFixed(2)}% en 24h (seuil −${breakerPct}%). Achats en pause — stops et ventes maintenus.`, isLive, dbContext);
          }
          console.log(`[Bot Cycle ${cycleId}] CIRCUIT BREAKER actif (${breakerDd.toFixed(2)}% / 24h) — BUYs en pause`);
        } else if (breakerDd !== null && bmap.circuit_breaker_tripped) {
          await db`UPDATE bot_config SET value = '', updated_at = NOW() WHERE key = 'circuit_breaker_tripped'`;
          await sendTelegramMessage(`✅ <b>Coupe-circuit levé</b> : drawdown résorbé (${breakerDd.toFixed(2)}% en 24h) — achats réactivés.`, isLive, dbContext);
        }
      }
    }

    // Check stop-loss (dynamique : 1.5× vol) / take-profit par paliers (50% puis solde)
    console.log(`[Bot Cycle ${cycleId}] Checking stop-loss/take-profit...`);
    const stopLossActions = await checkStopLossAndTakeProfit(allMarketData, currentEnv, dbContext, volMap);

    // Track recently sold symbols to prevent immediate rebuy
    const recentlySoldResult = (await db`
      SELECT DISTINCT symbol FROM trades
      WHERE action = 'SELL'
      AND executed_at > NOW() - INTERVAL '2 hours'
      AND env = ${currentEnv}
    `) as Array<{ symbol: string }>;
    const recentlySold = new Set(recentlySoldResult.map(r => r.symbol));
    
    for (const slAction of stopLossActions) {
      const marketCoin = allMarketData.find(m => m.symbol === slAction.symbol);
      if (!marketCoin) continue;

      const positionValue = portfolio.holdings.find(h => h.symbol === slAction.symbol)
        ?.current_value_eur ?? 0;
      // Palier : 1 = sortie totale (SL / palier 2), 0.5 = TP partiel
      const sellAmount = positionValue * (slAction.ratio ?? 1);
      // Filtre dust : ne jamais appeler l'exchange sous le minimum Kraken (~5€)
      if (sellAmount < 5) {
        console.log(`[Bot Cycle ${cycleId}] Skipping SELL ${slAction.symbol} — dust ${sellAmount.toFixed(2)}€ < 5€`);
        await db`
          INSERT INTO bot_decisions
            (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, market_data, technical_indicators, env)
          VALUES (
            ${cycleId}, ${slAction.symbol}, 'SKIP',
            ${`Poussière ignorée: vente ${sellAmount.toFixed(2)}€ < 5€ minimum exchange. ${slAction.reason}`},
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
        amount_eur: sellAmount,
        reasoning: slAction.reason,
        confidence: 95,
        risk_score: 10,
        timeframe: 'Immédiat',
        partial: (slAction.ratio ?? 1) < 1,
      };

      const result = isLive
        ? await executeLiveTrade(slDecision, marketCoin, eurUsdRate)
        : await executePaperTrade(slDecision, marketCoin, eurUsdRate, currentEnv, dbContext);
      const slHeld = portfolio.holdings.find(h => h.symbol === slAction.symbol);
      await sendTradeAlert(slDecision, result.success, marketCoin.price_eur, result.message, isLive, dbContext,
        slHeld ? { eur: slHeld.pnl_eur, pct: slHeld.pnl_percent } : undefined);
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

    // Symboles non-tradables sur Coinbase (produit non listé sur le compte/région) :
    // l'IA doit les dimensionner au cash Kraken seul (1 seul appel, cache 1h)
    let untradableCB: string[] = [];
    if (isLive) {
      try {
        untradableCB = await getSymbolsUntradableOnCoinbase(Object.keys(SYMBOL_TO_COINBASE_PRODUCT));
        if (untradableCB.length > 0) console.log(`[Bot Cycle ${cycleId}] Untradable on Coinbase: ${untradableCB.join(', ')}`);
      } catch { /* fail-open : on tente quand même */ }
    }

    // Revue des pertes 3j (null si pas de pertes) : journal anti-récidive pour l'IA
    const drawdownReview = await getDrawdownReview(dbContext, currentEnv);
    if (drawdownReview) {
      console.log(`[Bot Cycle ${cycleId}] Drawdown 3j: ${drawdownReview.dd_pct}% (${drawdownReview.dd_eur}€) — revue injectée`);
    }

    // AI Analysis — en live on transmet le cash PAR exchange pour que l'IA
    // dimensionne chaque ordre au cash d'un seul exchange (pas au total consolidé)
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
        ...(isLive && portfolio.cash_by_exchange ? {
          cash_kraken_eur: portfolio.cash_by_exchange.kraken,
          cash_coinbase_eur: portfolio.cash_by_exchange.coinbase,
          unavailable_on_coinbase: untradableCB,
        } : {}),
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
      dbContext,
      marketRegime: { breadth_pct: breadth, btc_dominance: btcDominance, dip_mode: dipMode, btc_drawdown_30d: btcDrawdown },
      drawdownReview,
    });

    // Suivi mémoire du cash par exchange pour les BUYs successifs du même cycle
    // (le routeur dans executeLiveTrade relit les vrais soldes à chaque ordre :
    // ceci sert juste à capper correctement AVANT l'appel exchange)
    let krakenCashMem = portfolio.cash_by_exchange?.kraken ?? portfolio.cash_eur;
    let coinbaseCashMem = portfolio.cash_by_exchange?.coinbase ?? 0;

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
    // Compteur sectoriel anti-corrélation (max 2 BUYs/secteur/cycle)
    const sectorBuys: Record<string, number> = {};
    // Dépensé par symbole ce cycle (cap cumulé max_position sur les renforts)
    const symbolSpent: Record<string, number> = {};

    // Achats programmés hebdo (enveloppe séparée du budget IA ; tourne même si
    // coupe-circuit actif — acheter le creux, c'est le principe du DCA)
    const dcaRuns = await runScheduledDca({
      db, ctx: dbContext, env: currentEnv, isLive,
      marketData: allMarketData, eurUsdRate, cycleId,
    });
    let dcaExecuted = 0;
    if (isLive) {
      for (const dca of dcaRuns) {
        if (!dca.result.success) continue;
        dcaExecuted++;
        const charged = dca.result.chargedEur ?? dca.decision.amount_eur;
        const usedEx = dca.result.exchange ?? (charged <= krakenCashMem * 0.95 ? 'kraken' : 'coinbase');
        if (usedEx === 'kraken') krakenCashMem = Math.max(0, krakenCashMem - charged);
        else coinbaseCashMem = Math.max(0, coinbaseCashMem - charged);
        portfolio.cash_eur = Math.max(0, portfolio.cash_eur - charged);
        symbolSpent[dca.decision.symbol] = (symbolSpent[dca.decision.symbol] ?? 0) + charged;
        const sec = sectorOf(dca.decision.symbol);
        sectorBuys[sec] = (sectorBuys[sec] ?? 0) + 1;
        applyTradeToMemSummary(portfolio, 'BUY', dca.decision.symbol, charged, dca.marketCoin.price_eur, dca.marketCoin.name);
      }
    }

    for (const decision of decisions) {
      // Coupe-circuit : achats en pause (ventes et stops maintenus)
      if (breakerTripped && decision.action === 'BUY') {
        console.log(`[Bot Cycle ${cycleId}] Skipping BUY ${decision.symbol} — circuit breaker (${breakerDd?.toFixed(2)}% / 24h)`);
        await db`INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, env)
          VALUES (${cycleId}, ${decision.symbol}, 'SKIP',
            ${`Coupe-circuit actif (${breakerDd?.toFixed(2)}% en 24h) : achat en pause, stops maintenus.`},
            0, 0, 'circuit-breaker', ${currentEnv})`;
        continue;
      }
      // Block immediate rebuy of recently sold symbols
      if (decision.action === 'BUY' && recentlySold.has(decision.symbol)) {
        console.log(`[Bot Cycle ${cycleId}] Skipping BUY ${decision.symbol} — sold within last 2h`);
        await db`
          INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, env)
          VALUES (${cycleId}, ${decision.symbol}, 'SKIP',
            ${'Rachat bloqué: ' + decision.symbol + ' a été vendu dans les 2 dernières heures. Délai de cooldown respecté (un creux peut justifier un rachat rapide après ce délai).'},
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

      // Garde-fou corrélation : max 2 BUYs du même secteur par cycle
      // (évite 3 paris corrélés type UNI+AAVE+CRV le même jour)
      if (decision.action === 'BUY') {
        const sector = sectorOf(decision.symbol);
        if ((sectorBuys[sector] ?? 0) >= MAX_BUYS_PER_SECTOR_PER_CYCLE) {
          console.log(`[Bot Cycle ${cycleId}] Skipping BUY ${decision.symbol} — secteur ${sector} déjà à ${MAX_BUYS_PER_SECTOR_PER_CYCLE} ce cycle`);
          await db`INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, env)
            VALUES (${cycleId}, ${decision.symbol}, 'SKIP',
              ${`Corrélation: secteur ${sector} déjà acheté ${MAX_BUYS_PER_SECTOR_PER_CYCLE}× ce cycle. Diversification forcée.`},
              0, 0, 'correlation-guard', ${currentEnv})`;
          continue;
        }
      }

      // Hard cap: en live, un BUY est payé par UN SEUL exchange -> cap à 80%
      // du max des deux soldes (jamais du total consolidé). Symboles non-tradables
      // sur Coinbase -> cash Kraken seul. En paper, cap au cash.
      if (decision.action === 'BUY') {
        const capBase = isLive
          ? (untradableCB.includes(decision.symbol) ? krakenCashMem : Math.max(krakenCashMem, coinbaseCashMem))
          : portfolio.cash_eur;
        if (capBase < 5) {
          await db`INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, env)
            VALUES (${cycleId}, ${decision.symbol}, 'SKIP',
              ${isLive
                ? `Cash insuffisant par exchange (Kraken: ${krakenCashMem.toFixed(2)}€, Coinbase: ${coinbaseCashMem.toFixed(2)}€ < 5€ minimum). Trade annulé.`
                : `Cash insuffisant (${portfolio.cash_eur.toFixed(2)}€ < 5€ minimum). Trade annulé.`},
              0, 0, 'cash-guard', ${currentEnv})`;
          continue;
        }
        const maxAllowed = parseFloat((capBase * 0.80).toFixed(2));
        if (decision.amount_eur > maxAllowed) {
          decision.amount_eur = maxAllowed;
        }
        // Cap cumulé par symbole : les achats successifs du même cycle ne dépassent
        // pas ensemble max_position. En mode dip, les majors montent jusqu'à 50%.
        const maxPosPct = dipMode && MAJOR_SYMBOLS.includes(decision.symbol)
          ? DIP_MAX_POSITION_PCT
          : RISK_CONFIGS[riskLevel].max_position_size_pct;
        const maxPosEur = portfolio.total_value_eur * maxPosPct / 100;
        const heldVal = portfolio.holdings.find(h => h.symbol === decision.symbol)?.current_value_eur ?? 0;
        const room = maxPosEur - heldVal - (symbolSpent[decision.symbol] ?? 0);
        if (room < 5) {
          await db`INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, env)
            VALUES (${cycleId}, ${decision.symbol}, 'SKIP',
              ${`Position ${decision.symbol} déjà à ${(heldVal + (symbolSpent[decision.symbol] ?? 0)).toFixed(0)}€ (max ${maxPosEur.toFixed(0)}€). Renfort refusé.`},
              0, 0, 'max-position', ${currentEnv})`;
          continue;
        }
        if (decision.amount_eur > room) {
          decision.amount_eur = parseFloat(room.toFixed(2));
        }
      }

      const result = isLive
        ? await executeLiveTrade(decision, marketCoin, eurUsdRate)
        : await executePaperTrade(decision, marketCoin, eurUsdRate, currentEnv, dbContext);
      executedTrades.push({ decision, result });
      // Montant réellement débité (le routeur peut ajuster de quelques centimes)
      const charged = (result as { chargedEur?: number }).chargedEur ?? decision.amount_eur;
      if (result.success && decision.action === 'BUY') {
        const sector = sectorOf(decision.symbol);
        sectorBuys[sector] = (sectorBuys[sector] ?? 0) + 1;
        symbolSpent[decision.symbol] = (symbolSpent[decision.symbol] ?? 0) + charged;
      }

      // Màj mémoire du cash par exchange après chaque trade réussi
      // (pour que les BUYs suivants du même cycle voient le cash restant)
      if (result.success && isLive) {
        const usedExchange = (result as { exchange?: 'kraken' | 'coinbase' }).exchange
          ?? (charged <= krakenCashMem * 0.95 ? 'kraken' : 'coinbase');
        if (decision.action === 'BUY') {
          if (usedExchange === 'kraken') krakenCashMem = Math.max(0, krakenCashMem - charged);
          else coinbaseCashMem = Math.max(0, coinbaseCashMem - charged);
          portfolio.cash_eur = Math.max(0, portfolio.cash_eur - charged);
          applyTradeToMemSummary(portfolio, 'BUY', decision.symbol, charged, marketCoin.price_eur, marketCoin.name);
        } else if (decision.action === 'SELL') {
          // Vente splittée : on crédite chaque exchange au net réellement reçu
          const split = (result as { split?: { kraken: number; coinbase: number } }).split;
          if (split) {
            krakenCashMem += split.kraken;
            coinbaseCashMem += split.coinbase;
            portfolio.cash_eur += split.kraken + split.coinbase;
          } else {
            // La vente crédite l'exchange vendeur (montant net approximatif)
            const credited = decision.amount_eur * 0.9974;
            if (usedExchange === 'kraken') krakenCashMem += credited;
            else coinbaseCashMem += credited;
            portfolio.cash_eur += credited;
          }
          applyTradeToMemSummary(portfolio, 'SELL', decision.symbol, decision.amount_eur, marketCoin.price_eur);
        }
      }

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

      const held = portfolio.holdings.find(h => h.symbol === decision.symbol);
      await sendTradeAlert(decision, result.success, marketCoin.price_eur, result.message, isLive, dbContext,
        held ? { eur: held.pnl_eur, pct: held.pnl_percent } : undefined);
    }

    // Save portfolio snapshot
    const updatedPortfolio = await getPortfolioSummary(allMarketData, currentEnv, dbContext);
    await savePortfolioSnapshot(updatedPortfolio, currentEnv, dbContext);

    console.log(
      `[Bot Cycle ${cycleId}] Done. ${executedTrades.length} trades executed.`
    );

    await releaseCycleLock(db);
    return NextResponse.json({
      cycle_id: cycleId,
      ctx: dbContext,
      env: currentEnv,
      trades_executed: executedTrades.length,
      dca_executed: dcaExecuted,
      circuit_breaker: { tripped: breakerTripped, dd_24h_pct: breakerDd },
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
    await releaseCycleLock(db);
    return NextResponse.json(
      { error: 'Analysis failed', details: String(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}

