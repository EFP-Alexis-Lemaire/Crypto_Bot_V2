import { sqlForContext } from '../db';
import { BotDecision, MarketData } from '../types';
import {
  placeKrakenOrder,
  getKrakenBalance,
  SYMBOL_TO_KRAKEN_PAIR,
} from './kraken';
import {
  placeCoinbaseOrder,
  getCoinbaseBalance,
  SYMBOL_TO_COINBASE_PRODUCT,
} from './coinbase';

type Row = Record<string, unknown>;

// Live trader always writes to PROD DB
const db = sqlForContext('prod');

function getPreferredExchange(symbol: string): 'kraken' | 'coinbase' | null {
  if (SYMBOL_TO_KRAKEN_PAIR[symbol]) return 'kraken';
  if (SYMBOL_TO_COINBASE_PRODUCT[symbol]) return 'coinbase';
  return null;
}

// Cash EUR disponible par exchange (EUR + stablecoins valorisés ~0.92€).
// Utilisé pour router les BUY vers l'exchange qui peut réellement payer,
// au lieu de raisonner sur un cash total consolidé.
export async function getExchangeCash(): Promise<{ kraken: number; coinbase: number; total: number }> {
  let kraken = 0;
  let coinbase = 0;
  try {
    const kb = await getKrakenBalance();
    kraken = (kb['EUR'] ?? 0) + (kb['USD'] ?? 0) * 0.92 + (kb['USDC'] ?? 0) * 0.92 + (kb['USDT'] ?? 0) * 0.92;
  } catch { /* Kraken indisponible */ }
  try {
    const cb = await getCoinbaseBalance();
    coinbase = (cb['EUR'] ?? 0) + (cb['USD'] ?? 0) * 0.92 + (cb['USDC'] ?? 0) * 0.92 + (cb['USDT'] ?? 0) * 0.92;
  } catch { /* Coinbase indisponible */ }
  return { kraken, coinbase, total: kraken + coinbase };
}

// Routage intelligent des achats :
// - préfère Kraken (frais 0.26% vs 0.6% Coinbase) SI Kraken peut couvrir le montant plein
//   en gardant 5% de réserve (amount <= cash * 0.95)
// - sinon bascule sur Coinbase si lui peut couvrir
// - sinon null (aucun exchange ne peut payer le montant plein -> SKIP, pas d'exécution partielle qui vide un exchange)
export async function chooseExchangeForBuy(
  symbol: string,
  amountEur: number
): Promise<{ exchange: 'kraken' | 'coinbase' | null; krakenCash: number; coinbaseCash: number; reason: string }> {
  const onKraken = Boolean(SYMBOL_TO_KRAKEN_PAIR[symbol]);
  const onCoinbase = Boolean(SYMBOL_TO_COINBASE_PRODUCT[symbol]);
  if (!onKraken && !onCoinbase) {
    return { exchange: null, krakenCash: 0, coinbaseCash: 0, reason: `${symbol} non disponible sur Kraken ou Coinbase` };
  }
  const { kraken, coinbase } = await getExchangeCash();
  const krakenFits = onKraken && kraken >= 5 && amountEur <= kraken * 0.95;
  const coinbaseFits = onCoinbase && coinbase >= 5 && amountEur <= coinbase * 0.95;
  if (krakenFits) {
    return { exchange: 'kraken', krakenCash: kraken, coinbaseCash: coinbase, reason: `Kraken peut couvrir ${amountEur.toFixed(2)}€ (solde ${kraken.toFixed(2)}€)` };
  }
  if (coinbaseFits) {
    const why = onKraken
      ? `Kraken insuffisant (${kraken.toFixed(2)}€) pour ${amountEur.toFixed(2)}€ -> bascule Coinbase`
      : `Symbol non listé sur Kraken -> Coinbase`;
    return { exchange: 'coinbase', krakenCash: kraken, coinbaseCash: coinbase, reason: `${why} (solde ${coinbase.toFixed(2)}€)` };
  }
  return {
    exchange: null, krakenCash: kraken, coinbaseCash: coinbase,
    reason: `Aucun exchange ne peut couvrir ${amountEur.toFixed(2)}€ en gardant 5% de réserve (Kraken: ${kraken.toFixed(2)}€, Coinbase: ${coinbase.toFixed(2)}€)`,
  };
}

