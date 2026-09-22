import { sqlForContext } from '../db';
import { BotDecision, MarketData } from '../types';
import {
  placeKrakenOrder,
  getKrakenBalance,
  resolveKrakenPair,
  SYMBOL_TO_KRAKEN_PAIR,
} from './kraken';
import {
  placeCoinbaseOrder,
  getCoinbaseBalance,
  isCoinbaseProductTradable,
  SYMBOL_TO_COINBASE_PRODUCT,
} from './coinbase';

// Message d'erreur compact : évite de déverser l'objet Axios entier dans les logs
// (extrait le message API, ex. "Invalid product_id", quand il existe)
export function formatLiveError(error: unknown): string {
  const responseData = (error as { response?: { data?: unknown } })?.response?.data;
  if (responseData && typeof responseData === 'object') {
    const d = responseData as Record<string, unknown>;
    const msg = [d.message ?? d.error, d.error_details]
      .filter(v => typeof v === 'string' && (v as string).length > 0)
      .join(' — ');
    if (msg) return msg;
  }
  return error instanceof Error ? error.message : String(error);
}

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
    kraken = (kb['EUR'] ?? 0) + (kb['EURC'] ?? 0) + (kb['EURS'] ?? 0)
      + (kb['USD'] ?? 0) * 0.92 + (kb['USDC'] ?? 0) * 0.92 + (kb['USDT'] ?? 0) * 0.92;
  } catch { /* Kraken indisponible */ }
  try {
    const cb = await getCoinbaseBalance();
    coinbase = (cb['EUR'] ?? 0) + (cb['EURC'] ?? 0) + (cb['EURS'] ?? 0)
      + (cb['USD'] ?? 0) * 0.92 + (cb['USDC'] ?? 0) * 0.92 + (cb['USDT'] ?? 0) * 0.92;
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
  // Kraken : mapping statique + découverte dynamique des paires EUR
  // (endpoint public). Coinbase : mapping + vérification produit ci-dessous.
  const krakenPair = await resolveKrakenPair(symbol);
  const onKraken = Boolean(krakenPair);
  const onCoinbase = Boolean(SYMBOL_TO_COINBASE_PRODUCT[symbol]);
  if (!onKraken && !onCoinbase) {
    return { exchange: null, krakenCash: 0, coinbaseCash: 0, reason: `${symbol} non disponible sur Kraken ou Coinbase` };
  }
  const { kraken, coinbase } = await getExchangeCash();
  // Dispo produit Coinbase (varie selon compte/région : ex. NEAR-EUR peut être rejeté)
  let coinbaseProductOk = false;
  let coinbaseProductReason = '';
  if (onCoinbase) {
    const productId = SYMBOL_TO_COINBASE_PRODUCT[symbol];
    coinbaseProductOk = await isCoinbaseProductTradable(productId);
    if (!coinbaseProductOk) coinbaseProductReason = `${productId} non listé/tradable sur Coinbase (compte/région)`;
  }
  const krakenFits = onKraken && kraken >= 5 && amountEur <= kraken * 0.95;
  const coinbaseFits = onCoinbase && coinbaseProductOk && coinbase >= 5 && amountEur <= coinbase * 0.95;
  if (krakenFits) {
    return { exchange: 'kraken', krakenCash: kraken, coinbaseCash: coinbase, reason: `Kraken peut couvrir ${amountEur.toFixed(2)}€ (solde ${kraken.toFixed(2)}€)` };
  }
  if (coinbaseFits) {
    const why = onKraken
      ? `Kraken insuffisant (${kraken.toFixed(2)}€) pour ${amountEur.toFixed(2)}€ -> bascule Coinbase`
      : `Symbol non listé sur Kraken -> Coinbase`;
    return { exchange: 'coinbase', krakenCash: kraken, coinbaseCash: coinbase, reason: `${why} (solde ${coinbase.toFixed(2)}€)` };
  }
  const blocks: string[] = [];
  if (onKraken) blocks.push(`Kraken: ${kraken.toFixed(2)}€ (insuffisant)`);
  else blocks.push('Kraken: symbole non listé');
  if (!onCoinbase) blocks.push('Coinbase: symbole non listé');
  else if (!coinbaseProductOk) blocks.push(`Coinbase: ${coinbaseProductReason}`);
  else blocks.push(`Coinbase: ${coinbase.toFixed(2)}€ (insuffisant)`);
  return {
    exchange: null, krakenCash: kraken, coinbaseCash: coinbase,
    reason: `Achat ${symbol} ${amountEur.toFixed(2)}€ impossible — ${blocks.join(' ; ')}`,
  };
}

