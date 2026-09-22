import { sql, sqlForContext, DbContext } from './db';
import { PortfolioSummary, PortfolioHolding, BotDecision, MarketData, dynamicStopPct } from './types';
import { getCurrentEnv, TradingEnv } from './env';

type Row = Record<string, unknown>;

function str(row: Row, field: string, fallback = '0'): string {
  return String(row[field] ?? fallback);
}

const PLATFORM_FEE_RATE = 0.0026; // 0.26% Kraken taker

// Helper: get the right sql function for a given ctx
function dbFor(ctx?: DbContext) {
  return ctx ? sqlForContext(ctx) : sql;
}

export async function getPortfolioSummary(
  marketData: MarketData[],
  envOverride?: TradingEnv,
  ctx?: DbContext
): Promise<PortfolioSummary> {
  const db = dbFor(ctx);
  const env = envOverride ?? await getCurrentEnv(ctx);

  // In live mode: sync from exchanges first to get real balances.
  // On garde le détail PAR exchange (pas seulement le total) pour que l'IA
  // et le routeur dimensionnent chaque ordre au cash de l'exchange qui paiera.
  // IMPORTANT : on resync aussi les MONTANTS crypto (source de vérité = exchanges),
  // sinon le dashboard affiche une DB périmée dès qu'un mouvement a lieu hors bot
  // (trade manuel, staking...) — d'où des chutes fantômes qui font peur.
  // Le sync préserve les avg_buy_price_eur (base des P&L et SL/TP).
  let cashKraken = 0;
  let cashCoinbase = 0;
  // Symboles détenus par exchange (live) pour la provenance des positions
  const krakenSymbols = new Set<string>();
  const coinbaseSymbols = new Set<string>();
  if (env === 'live') {
    try {
      const { getKrakenBalance } = await import('./exchanges/kraken');
      const { getCoinbaseBalance } = await import('./exchanges/coinbase');
      const { syncPortfolioFromExchange } = await import('./exchanges/live-trader');

      try {
        await syncPortfolioFromExchange('both');
      } catch { /* non-blocking : on continue avec la DB existante */ }

      let cashEur = 0;
      try {
        const kb = await getKrakenBalance();
        for (const [sym, amt] of Object.entries(kb)) {
          if (amt > 0) krakenSymbols.add(sym);
        }
        cashKraken = (kb['EUR'] ?? 0) + (kb['EURC'] ?? 0) + (kb['EURS'] ?? 0)
          + (kb['USD'] ?? 0) * 0.92 + (kb['USDC'] ?? 0) * 0.92 + (kb['USDT'] ?? 0) * 0.92;
        cashEur += cashKraken;
      } catch {}
      try {
        const cb = await getCoinbaseBalance();
        for (const [sym, amt] of Object.entries(cb)) {
          if (amt > 0) coinbaseSymbols.add(sym);
        }
        cashCoinbase = (cb['EUR'] ?? 0) + (cb['EURC'] ?? 0) + (cb['EURS'] ?? 0)
          + (cb['USD'] ?? 0) * 0.92 + (cb['USDC'] ?? 0) * 0.92 + (cb['USDT'] ?? 0) * 0.92;
        cashEur += cashCoinbase;
      } catch {}

      // If we got real cash, upsert it in DB so the rest of the logic works
      if (cashEur > 0) {
        await db`
          INSERT INTO portfolio (currency, symbol, amount, avg_buy_price_eur, env)
          VALUES ('EUR', 'EUR', ${cashEur}, 1, 'live')
          ON CONFLICT (symbol, env) DO UPDATE SET amount = ${cashEur}, updated_at = NOW()
        `;
      }
    } catch { /* non-blocking */ }
  }

  const holdings = (await db`SELECT * FROM portfolio WHERE env = ${env}`) as Row[];

  const priceMap: Record<string, number> = {};
  marketData.forEach(m => { priceMap[m.symbol] = m.price_eur; });

  let cash_eur = 0;
  let crypto_value_eur = 0;
  const holdingDetails: PortfolioHolding[] = [];

  // Stablecoins traités comme du cash (taux approx) : ils ne polluent plus
  // les positions et ne valent plus 0€ dans le total
  const STABLE_TO_EUR: Record<string, number> = {
    USD: 0.92, USDC: 0.92, USDT: 0.92, USDG: 0.92, EURC: 1, EURS: 1,
  };
  let stableCash = 0;

  for (const holding of holdings) {
    if (holding.symbol === 'EUR') {
      cash_eur = parseFloat(str(holding, 'amount'));
      continue;
    }
    const symbol = String(holding.symbol ?? '');
    const amount = parseFloat(str(holding, 'amount'));
    if (STABLE_TO_EUR[symbol] !== undefined) {
      stableCash += amount * STABLE_TO_EUR[symbol];
      continue;
    }
    const avgBuyPrice = parseFloat(str(holding, 'avg_buy_price_eur'));
    // Si le prix marché est inconnu (symbole hors watchlist, CoinGecko en rate-limit...),
    // on retombe sur le prix moyen d'achat plutôt que 0€ : ça évite de faire
    // disparaître une position entière du total (fausse falaise sur le graphique).
    let currentPrice = priceMap[symbol] ?? 0;
    if (!(currentPrice > 0) && avgBuyPrice > 0 && amount * avgBuyPrice >= 5) {
      console.warn(`[Portfolio] Prix inconnu pour ${symbol}, repli sur avg ${avgBuyPrice}`);
      currentPrice = avgBuyPrice;
    }
    const currentValue = amount * currentPrice;
    const costBasis = amount * avgBuyPrice;
    const pnl = currentValue - costBasis;
    const pnlPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
    crypto_value_eur += currentValue;
    const onKraken = krakenSymbols.has(symbol);
    const onCoinbase = coinbaseSymbols.has(symbol);
    holdingDetails.push({
      symbol,
      name: marketData.find(m => m.symbol === symbol)?.name ?? symbol,
      amount,
      avg_buy_price_eur: avgBuyPrice,
      current_price_eur: currentPrice,
      current_value_eur: currentValue,
      pnl_eur: pnl,
      pnl_percent: pnlPercent,
      ...(env === 'live' && (onKraken || onCoinbase)
        ? { source: (onKraken && onCoinbase ? 'both' : onKraken ? 'kraken' : 'coinbase') as 'kraken' | 'coinbase' | 'both' }
        : {}),
    });
  }

  cash_eur += stableCash;
  const total_value_eur = cash_eur + crypto_value_eur;

  // Read initial capital from DB (context-aware), fallback to env var then 5000
  const initialConfigRows = (await db`
    SELECT value FROM bot_config WHERE key = 'initial_portfolio_eur'
  `) as Row[];
  const initial = initialConfigRows.length > 0
    ? parseFloat(str(initialConfigRows[0], 'value'))
    : parseFloat(process.env.INITIAL_PORTFOLIO_EUR ?? '5000');

  const pnl_eur = total_value_eur - initial;
  const pnl_percent = initial > 0 ? (pnl_eur / initial) * 100 : 0;

  return {
    total_value_eur,
    cash_eur,
    crypto_value_eur,
    pnl_eur,
    pnl_percent,
    holdings: holdingDetails.filter(h => h.amount > 0),
    ...(env === 'live' ? { cash_by_exchange: { kraken: cashKraken, coinbase: cashCoinbase } } : {}),
  };
}