// Minimums exchange : en dessous, Kraken rejette avec
// "Egeneral: Invalid arguments: volume minimum not met"
export const MIN_SELL_EUR = 5;
// Volumes minimums approximatifs par asset (sécurité, le notionnel € reste le garde principal)
export const MIN_VOLUME_PER_SYMBOL: Record<string, number> = {
  BTC: 0.0001, ETH: 0.002, SOL: 0.02, ADA: 5, DOT: 1, AVAX: 0.2,
  LINK: 0.5, UNI: 0.5, AAVE: 0.05, LTC: 0.05, XRP: 10, MATIC: 5,
  ARB: 2, OP: 2, NEAR: 1, ALGO: 10,
};

export function isDustSell(symbol: string, cryptoAmount: number, sellValueEur: number): string | null {
  if (sellValueEur < MIN_SELL_EUR) {
    return `Poussière ignorée: vente ${symbol} de ${sellValueEur.toFixed(2)}€ < ${MIN_SELL_EUR}€ minimum exchange`;
  }
  const minVol = MIN_VOLUME_PER_SYMBOL[symbol] ?? 0.0001;
  if (cryptoAmount < minVol) {
    return `Poussière ignorée: volume ${cryptoAmount.toFixed(8)} ${symbol} < minimum ${minVol}`;
  }
  return null;
}