// Minimums exchange : en dessous, Kraken rejette avec
// "Egeneral: Invalid arguments: volume minimum not met"
export const MIN_SELL_EUR = 5;
// Volumes minimums approximatifs par asset (sécurité, le notionnel € reste le garde principal)
export const MIN_VOLUME_PER_SYMBOL: Record<string, number> = {
  BTC: 0.0001, ETH: 0.002, SOL: 0.02, ADA: 5, DOT: 1, AVAX: 0.2,
  LINK: 0.5, UNI: 0.5, AAVE: 0.05, LTC: 0.05, XRP: 10, MATIC: 5,
  ARB: 2, OP: 2, NEAR: 1, ALGO: 10, CRV: 2, MKR: 0.005,
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

export interface LiveTradeResult {
  success: boolean;
  message: string;
  txid?: string;
  exchange?: 'kraken' | 'coinbase';
  // Net EUR crédité par exchange (ventes splittées sur les deux)
  split?: { kraken: number; coinbase: number };
}

export async function executeLiveTrade(
  decision: BotDecision,
  currentPrice: MarketData,
  eurUsdRate: number
): Promise<LiveTradeResult> {

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
        const pair = (await resolveKrakenPair(decision.symbol)) ?? SYMBOL_TO_KRAKEN_PAIR[decision.symbol];
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
          // Renfort de position : l'échelle des TP repart de zéro (flag partiel reset).
          // Fallback sans flag si la migration n'a pas été jouée.
          try {
            await db`UPDATE portfolio SET avg_buy_price_eur = ${newAvg}, partial_tp_taken = FALSE, updated_at = NOW() WHERE symbol = ${decision.symbol} AND env = 'live'`;
          } catch {
            await db`UPDATE portfolio SET avg_buy_price_eur = ${newAvg}, updated_at = NOW() WHERE symbol = ${decision.symbol} AND env = 'live'`;
          }
        }
      }
      return { success: true, message: `[LIVE] Acheté ${cryptoAmount.toFixed(6)} ${decision.symbol} à ${currentPrice.price_eur.toFixed(4)}€ sur ${exchange} (${routing.reason})`, txid, exchange };
    }

    if (decision.action === 'SELL') {
      // Vente multi-exchange : l'actif peut être réparti sur Kraken ET Coinbase
      // (ex: UNI des deux côtés). On vend jambe par jambe, Kraken d'abord
      // (frais faibles), en sautant les reliquats poussière (< 5€).
      const krakenPair = await resolveKrakenPair(decision.symbol);
      const coinbaseProduct = SYMBOL_TO_COINBASE_PRODUCT[decision.symbol] ?? null;

      let krakenHolding = 0;
      let coinbaseHolding = 0;
      if (krakenPair) {
        try { krakenHolding = (await getKrakenBalance())[decision.symbol] ?? 0; } catch {}
      }
      if (coinbaseProduct) {
        try { coinbaseHolding = (await getCoinbaseBalance())[decision.symbol] ?? 0; } catch {}
      }
      const totalHolding = krakenHolding + coinbaseHolding;
      if (totalHolding <= 0.000001) {
        return { success: false, message: `Aucune position ${decision.symbol} trouvée sur Kraken ou Coinbase` };
      }

      // Cap au réellement détenu (tous exchanges confondus)
      const targetEur = Math.min(decision.amount_eur, totalHolding * currentPrice.price_eur);
      if (targetEur < MIN_SELL_EUR) {
        return { success: false, message: `Poussière ignorée: vente ${decision.symbol} de ${targetEur.toFixed(2)}€ < ${MIN_SELL_EUR}€ minimum exchange` };
      }

      // Construction des jambes (Kraken d'abord)
      const sources: Array<{ exchange: 'kraken' | 'coinbase'; availCrypto: number; feeRate: number }> = [];
      if (krakenPair && krakenHolding > 1e-9) {
        sources.push({ exchange: 'kraken', availCrypto: krakenHolding, feeRate: PLATFORM_FEE_RATE_KRAKEN });
      }
      if (coinbaseProduct && coinbaseHolding > 1e-9) {
        sources.push({ exchange: 'coinbase', availCrypto: coinbaseHolding, feeRate: PLATFORM_FEE_RATE_COINBASE });
      }

      const legs: Array<{ exchange: 'kraken' | 'coinbase'; crypto: number; eur: number; feeRate: number }> = [];
      const dropped: string[] = [];
      let remaining = targetEur;
      for (let i = 0; i < sources.length && remaining > 0; i++) {
        const s = sources[i];
        const laterAvailEur = sources.slice(i + 1)
          .reduce((sum, o) => sum + o.availCrypto * currentPrice.price_eur, 0);
        const takeEur = Math.min(remaining, s.availCrypto * currentPrice.price_eur);
        if (takeEur <= 0) continue;
        if (takeEur < MIN_SELL_EUR) {
          // Reliquat trop petit : reporté sur les exchanges suivants si possible,
          // abandonné si c'est le dernier bout, sinon vente partielle sur la suite
          if (remaining <= laterAvailEur + 1e-9) continue;
          if (takeEur >= remaining - 1e-9) {
            dropped.push(`reliquat ${takeEur.toFixed(2)}€ sur ${s.exchange} < ${MIN_SELL_EUR}€, abandonné`);
            remaining = 0;
            continue;
          }
          continue;
        }
        const crypto = takeEur / currentPrice.price_eur;
        const dustReason = isDustSell(decision.symbol, crypto, takeEur);
        if (dustReason) {
          console.log(`[LiveTrader] ${dustReason}`);
          dropped.push(dustReason);
          continue;
        }
        legs.push({ exchange: s.exchange, crypto, eur: takeEur, feeRate: s.feeRate });
        remaining -= takeEur;
      }

      if (legs.length === 0) {
        return { success: false, message: `Vente ${decision.symbol} impossible : ${dropped.join(' ; ') || 'montants sous les minimums exchange'}` };
      }

      // Exécution jambe par jambe (une ligne de trade par jambe, pour traçabilité)
      let txid: string | undefined;
      const done: Array<{ exchange: 'kraken' | 'coinbase'; crypto: number; net: number; fee: number }> = [];
      const errors: string[] = [];
      for (const leg of legs) {
        try {
          const fee = leg.eur * leg.feeRate;
          const net = leg.eur - fee;
          if (leg.exchange === 'kraken') {
            const pair = (await resolveKrakenPair(decision.symbol)) ?? SYMBOL_TO_KRAKEN_PAIR[decision.symbol];
            const result = await placeKrakenOrder(pair, 'sell', leg.crypto.toFixed(8));
            txid = txid ?? result.txid[0];
          } else {
            const productId = SYMBOL_TO_COINBASE_PRODUCT[decision.symbol];
            const result = await placeCoinbaseOrder(productId, 'SELL', undefined, leg.crypto.toFixed(8));
            txid = txid ?? result.order_id;
          }
          await db`INSERT INTO trades (symbol, action, amount, price_eur, price_usd, eur_usd_rate, total_eur, fee_eur, mode, reasoning, confidence, env)
            VALUES (${decision.symbol}, 'SELL', ${leg.crypto}, ${currentPrice.price_eur}, ${currentPrice.price_usd}, ${eurUsdRate}, ${net}, ${fee}, 'live', ${decision.reasoning + ` (via ${leg.exchange})`}, ${decision.confidence}, 'live')`;
          done.push({ exchange: leg.exchange, crypto: leg.crypto, net, fee });
        } catch (e) {
          errors.push(`${leg.exchange}: ${formatLiveError(e)}`);
        }
      }

      if (done.length > 0) {
        // L'avg d'achat ne change pas à la vente (moyenne conservée sur le reliquat).
        // Vente partielle (TP 50%) : on lève le flag pour viser le palier 2 ensuite.
        await syncPortfolioFromExchange('both');
        if (decision.partial) {
          try {
            await db`UPDATE portfolio SET partial_tp_taken = TRUE, updated_at = NOW() WHERE symbol = ${decision.symbol} AND env = 'live'`;
          } catch { /* colonne absente pré-migration : non-bloquant */ }
        }
      } else {
        return { success: false, message: `Vente ${decision.symbol} échouée : ${errors.join(' ; ')}` };
      }

      const netKraken = done.filter(d => d.exchange === 'kraken').reduce((s, d) => s + d.net, 0);
      const netCoinbase = done.filter(d => d.exchange === 'coinbase').reduce((s, d) => s + d.net, 0);
      const soldCrypto = done.reduce((s, d) => s + d.crypto, 0);
      const soldGross = done.reduce((s, d) => s + d.net + d.fee, 0);
      const shortfall = targetEur - soldGross;
      const where = [...new Set(done.map(d => d.exchange))].join(' + ');
      const dominant = netKraken >= netCoinbase ? 'kraken' as const : 'coinbase' as const;

      const parts = [`[LIVE] Vendu ${soldCrypto.toFixed(6)} ${decision.symbol} à ${currentPrice.price_eur.toFixed(4)}€ sur ${where}`];
      if (shortfall > 0.01) parts.push(`(partiel : ${shortfall.toFixed(2)}€ non vendus)`);
      if (dropped.length > 0) parts.push(`(${dropped.join(' ; ')})`);
      if (errors.length > 0) parts.push(`(erreurs : ${errors.join(' ; ')})`);
      return {
        success: true,
        message: parts.join(' '),
        txid,
        exchange: dominant,
        split: { kraken: netKraken, coinbase: netCoinbase },
      };
    }

    return { success: true, message: `Action ${decision.action} — pas d'exécution` };
  } catch (error) {
    const msg = formatLiveError(error);
    console.error(`[LiveTrader] Error ${decision.action} ${decision.symbol}:`, msg);
    return { success: false, message: `Erreur ${decision.symbol}: ${msg}` };
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