export async function ensurePortfolioExists(env: TradingEnv, ctx?: DbContext): Promise<void> {
  const db = dbFor(ctx);
  const existing = (await db`
    SELECT id FROM portfolio WHERE symbol = 'EUR' AND env = ${env}
  `) as Row[];

  if (existing.length === 0) {
    const initialAmount = parseFloat(process.env.INITIAL_PORTFOLIO_EUR ?? '5000');
    await db`
      INSERT INTO portfolio (currency, symbol, amount, avg_buy_price_eur, env)
      VALUES ('EUR', 'EUR', ${initialAmount}, 1, ${env})
    `;
  }
}

export async function executePaperTrade(
  decision: BotDecision,
  currentPrice: MarketData,
  eurUsdRate: number,
  envOverride?: TradingEnv,
  ctx?: DbContext
): Promise<{ success: boolean; message: string }> {
  const db = dbFor(ctx);
  const env = envOverride ?? await getCurrentEnv();

  try {
    if (decision.action === 'BUY') {
      const cashResult = (await db`
        SELECT amount FROM portfolio WHERE symbol = 'EUR' AND env = ${env}
      `) as Row[];
      const cashEur = parseFloat(str(cashResult[0] ?? {}, 'amount'));

      const minTrade = 50;
      const availableForTrade = cashEur * 0.95;

      if (cashEur < minTrade) {
        return {
          success: false,
          message: `Fonds insuffisants: ${cashEur.toFixed(2)}€ (minimum ${minTrade}€)`,
        };
      }

      const actualAmount = Math.min(decision.amount_eur, availableForTrade);
      const fee = actualAmount * PLATFORM_FEE_RATE;
      const cryptoAmount = (actualAmount - fee) / currentPrice.price_eur;

      await db`
        UPDATE portfolio SET amount = amount - ${actualAmount}, updated_at = NOW()
        WHERE symbol = 'EUR' AND env = ${env}
      `;

      const existing = (await db`
        SELECT * FROM portfolio WHERE symbol = ${decision.symbol} AND env = ${env}
      `) as Row[];

      if (existing.length > 0) {
        const existingAmount = parseFloat(str(existing[0], 'amount'));
        const existingAvg = parseFloat(str(existing[0], 'avg_buy_price_eur'));
        const newTotal = existingAmount + cryptoAmount;
        const newAvg = (existingAmount * existingAvg + cryptoAmount * currentPrice.price_eur) / newTotal;
        // Renfort : l'échelle des TP repart de zéro (flag partiel reset) et le
        // trailing repart du prix d'achat (highest reset).
        // Fallback sans nouvelles colonnes si la migration n'a pas été jouée.
        try {
          await db`
            UPDATE portfolio SET amount = ${newTotal}, avg_buy_price_eur = ${newAvg}, partial_tp_taken = FALSE, highest_price_eur = ${currentPrice.price_eur}, updated_at = NOW()
            WHERE symbol = ${decision.symbol} AND env = ${env}
          `;
        } catch {
          await db`
            UPDATE portfolio SET amount = ${newTotal}, avg_buy_price_eur = ${newAvg}, updated_at = NOW()
            WHERE symbol = ${decision.symbol} AND env = ${env}
          `;
        }
      } else {
        await db`
          INSERT INTO portfolio (currency, symbol, amount, avg_buy_price_eur, env)
          VALUES ('CRYPTO', ${decision.symbol}, ${cryptoAmount}, ${currentPrice.price_eur}, ${env})
        `;
      }

      await db`
        INSERT INTO trades (symbol, action, amount, price_eur, price_usd, eur_usd_rate, total_eur, fee_eur, mode, reasoning, confidence, env)
        VALUES (
          ${decision.symbol}, 'BUY', ${cryptoAmount}, ${currentPrice.price_eur},
          ${currentPrice.price_usd}, ${eurUsdRate}, ${actualAmount},
          ${fee}, ${env}, ${decision.reasoning}, ${decision.confidence}, ${env}
        )
      `;

      const adapted = actualAmount < decision.amount_eur
        ? ` (adapte: ${actualAmount.toFixed(0)}€)` : '';
      return {
        success: true,
        message: `Achat ${cryptoAmount.toFixed(6)} ${decision.symbol} à ${currentPrice.price_eur.toFixed(4)}€${adapted}`,
      };
    }

    if (decision.action === 'SELL') {
      const holdingResult = (await db`
        SELECT * FROM portfolio WHERE symbol = ${decision.symbol} AND env = ${env}
      `) as Row[];

      if (holdingResult.length === 0 || parseFloat(str(holdingResult[0], 'amount')) <= 0) {
        return { success: false, message: `Aucune position ${decision.symbol}` };
      }

      const holding = holdingResult[0];
      const holdingValue = parseFloat(str(holding, 'amount')) * currentPrice.price_eur;
      const sellValue = Math.min(decision.amount_eur, holdingValue);
      const cryptoToSell = sellValue / currentPrice.price_eur;
      const fee = sellValue * PLATFORM_FEE_RATE;
      const eurReceived = sellValue - fee;

      const newAmount = parseFloat(str(holding, 'amount')) - cryptoToSell;
      if (newAmount <= 0.000001) {
        await db`DELETE FROM portfolio WHERE symbol = ${decision.symbol} AND env = ${env}`;
      } else {
        await db`
          UPDATE portfolio SET amount = ${newAmount}, updated_at = NOW()
          WHERE symbol = ${decision.symbol} AND env = ${env}
        `;
        // Vente partielle (TP 50%) : le reliquat visera le palier 2
        if (decision.partial === true) {
          try {
            await db`UPDATE portfolio SET partial_tp_taken = TRUE, updated_at = NOW() WHERE symbol = ${decision.symbol} AND env = ${env}`;
          } catch { /* colonne absente pré-migration : non-bloquant */ }
        }
      }

      await db`
        UPDATE portfolio SET amount = amount + ${eurReceived}, updated_at = NOW()
        WHERE symbol = 'EUR' AND env = ${env}
      `;

      await db`
        INSERT INTO trades (symbol, action, amount, price_eur, price_usd, eur_usd_rate, total_eur, fee_eur, mode, reasoning, confidence, env)
        VALUES (
          ${decision.symbol}, 'SELL', ${cryptoToSell}, ${currentPrice.price_eur},
          ${currentPrice.price_usd}, ${eurUsdRate}, ${eurReceived},
          ${fee}, ${env}, ${decision.reasoning}, ${decision.confidence}, ${env}
        )
      `;

      return {
        success: true,
        message: `Vente ${cryptoToSell.toFixed(6)} ${decision.symbol} → ${eurReceived.toFixed(2)}€`,
      };
    }

    return { success: true, message: `${decision.action} ${decision.symbol}` };
  } catch (error) {
    console.error('Trade execution error:', error);
    return { success: false, message: `Erreur: ${error}` };
  }
}