export async function executeLiveTrade(
  decision: BotDecision,
  currentPrice: MarketData,
  eurUsdRate: number
): Promise<{ success: boolean; message: string; txid?: string; exchange?: 'kraken' | 'coinbase' }> {

  const PLATFORM_FEE_RATE_KRAKEN = 0.0026;
  const PLATFORM_FEE_RATE_COINBASE = 0.006;

  try {
    if (decision.action === 'BUY') {
      // Routage intelligent: préfère Kraken (frais faibles), bascule sur Coinbase
      // si Kraken ne peut pas couvrir le montant plein. Ne jamais exécuter un
      // montant partiel qui viderait un exchange : si aucun ne couvre -> SKIP.
      const routing = await chooseExchangeForBuy(decision.symbol, decision.amount_eur);
      if (!routing.exchange) return { success: false, message: routing.reason };
      const exchange = routing.exchange;

      const PLATFORM_FEE_RATE = exchange === 'kraken' ? PLATFORM_FEE_RATE_KRAKEN : PLATFORM_FEE_RATE_COINBASE;
      const actualAmount = decision.amount_eur;
      const fee = actualAmount * PLATFORM_FEE_RATE;
      let txid: string | undefined;

      if (exchange === 'kraken') {
        const pair = SYMBOL_TO_KRAKEN_PAIR[decision.symbol];
        const result = await placeKrakenOrder(pair, 'buy', ((actualAmount - fee) / currentPrice.price_eur).toFixed(8));
        txid = result.txid[0];
      } else {
        const productId = SYMBOL_TO_COINBASE_PRODUCT[decision.symbol];
        const result = await placeCoinbaseOrder(productId, 'BUY', actualAmount.toFixed(2));
        txid = result.order_id;
      }

      const cryptoAmount = (actualAmount - fee) / currentPrice.price_eur;
      await db`INSERT INTO trades (symbol, action, amount, price_eur, price_usd, eur_usd_rate, total_eur, fee_eur, mode, reasoning, confidence, env)
        VALUES (${decision.symbol}, 'BUY', ${cryptoAmount}, ${currentPrice.price_eur}, ${currentPrice.price_usd}, ${eurUsdRate}, ${actualAmount}, ${fee}, 'live', ${decision.reasoning}, ${decision.confidence}, 'live')`;

      // Avg d'achat AVANT le sync (le sync écrase les montants depuis l'exchange)
      const prevRows = (await db`SELECT amount, avg_buy_price_eur FROM portfolio WHERE symbol = ${decision.symbol} AND env = 'live'`) as Row[];
      const prevAvg = prevRows.length > 0 ? parseFloat(String(prevRows[0].avg_buy_price_eur ?? 0)) : 0;

      // Sync BOTH : un sync mono-exchange supprimerait de la DB les positions
      // détenues sur l'autre exchange (la suppression se base sur les symboles absents)
      await syncPortfolioFromExchange('both');

      // Prix moyen pondéré (le coût réel inclut les frais : actualAmount).
      // Si l'ancien avg est inconnu (0), on prend le coût unitaire du nouveau lot
      // plutôt que de diluer avec 0.
      const syncedRows = (await db`SELECT amount FROM portfolio WHERE symbol = ${decision.symbol} AND env = 'live'`) as Row[];
      const syncedAmount = syncedRows.length > 0 ? parseFloat(String(syncedRows[0].amount ?? 0)) : 0;
      if (syncedAmount > 0.000001) {
        const baseAmount = Math.max(0, syncedAmount - cryptoAmount);
        const newAvg = baseAmount > 0.000001 && prevAvg > 0
          ? (baseAmount * prevAvg + actualAmount) / syncedAmount
          : actualAmount / Math.max(cryptoAmount, 1e-12);
        if (newAvg > 0) {
          await db`UPDATE portfolio SET avg_buy_price_eur = ${newAvg}, updated_at = NOW() WHERE symbol = ${decision.symbol} AND env = 'live'`;
        }
      }
      return { success: true, message: `[LIVE] Acheté ${cryptoAmount.toFixed(6)} ${decision.symbol} à ${currentPrice.price_eur.toFixed(4)}€ sur ${exchange} (${routing.reason})`, txid, exchange };
    }

    if (decision.action === 'SELL') {
      // For SELL: find where the asset actually is (check both exchanges)
      let exchange: 'kraken' | 'coinbase' | null = null;
      let holdingAmount = 0;

      // Check DB first
      const holdingResult = (await db`SELECT * FROM portfolio WHERE symbol = ${decision.symbol} AND env = 'live'`) as Row[];
      if (holdingResult.length > 0 && parseFloat(String(holdingResult[0].amount ?? 0)) > 0) {
        holdingAmount = parseFloat(String(holdingResult[0].amount));
        // Determine exchange from which exchange has this pair
        exchange = SYMBOL_TO_KRAKEN_PAIR[decision.symbol] ? 'kraken' : 'coinbase';
      }

      // Not in DB — check real exchange balances
      if (holdingAmount <= 0.000001) {
        // Check Kraken first
        if (SYMBOL_TO_KRAKEN_PAIR[decision.symbol]) {
          try {
            const kb = await getKrakenBalance();
            if ((kb[decision.symbol] ?? 0) > 0.000001) {
              holdingAmount = kb[decision.symbol];
              exchange = 'kraken';
            }
          } catch {}
        }
        // Then Coinbase
        if (holdingAmount <= 0.000001 && SYMBOL_TO_COINBASE_PRODUCT[decision.symbol]) {
          try {
            const cb = await getCoinbaseBalance();
            if ((cb[decision.symbol] ?? 0) > 0.000001) {
              holdingAmount = cb[decision.symbol];
              exchange = 'coinbase';
            }
          } catch {}
        }
      }

      if (holdingAmount <= 0.000001 || !exchange) {
        return { success: false, message: `Aucune position ${decision.symbol} trouvée sur Kraken ou Coinbase` };
      }

      const PLATFORM_FEE_RATE = exchange === 'kraken' ? PLATFORM_FEE_RATE_KRAKEN : PLATFORM_FEE_RATE_COINBASE;
      const sellValue = Math.min(decision.amount_eur, holdingAmount * currentPrice.price_eur);
      const cryptoToSell = sellValue / currentPrice.price_eur;
      // Garde-fou final juste avant l'appel API : ne jamais envoyer une poussière à Kraken/Coinbase
      const dustReason = isDustSell(decision.symbol, cryptoToSell, sellValue);
      if (dustReason) {
        console.log(`[LiveTrader] ${dustReason}`);
        return { success: false, message: dustReason };
      }
      const fee = sellValue * PLATFORM_FEE_RATE;
      const eurReceived = sellValue - fee;
      let txid: string | undefined;

      if (exchange === 'kraken') {
        const pair = SYMBOL_TO_KRAKEN_PAIR[decision.symbol];
        const result = await placeKrakenOrder(pair, 'sell', cryptoToSell.toFixed(8));
        txid = result.txid[0];
      } else {
        const productId = SYMBOL_TO_COINBASE_PRODUCT[decision.symbol];
        const result = await placeCoinbaseOrder(productId, 'SELL', undefined, cryptoToSell.toFixed(8));
        txid = result.order_id;
      }

      await db`INSERT INTO trades (symbol, action, amount, price_eur, price_usd, eur_usd_rate, total_eur, fee_eur, mode, reasoning, confidence, env)
        VALUES (${decision.symbol}, 'SELL', ${cryptoToSell}, ${currentPrice.price_eur}, ${currentPrice.price_usd}, ${eurUsdRate}, ${eurReceived}, ${fee}, 'live', ${decision.reasoning}, ${decision.confidence}, 'live')`;
      // Sync BOTH : un sync mono-exchange supprimerait de la DB les positions
      // détenues sur l'autre exchange (l'avg d'achat, lui, ne change pas à la vente)
      await syncPortfolioFromExchange('both');
      return { success: true, message: `[LIVE] Vendu ${cryptoToSell.toFixed(6)} ${decision.symbol} à ${currentPrice.price_eur.toFixed(4)}€ sur ${exchange}`, txid };
    }

    return { success: true, message: `Action ${decision.action} — pas d'exécution` };
  } catch (error) {
    console.error(`[LiveTrader] Error:`, error);
    return { success: false, message: `Erreur: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function syncPortfolioFromExchange(
  exchange: 'kraken' | 'coinbase' | 'both' = 'both'
): Promise<void> {
  try {
    let balances: Record<string, number> = {};

    if (exchange === 'kraken' || exchange === 'both') {
      const krakenBalances = await getKrakenBalance();
      for (const [symbol, amount] of Object.entries(krakenBalances)) {
        balances[symbol] = (balances[symbol] ?? 0) + amount;
      }
    }

    if (exchange === 'coinbase' || exchange === 'both') {
      try {
        const coinbaseBalances = await getCoinbaseBalance();
        for (const [symbol, amount] of Object.entries(coinbaseBalances)) {
          balances[symbol] = (balances[symbol] ?? 0) + amount;
        }
      } catch { /* Coinbase might not be configured */ }
    }

    if (Object.keys(balances).length === 0) return;

    for (const [symbol, amount] of Object.entries(balances)) {
      if (symbol === 'EUR' || symbol === 'USD') {
        await db`
          INSERT INTO portfolio (currency, symbol, amount, avg_buy_price_eur, env)
          VALUES ('EUR', 'EUR', ${amount}, 1, 'live')
          ON CONFLICT (symbol, env) DO UPDATE SET amount = ${amount}, updated_at = NOW()
        `;
      } else {
        const existing = (await db`
          SELECT avg_buy_price_eur FROM portfolio WHERE symbol = ${symbol} AND env = 'live'
        `) as Row[];

        if (existing.length > 0) {
          await db`UPDATE portfolio SET amount = ${amount}, updated_at = NOW() WHERE symbol = ${symbol} AND env = 'live'`;
        } else if (amount > 0.000001) {
          await db`
            INSERT INTO portfolio (currency, symbol, amount, avg_buy_price_eur, env)
            VALUES ('CRYPTO', ${symbol}, ${amount}, 0, 'live')
            ON CONFLICT (symbol, env) DO UPDATE SET amount = ${amount}, updated_at = NOW()
          `;
        }
      }
    }

    // Remove live positions no longer on exchange
    const dbHoldings = (await db`SELECT symbol FROM portfolio WHERE symbol != 'EUR' AND env = 'live'`) as Row[];
    for (const holding of dbHoldings) {
      const sym = String(holding.symbol);
      if (!balances[sym] || balances[sym] < 0.000001) {
        await db`DELETE FROM portfolio WHERE symbol = ${sym} AND env = 'live'`;
      }
    }

    console.log(`[Sync] Portfolio synced from ${exchange}:`, Object.keys(balances).join(', '));
  } catch (error) {
    console.error('[Sync] Portfolio sync error:', error);
  }
}

export async function getConsolidatedBalance(): Promise<{
  kraken: Record<string, number>;
  coinbase: Record<string, number>;
  total: Record<string, number>;
}> {
  let krakenBal: Record<string, number> = {};
  let coinbaseBal: Record<string, number> = {};

  try { krakenBal = await getKrakenBalance(); } catch {}
  try { coinbaseBal = await getCoinbaseBalance(); } catch {}

  const total: Record<string, number> = {};
  for (const [k, v] of Object.entries(krakenBal)) total[k] = (total[k] ?? 0) + v;
  for (const [k, v] of Object.entries(coinbaseBal)) total[k] = (total[k] ?? 0) + v;

  return { kraken: krakenBal, coinbase: coinbaseBal, total };
}