export async function savePortfolioSnapshot(
  portfolio: PortfolioSummary,
  envOverride?: TradingEnv,
  ctx?: DbContext
): Promise<void> {
  const db = dbFor(ctx);
  const env = envOverride ?? await getCurrentEnv();
  await db`
    INSERT INTO portfolio_snapshots (total_value_eur, cash_eur, crypto_value_eur, pnl_eur, pnl_percent, holdings, env)
    VALUES (
      ${portfolio.total_value_eur}, ${portfolio.cash_eur}, ${portfolio.crypto_value_eur},
      ${portfolio.pnl_eur}, ${portfolio.pnl_percent}, ${JSON.stringify(portfolio.holdings)}, ${env}
    )
  `;
}

export interface StopLossAction {
  symbol: string;
  action: 'SELL';
  reason: string;
  // Part de la position à vendre (1 = tout, 0.5 = take-profit partiel).
  // Les routes dimensionnent amount_eur = valeur_position × ratio.
  ratio: number;
}

export async function checkStopLossAndTakeProfit(
  marketData: MarketData[],
  envOverride?: TradingEnv,
  ctx?: DbContext,
  // Volatilité journalière (%) par symbole (vient des indicateurs techniques).
  // Sans vol : repli sur le stop configuré.
  volBySymbol?: Record<string, number>
): Promise<StopLossAction[]> {
  const db = dbFor(ctx);
  const env = envOverride ?? await getCurrentEnv();
  const holdings = (await db`
    SELECT * FROM portfolio WHERE symbol != 'EUR' AND env = ${env}
  `) as Row[];

  const configRows = (await db`SELECT * FROM bot_config`) as Row[];
  const configMap: Record<string, string> = {};
  configRows.forEach(c => { configMap[String(c.key ?? '')] = String(c.value ?? ''); });

  const stopLossCfg = parseFloat(configMap.stop_loss_pct ?? '8');
  const takeProfitCfg = parseFloat(configMap.take_profit_pct ?? '15');
  // Second palier : le reliquat sort à 2× le take-profit
  const takeProfit2Cfg = takeProfitCfg * 2;

  // Flag "TP partiel déjà pris" par position (colonne ajoutée par migration ;
  // absente sur les vieilles DB -> on suppose false pour tout le monde)
  const partialTaken: Record<string, boolean> = {};
  try {
    const flagRows = (await db`
      SELECT symbol, partial_tp_taken FROM portfolio WHERE symbol != 'EUR' AND env = ${env}
    `) as Row[];
    for (const r of flagRows) {
      partialTaken[String(r.symbol)] = String(r.partial_tp_taken).toLowerCase() === 'true';
    }
  } catch { /* colonne absente : aucun TP partiel pris */ }

  const actions: StopLossAction[] = [];

  for (const holding of holdings) {
    const symbol = String(holding.symbol ?? '');
    const market = marketData.find(m => m.symbol === symbol);
    if (!market) continue;

    // Filtre dust : une poussière (< 5€) ne doit jamais déclencher un SELL
    // (Kraken rejette avec "volume minimum not met")
    const amount = parseFloat(str(holding, 'amount'));
    const positionValue = amount * market.price_eur;
    if (positionValue < 5) continue;

    const avgBuyPrice = parseFloat(str(holding, 'avg_buy_price_eur'));
    // avg_buy_price = 0 (positions sync depuis l'exchange) : pas de base de calcul -> skip
    // pour éviter un take-profit/stop-loss aberrant et une tentative de vente de poussière
    if (!(avgBuyPrice > 0)) continue;
    const change = ((market.price_eur - avgBuyPrice) / avgBuyPrice) * 100;

    // Stop-loss DYNAMIQUE : 1.5× la volatilité, ancré à la config utilisateur
    const dynStop = dynamicStopPct(volBySymbol?.[symbol] ?? null, stopLossCfg);

    // Trailing stop : suit le plus haut depuis l'achat (persisté en DB).
    // Laisse courir les gagnants, sort si le prix retrace de dynStop depuis le sommet.
    let highest = parseFloat(str(holding, 'highest_price_eur'));
    if (!(highest > 0)) highest = market.price_eur; // init (nouvelle position / pré-migration)
    if (market.price_eur > highest) highest = market.price_eur;
    try {
      await db`UPDATE portfolio SET highest_price_eur = ${highest}, updated_at = NOW() WHERE symbol = ${symbol} AND env = ${env}`;
    } catch { /* colonne absente pré-migration : trailing désactivé, SL/TP classiques */ }
    const drawdownFromHigh = highest > 0 ? ((market.price_eur - highest) / highest) * 100 : 0;

    if (change <= -dynStop) {
      actions.push({ symbol, action: 'SELL', ratio: 1, reason: `Stop-loss: ${change.toFixed(2)}% depuis achat à ${avgBuyPrice.toFixed(4)}€ (stop dyn ${dynStop.toFixed(1)}%)` });
    } else if (drawdownFromHigh <= -dynStop && highest > avgBuyPrice && change > 0) {
      // Retracement depuis le sommet alors que la position est encore gagnante :
      // on sécurise tout (le TP partiel a déjà pris 50% si le palier 1 est passé).
      // Le "change > 0" évite de vendre à perte sur un micro-retracement.
      actions.push({ symbol, action: 'SELL', ratio: 1, reason: `Trailing stop: ${drawdownFromHigh.toFixed(2)}% depuis le plus haut à ${highest.toFixed(4)}€ (position +${change.toFixed(1)}% vs achat)` });
    } else if (change >= takeProfit2Cfg && partialTaken[symbol]) {
      // Second palier : le reliquat sort, la tendance a doublé l'objectif
      actions.push({ symbol, action: 'SELL', ratio: 1, reason: `Take-profit palier 2: +${change.toFixed(2)}% (objectif initial +${takeProfitCfg}%), sortie du reliquat` });
    } else if (change >= takeProfitCfg && !partialTaken[symbol]) {
      // Premier palier : on sécurise 50%, le reste continue de courir.
      // Si la position est trop petite pour splitter (< 10€), sortie totale.
      const ratio = positionValue >= 10 ? 0.5 : 1;
      actions.push({
        symbol,
        action: 'SELL',
        ratio,
        reason: ratio < 1
          ? `Take-profit partiel (50%): +${change.toFixed(2)}% depuis achat à ${avgBuyPrice.toFixed(4)}€ — le reliquat continue de courir`
          : `Take-profit: +${change.toFixed(2)}% depuis achat à ${avgBuyPrice.toFixed(4)}€ (position < 10€ : sortie totale)`,
      });
    }
  }
  return actions;
}
