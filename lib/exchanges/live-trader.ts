import { sqlForContext } from '../db';
import { BotDecision, MarketData } from '../types';
import {
  placeKrakenOrder,
  getKrakenBalance,
  getKrakenOrder,
  resolveKrakenPair,
  clearKrakenBalanceCache,
  SYMBOL_TO_KRAKEN_PAIR,
} from './kraken';
import {
  placeCoinbaseOrder,
  getCoinbaseBalance,
  getCoinbaseOrder,
  isCoinbaseProductTradable,
  clearCoinbaseBalanceCache,
  SYMBOL_TO_COINBASE_PRODUCT,
} from './coinbase';
import { ExchangeFill, computeTradeAccounting } from '../trade-accounting';
import { claimOrderIntent, finishOrderIntent, isMissingSchemaError } from '../order-intents';
import { claimPartialTp, releasePartialTp } from '../partial-tp';
import { getCycleLockOwner } from '../cycle-lock';

// Message d'erreur compact : Ã©vite de dÃ©verser l'objet Axios entier dans les logs
// (extrait le message API, ex. "Invalid product_id", quand il existe)
export function formatLiveError(error: unknown): string {
  const responseData = (error as { response?: { data?: unknown } })?.response?.data;
  if (responseData && typeof responseData === 'object') {
    const d = responseData as Record<string, unknown>;
    const msg = [d.message ?? d.error, d.error_details]
      .filter(v => typeof v === 'string' && (v as string).length > 0)
      .join(' â€” ');
    if (msg) return msg;
  }
  return error instanceof Error ? error.message : String(error);
}

type Row = Record<string, unknown>;

// Live trader always writes to PROD DB
const db = sqlForContext('prod');

// Cash EUR disponible par exchange (EUR + stablecoins valorisÃ©s ~0.92â‚¬).
// UtilisÃ© pour router les BUY vers l'exchange qui peut rÃ©ellement payer,
// au lieu de raisonner sur un cash total consolidÃ©.
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

// TolÃ©rance poussiÃ¨re : en dessous, on ajuste au solde plutÃ´t que de basculer
// d'exchange (une bascule pour 0.11â‚¬ coÃ»terait plus cher en frais que l'Ã©cart)
const ROUTING_DUST_EUR = 2;

// Routage intelligent des achats :
// - prÃ©fÃ¨re Kraken (frais 0.26% vs 0.6% Coinbase) SI Kraken peut couvrir le montant plein
//   en gardant 5% de rÃ©serve (amount <= cash * 0.95)
// - si l'Ã©cart n'est que poussiÃ¨re (< 2â‚¬ sous le solde brut), on ajuste le montant
//   au solde et on reste (frais faibles) au lieu de basculer pour des centimes
// - sinon bascule sur Coinbase si lui peut couvrir
// - sinon null (aucun exchange ne peut payer le montant plein -> SKIP, pas d'exÃ©cution partielle qui vide un exchange)
export async function chooseExchangeForBuy(
  symbol: string,
  amountEur: number,
  // Exchange Ã  exclure (retry aprÃ¨s un Ã©chec "fonds insuffisants" dessus)
  exclude?: 'kraken' | 'coinbase'
): Promise<{ exchange: 'kraken' | 'coinbase' | null; krakenCash: number; coinbaseCash: number; reason: string; cappedAmount?: number }> {
  // Kraken : mapping statique + dÃ©couverte dynamique des paires EUR
  // (endpoint public). Coinbase : mapping + vÃ©rification produit ci-dessous.
  const krakenPair = await resolveKrakenPair(symbol);
  const onKraken = Boolean(krakenPair);
  const onCoinbase = Boolean(SYMBOL_TO_COINBASE_PRODUCT[symbol]);
  if (!onKraken && !onCoinbase) {
    return { exchange: null, krakenCash: 0, coinbaseCash: 0, reason: `${symbol} non disponible sur Kraken ou Coinbase` };
  }
  const { kraken, coinbase } = await getExchangeCash();
  // Dispo produit Coinbase (varie selon compte/rÃ©gion : ex. NEAR-EUR peut Ãªtre rejetÃ©)
  let coinbaseProductOk = false;
  let coinbaseProductReason = '';
  if (onCoinbase) {
    const productId = SYMBOL_TO_COINBASE_PRODUCT[symbol];
    coinbaseProductOk = await isCoinbaseProductTradable(productId);
    if (!coinbaseProductOk) coinbaseProductReason = `${productId} non listÃ©/tradable sur Coinbase (compte/rÃ©gion)`;
  }
  const krakenFits = onKraken && exclude !== 'kraken' && kraken >= 5 && amountEur <= kraken * 0.95;
  const coinbaseFits = onCoinbase && exclude !== 'coinbase' && coinbaseProductOk && coinbase >= 5 && amountEur <= coinbase * 0.95;
  if (krakenFits) {
    return { exchange: 'kraken', krakenCash: kraken, coinbaseCash: coinbase, reason: `Kraken peut couvrir ${amountEur.toFixed(2)}â‚¬ (solde ${kraken.toFixed(2)}â‚¬)` };
  }
  // Ã‰cart poussiÃ¨re sur Kraken (ex: 205.27â‚¬ demandÃ©s, 205.16â‚¬ dispo) : on ajuste
  // au solde brut et on reste sur Kraken plutÃ´t que payer plus cher sur Coinbase
  if (onKraken && exclude !== 'kraken' && kraken >= 5 && amountEur > kraken * 0.95 && amountEur - kraken <= ROUTING_DUST_EUR) {
    const capped = Math.floor(kraken * 100) / 100;
    if (capped >= 5) {
      return { exchange: 'kraken', krakenCash: kraken, coinbaseCash: coinbase, cappedAmount: capped, reason: `Montant ajustÃ© Ã  ${capped.toFixed(2)}â‚¬ pour tenir sur Kraken (solde ${kraken.toFixed(2)}â‚¬, frais rÃ©duits)` };
    }
  }
  if (coinbaseFits) {
    const why = onKraken
      ? `Kraken insuffisant (${kraken.toFixed(2)}â‚¬) pour ${amountEur.toFixed(2)}â‚¬ -> bascule Coinbase`
      : `Symbol non listÃ© sur Kraken -> Coinbase`;
    return { exchange: 'coinbase', krakenCash: kraken, coinbaseCash: coinbase, reason: `${why} (solde ${coinbase.toFixed(2)}â‚¬)` };
  }
  // MÃªme tolÃ©rance cÃ´tÃ© Coinbase avant de dÃ©clarer forfait
  if (onCoinbase && exclude !== 'coinbase' && coinbaseProductOk && coinbase >= 5 && amountEur > coinbase * 0.95 && amountEur - coinbase <= ROUTING_DUST_EUR) {
    const capped = Math.floor(coinbase * 100) / 100;
    if (capped >= 5) {
      return { exchange: 'coinbase', krakenCash: kraken, coinbaseCash: coinbase, cappedAmount: capped, reason: `Montant ajustÃ© Ã  ${capped.toFixed(2)}â‚¬ pour tenir sur Coinbase (solde ${coinbase.toFixed(2)}â‚¬)` };
    }
  }
  const blocks: string[] = [];
  if (onKraken) blocks.push(`Kraken: ${kraken.toFixed(2)}â‚¬ (insuffisant)`);
  else blocks.push('Kraken: symbole non listÃ©');
  if (!onCoinbase) blocks.push('Coinbase: symbole non listÃ©');
  else if (!coinbaseProductOk) blocks.push(`Coinbase: ${coinbaseProductReason}`);
  else blocks.push(`Coinbase: ${coinbase.toFixed(2)}â‚¬ (insuffisant)`);
  return {
    exchange: null, krakenCash: kraken, coinbaseCash: coinbase,
    reason: `Achat ${symbol} ${amountEur.toFixed(2)}â‚¬ impossible â€” ${blocks.join(' ; ')}`,
  };
}

// Minimums exchange : en dessous, Kraken rejette avec
// "Egeneral: Invalid arguments: volume minimum not met"
export const MIN_SELL_EUR = 5;
// Volumes minimums approximatifs par asset (sÃ©curitÃ©, le notionnel â‚¬ reste le garde principal)
export const MIN_VOLUME_PER_SYMBOL: Record<string, number> = {
  BTC: 0.0001, ETH: 0.002, SOL: 0.02, ADA: 5, DOT: 1, AVAX: 0.2,
  LINK: 0.5, UNI: 0.5, AAVE: 0.05, LTC: 0.05, XRP: 10, MATIC: 5,
  ARB: 2, OP: 2, NEAR: 1, ALGO: 10, CRV: 2, MKR: 0.005,
};

export function isDustSell(symbol: string, cryptoAmount: number, sellValueEur: number): string | null {
  if (sellValueEur < MIN_SELL_EUR) {
    return `PoussiÃ¨re ignorÃ©e: vente ${symbol} de ${sellValueEur.toFixed(2)}â‚¬ < ${MIN_SELL_EUR}â‚¬ minimum exchange`;
  }
  const minVol = MIN_VOLUME_PER_SYMBOL[symbol] ?? 0.0001;
  if (cryptoAmount < minVol) {
    return `PoussiÃ¨re ignorÃ©e: volume ${cryptoAmount.toFixed(8)} ${symbol} < minimum ${minVol}`;
  }
  return null;
}

export interface LiveTradeResult {
  success: boolean;
  message: string;
  txid?: string;
  exchange?: 'kraken' | 'coinbase';
  // Net EUR crÃ©ditÃ© par exchange (ventes splittÃ©es sur les deux)
  split?: { kraken: number; coinbase: number };
  // Montant EUR rÃ©ellement dÃ©bitÃ© pour un BUY (diffÃ¨re de decision.amount_eur
  // si le routeur a ajustÃ© au solde Ã  quelques centimes prÃ¨s)
  chargedEur?: number;
}

const FEE_KRAKEN = 0.0026;
const FEE_COINBASE = 0.006;

interface SellLeg {
  exchange: 'kraken' | 'coinbase';
  crypto: number;
  eur: number;
  feeRate: number;
}

// Plancher Ã  8 dÃ©cimales (jamais d'arrondi vers le haut) : un volume arrondi
// 1 satoshi AU-DESSUS du solde rÃ©el => "Insufficient funds" chez Kraken.
function floor8(v: number): number {
  return Math.floor(v * 1e8) / 1e8;
}

// Soldes rÃ©els par exchange pour un symbole (fresh = bypass du cache 30s)
async function readSellHoldings(symbol: string, fresh: boolean): Promise<{
  krakenPair: string | null;
  coinbaseProduct: string | null;
  kraken: number;
  coinbase: number;
}> {
  const krakenPair = await resolveKrakenPair(symbol);
  const coinbaseProduct = SYMBOL_TO_COINBASE_PRODUCT[symbol] ?? null;
  let kraken = 0;
  let coinbase = 0;
  if (krakenPair) {
    try { kraken = (await getKrakenBalance(fresh ? { fresh: true } : undefined))[symbol] ?? 0; } catch {}
  }
  if (coinbaseProduct) {
    try { coinbase = (await getCoinbaseBalance(fresh ? { fresh: true } : undefined))[symbol] ?? 0; } catch {}
  }
  return { krakenPair, coinbaseProduct, kraken, coinbase };
}

// DÃ©coupe le montant cible en jambes par exchange (Kraken d'abord, frais faibles).
// Les volumes sont "floor" (jamais au-dessus du dÃ©tenu) et les reliquats
// poussiÃ¨re (< 5â‚¬) sont reportÃ©s ou abandonnÃ©s avec explication.
function buildSellLegs(
  symbol: string,
  priceEur: number,
  targetEur: number,
  krakenPair: string | null,
  coinbaseProduct: string | null,
  krakenHolding: number,
  coinbaseHolding: number,
): { legs: SellLeg[]; dropped: string[] } {
  const sources: Array<{ exchange: 'kraken' | 'coinbase'; availCrypto: number; feeRate: number }> = [];
  if (krakenPair && krakenHolding > 1e-9) {
    sources.push({ exchange: 'kraken', availCrypto: krakenHolding, feeRate: FEE_KRAKEN });
  }
  if (coinbaseProduct && coinbaseHolding > 1e-9) {
    sources.push({ exchange: 'coinbase', availCrypto: coinbaseHolding, feeRate: FEE_COINBASE });
  }

  const legs: SellLeg[] = [];
  const dropped: string[] = [];
  let remaining = targetEur;
  for (let i = 0; i < sources.length && remaining > 0; i++) {
    const s = sources[i];
    const laterAvailEur = sources.slice(i + 1)
      .reduce((sum, o) => sum + o.availCrypto * priceEur, 0);
    const takeEur = Math.min(remaining, s.availCrypto * priceEur);
    if (takeEur <= 0) continue;
    if (takeEur < MIN_SELL_EUR) {
      // Reliquat trop petit : reportÃ© sur les exchanges suivants si possible,
      // abandonnÃ© si c'est le dernier bout, sinon vente partielle sur la suite
      if (remaining <= laterAvailEur + 1e-9) continue;
      if (takeEur >= remaining - 1e-9) {
        dropped.push(`reliquat ${takeEur.toFixed(2)}â‚¬ sur ${s.exchange} < ${MIN_SELL_EUR}â‚¬, abandonnÃ©`);
        remaining = 0;
        continue;
      }
      continue;
    }
    // Jambe quasi-totale du dÃ©tenu sur cet exchange : on prend le solde exact
    // (floor), pas le montant calculÃ© (Ã©vite de dÃ©passer d'1 satoshi)
    const rawCrypto = takeEur / priceEur;
    const crypto = floor8(rawCrypto >= s.availCrypto * 0.9999 ? s.availCrypto : rawCrypto);
    if (crypto <= 0) {
      dropped.push(`volume nul aprÃ¨s arrondi sur ${s.exchange}, abandonnÃ©`);
      continue;
    }
    const dustReason = isDustSell(symbol, crypto, takeEur);
    if (dustReason) {
      console.log(`[LiveTrader] ${dustReason}`);
      dropped.push(dustReason);
      continue;
    }
    legs.push({ exchange: s.exchange, crypto, eur: takeEur, feeRate: s.feeRate });
    remaining -= takeEur;
  }
  return { legs, dropped };
}

interface SellDone {
  exchange: 'kraken' | 'coinbase';
  crypto: number;
  net: number;
  fee: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Attente courte du remplissage rÃ©el : un market order peut rester "open"
// quelques centaines de ms. 3 tentatives max, jamais de blocage long.
async function fetchKrakenFill(txid: string): Promise<ExchangeFill | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(attempt * 500);
    try {
      const order = await getKrakenOrder(txid);
      if (order && order.volExec > 0 && order.cost > 0) {
        return {
          volume: order.volExec,
          quoteCost: order.cost,
          feeEur: order.fee,
          fillPriceEur: order.avgPrice,
          closed: order.status === 'closed',
        };
      }
    } catch (e) {
      console.warn(`[LiveTrader] QueryOrders ${txid} Ã©chouÃ© (tentative ${attempt + 1}):`, formatLiveError(e));
    }
  }
  return null;
}

async function fetchCoinbaseFill(orderId: string): Promise<ExchangeFill | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(attempt * 500);
    try {
      const order = await getCoinbaseOrder(orderId);
      if (order && order.filledSize > 0 && order.filledValue > 0) {
        return {
          volume: order.filledSize,
          quoteCost: order.filledValue,
          feeEur: order.totalFees,
          fillPriceEur: order.avgPrice,
          closed: order.status === 'FILLED' || order.status === 'COMPLETED',
        };
      }
    } catch (e) {
      console.warn(`[LiveTrader] orders/historical ${orderId} Ã©chouÃ© (tentative ${attempt + 1}):`, formatLiveError(e));
    }
  }
  return null;
}

interface LiveTradeRow {
  symbol: string;
  action: 'BUY' | 'SELL';
  amount: number;
  priceEur: number;
  priceUsd: number;
  eurUsdRate: number;
  totalEur: number;
  feeEur: number;
  reasoning: string;
  confidence: number;
  exchange: 'kraken' | 'coinbase';
  externalOrderId?: string | null;
  feeSource: 'exchange' | 'estimate';
}

// InsÃ¨re la ligne de trade. Si la migration n'a pas encore ajoutÃ© les colonnes
// de traÃ§abilitÃ©, on retombe sur l'ancien schÃ©ma (les donnÃ©es restent Ã©crites).
async function insertLiveTradeRow(row: LiveTradeRow): Promise<void> {
  try {
    await db`INSERT INTO trades (symbol, action, amount, price_eur, price_usd, eur_usd_rate, total_eur, fee_eur, mode, reasoning, confidence, env, exchange, external_order_id, fee_source)
      VALUES (${row.symbol}, ${row.action}, ${row.amount}, ${row.priceEur}, ${row.priceUsd}, ${row.eurUsdRate}, ${row.totalEur}, ${row.feeEur}, 'live', ${row.reasoning}, ${row.confidence}, 'live', ${row.exchange}, ${row.externalOrderId ?? null}, ${row.feeSource})`;
  } catch (e) {
    if (!isMissingSchemaError(e)) throw e;
    await db`INSERT INTO trades (symbol, action, amount, price_eur, price_usd, eur_usd_rate, total_eur, fee_eur, mode, reasoning, confidence, env)
      VALUES (${row.symbol}, ${row.action}, ${row.amount}, ${row.priceEur}, ${row.priceUsd}, ${row.eurUsdRate}, ${row.totalEur}, ${row.feeEur}, 'live', ${row.reasoning}, ${row.confidence}, 'live')`;
  }
}

// ExÃ©cute les jambes (une ligne de trade par jambe, pour traÃ§abilitÃ©)
async function execSellLegs(
  symbol: string,
  currentPrice: { price_eur: number; price_usd: number },
  eurUsdRate: number,
  reasoning: string,
  confidence: number,
  legs: SellLeg[],
  cycleId: string,
): Promise<{ done: SellDone[]; errors: string[]; txid?: string }> {
  const done: SellDone[] = [];
  const errors: string[] = [];
  let txid: string | undefined;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const intentKey = `live:${cycleId}:${symbol}:SELL:${leg.exchange}:${leg.crypto.toFixed(8)}`;
    let externalId: string | undefined;
    try {
      const claimed = await claimOrderIntent(db, {
        idempotencyKey: intentKey,
        env: 'live',
        cycleId,
        symbol,
        action: 'SELL',
        exchange: leg.exchange,
        amountEur: leg.eur,
      });
      if (claimed === 'duplicate') {
        errors.push(`${leg.exchange}: vente ${leg.crypto.toFixed(8)} ${symbol} dÃ©jÃ  engagÃ©e (intent identique), non renvoyÃ©e`);
        continue;
      }

      if (leg.exchange === 'kraken') {
        const pair = (await resolveKrakenPair(symbol)) ?? SYMBOL_TO_KRAKEN_PAIR[symbol];
        const result = await placeKrakenOrder(pair, 'sell', leg.crypto.toFixed(8));
        externalId = result.txid[0];
      } else {
        const productId = SYMBOL_TO_COINBASE_PRODUCT[symbol];
        const result = await placeCoinbaseOrder(productId, 'SELL', undefined, leg.crypto.toFixed(8));
        externalId = result.order_id;
      }
      txid = txid ?? externalId;

      const fill = leg.exchange === 'kraken' && externalId
        ? await fetchKrakenFill(externalId)
        : externalId ? await fetchCoinbaseFill(externalId) : null;
      const accounting = computeTradeAccounting('SELL', fill, {
        priceEur: currentPrice.price_eur,
        budgetEur: leg.eur,
        feeRate: leg.feeRate,
      });

      await insertLiveTradeRow({
        symbol,
        action: 'SELL',
        amount: accounting.amount,
        priceEur: accounting.price_eur,
        priceUsd: currentPrice.price_usd,
        eurUsdRate,
        totalEur: accounting.total_eur,
        feeEur: accounting.fee_eur,
        reasoning: reasoning + ` (via ${leg.exchange})`,
        confidence,
        exchange: leg.exchange,
        externalOrderId: externalId,
        feeSource: accounting.fee_source,
      });
      await finishOrderIntent(db, intentKey, 'sent', externalId, null);
      done.push({ exchange: leg.exchange, crypto: accounting.amount, net: accounting.total_eur, fee: accounting.fee_eur });
    } catch (e) {
      const message = formatLiveError(e);
      errors.push(`${leg.exchange}: ${message}`);
      const retryable = /insufficient funds/i.test(message);
      try {
        await finishOrderIntent(db, intentKey, retryable ? 'failed_retryable' : 'failed', externalId, message);
      } catch { /* ne masque pas l'erreur exchange */ }
    }
  }
  return { done, errors, txid };
}

export async function executeLiveTrade(
  decision: BotDecision,
  currentPrice: MarketData,
  eurUsdRate: number,
  cycleIdParam?: string
): Promise<LiveTradeResult> {

  const PLATFORM_FEE_RATE_KRAKEN = 0.0026;
  const PLATFORM_FEE_RATE_COINBASE = 0.006;
  // Identifiant du cycle : fourni par l'appelant, sinon lu sur le verrou dÃ©tenu
  // (Ã©vite de modifier les routes existantes). Sert de base aux clÃ©s d'idempotence.
  const cycleId = cycleIdParam ?? (await getCycleLockOwner(db)) ?? `adhoc-${Date.now()}`;

  try {
    if (decision.action === 'BUY') {
      // Routage intelligent: prÃ©fÃ¨re Kraken (frais faibles), bascule sur Coinbase
      // si Kraken ne peut pas couvrir le montant plein. Ne jamais exÃ©cuter un
      // montant partiel qui viderait un exchange : si aucun ne couvre -> SKIP.
      let routing = await chooseExchangeForBuy(decision.symbol, decision.amount_eur);
      if (!routing.exchange) return { success: false, message: routing.reason };
      let exchange = routing.exchange;
      let actualAmount = routing.cappedAmount ?? decision.amount_eur;
      let feeRate = exchange === 'kraken' ? PLATFORM_FEE_RATE_KRAKEN : PLATFORM_FEE_RATE_COINBASE;

      const placeOn = async (ex: 'kraken' | 'coinbase', amount: number): Promise<string> => {
        const rate = ex === 'kraken' ? PLATFORM_FEE_RATE_KRAKEN : PLATFORM_FEE_RATE_COINBASE;
        if (ex === 'kraken') {
          const pair = (await resolveKrakenPair(decision.symbol)) ?? SYMBOL_TO_KRAKEN_PAIR[decision.symbol];
          const result = await placeKrakenOrder(pair, 'buy', ((amount - amount * rate) / currentPrice.price_eur).toFixed(8));
          return result.txid[0];
        }
        const productId = SYMBOL_TO_COINBASE_PRODUCT[decision.symbol];
        const result = await placeCoinbaseOrder(productId, 'BUY', amount.toFixed(2));
        return result.order_id;
      };

      let txid: string | undefined;
      // RÃ©servation atomique AVANT l'envoi : deux cycles concurrents avec le
      // mÃªme identifiant de cycle (cas rÃ©el : 2 cycles Ã  56-162 ms d'Ã©cart)
      // ne peuvent pas exÃ©cuter deux fois le mÃªme achat.
      const intentKey = `live:${cycleId}:${decision.symbol}:BUY:${actualAmount.toFixed(2)}`;
      const claim = await claimOrderIntent(db, {
        idempotencyKey: intentKey,
        env: 'live',
        cycleId,
        symbol: decision.symbol,
        action: 'BUY',
        exchange,
        amountEur: actualAmount,
      });
      if (claim === 'duplicate') {
        return { success: false, message: `Achat ${decision.symbol} ${actualAmount.toFixed(2)}â‚¬ dÃ©jÃ  engagÃ© pour ce cycle â€” doublon bloquÃ©` };
      }

      try {
        txid = await placeOn(exchange, actualAmount);
      } catch (firstErr) {
        // Solde bougÃ© entre la lecture et l'ordre (cycle concurrent rÃ©siduel,
        // retrait manuel...) : on vide les caches, on re-route en excluant
        // l'exchange fautif, et on rÃ©essaie UNE fois.
        if (!/insufficient funds/i.test(formatLiveError(firstErr))) {
          await finishOrderIntent(db, intentKey, 'failed', null, formatLiveError(firstErr));
          throw firstErr;
        }
        console.warn(`[LiveTrader] ${exchange} Insufficient funds sur ${decision.symbol}, retry aprÃ¨s re-lecture`);
        clearKrakenBalanceCache();
        clearCoinbaseBalanceCache();
        const retry = await chooseExchangeForBuy(decision.symbol, decision.amount_eur, exchange);
        if (!retry.exchange) {
          await finishOrderIntent(db, intentKey, 'failed_retryable', null, formatLiveError(firstErr));
          return { success: false, message: `${formatLiveError(firstErr)} â€” re-tentative impossible : ${retry.reason}` };
        }
        exchange = retry.exchange;
        actualAmount = retry.cappedAmount ?? decision.amount_eur;
        feeRate = exchange === 'kraken' ? PLATFORM_FEE_RATE_KRAKEN : PLATFORM_FEE_RATE_COINBASE;
        try {
          txid = await placeOn(exchange, actualAmount);
          routing = retry;
        } catch (secondErr) {
          await finishOrderIntent(db, intentKey, 'failed_retryable', null, formatLiveError(secondErr));
          return { success: false, message: `${formatLiveError(secondErr)} (aprÃ¨s re-routage ${exchange})` };
        }
      }

      // Remplissage rÃ©el (frais + prix moyen) avec repli sur l'estimation.
      const fill = txid
        ? exchange === 'kraken' ? await fetchKrakenFill(txid) : await fetchCoinbaseFill(txid)
        : null;
      const accounting = computeTradeAccounting('BUY', fill, {
        priceEur: currentPrice.price_eur,
        budgetEur: actualAmount,
        feeRate,
      });
      const cryptoAmount = accounting.amount;

      await insertLiveTradeRow({
        symbol: decision.symbol,
        action: 'BUY',
        amount: accounting.amount,
        priceEur: accounting.price_eur,
        priceUsd: currentPrice.price_usd,
        eurUsdRate,
        totalEur: accounting.total_eur,
        feeEur: accounting.fee_eur,
        reasoning: decision.reasoning,
        confidence: decision.confidence,
        exchange,
        externalOrderId: txid ?? null,
        feeSource: accounting.fee_source,
      });
      await finishOrderIntent(db, intentKey, 'sent', txid ?? null, null);

      // Avg d'achat AVANT le sync (le sync Ã©crase les montants depuis l'exchange)
      const prevRows = (await db`SELECT amount, avg_buy_price_eur FROM portfolio WHERE symbol = ${decision.symbol} AND env = 'live'`) as Row[];
      const prevAvg = prevRows.length > 0 ? parseFloat(String(prevRows[0].avg_buy_price_eur ?? 0)) : 0;

      // Sync BOTH en frais (post-trade : on veut la rÃ©alitÃ©, pas le cache 30s).
      // Un sync mono-exchange supprimerait de la DB les positions dÃ©tenues
      // sur l'autre exchange (la suppression se base sur les symboles absents).
      await syncPortfolioFromExchange('both', { fresh: true });

      // Prix moyen pondÃ©rÃ© (le coÃ»t rÃ©el inclut les frais : actualAmount).
      // Si l'ancien avg est inconnu (0), on prend le coÃ»t unitaire du nouveau lot
      // plutÃ´t que de diluer avec 0.
      const syncedRows = (await db`SELECT amount FROM portfolio WHERE symbol = ${decision.symbol} AND env = 'live'`) as Row[];
      const syncedAmount = syncedRows.length > 0 ? parseFloat(String(syncedRows[0].amount ?? 0)) : 0;
      if (syncedAmount > 0.000001) {
        const baseAmount = Math.max(0, syncedAmount - cryptoAmount);
        const newAvg = baseAmount > 0.000001 && prevAvg > 0
          ? (baseAmount * prevAvg + accounting.total_eur) / syncedAmount
          : accounting.total_eur / Math.max(cryptoAmount, 1e-12);
        if (newAvg > 0) {
          // Renfort de position : l'Ã©chelle des TP repart de zÃ©ro (flag partiel reset)
          // et le trailing stop repart du prix d'achat (highest reset).
          // Fallback sans nouvelles colonnes si la migration n'a pas Ã©tÃ© jouÃ©e.
          try {
            await db`UPDATE portfolio SET avg_buy_price_eur = ${newAvg}, partial_tp_taken = FALSE, highest_price_eur = ${currentPrice.price_eur}, updated_at = NOW() WHERE symbol = ${decision.symbol} AND env = 'live'`;
          } catch {
            await db`UPDATE portfolio SET avg_buy_price_eur = ${newAvg}, updated_at = NOW() WHERE symbol = ${decision.symbol} AND env = 'live'`;
          }
        }
      }
      return { success: true, message: `[LIVE] AchetÃ© ${cryptoAmount.toFixed(6)} ${decision.symbol} Ã  ${accounting.price_eur.toFixed(4)}â‚¬ sur ${exchange} (${routing.reason})`, txid, exchange, chargedEur: accounting.total_eur };
    }

    if (decision.action === 'SELL') {
      // Vente multi-exchange : l'actif peut Ãªtre rÃ©parti sur Kraken ET Coinbase
      // (ex: UNI des deux cÃ´tÃ©s). On vend jambe par jambe, Kraken d'abord
      // (frais faibles), en sautant les reliquats poussiÃ¨re (< 5â‚¬).
      // TP partiel : rÃ©clamation atomique du palier AVANT toute vente. Un seul
      // cycle peut passer le flag ; sans colonne de persistance on refuse la
      // vente partielle plutÃ´t que risquer de vendre 50 % deux fois.
      let partialClaimed = false;
      if (decision.partial) {
        const claim = await claimPartialTp(db, 'live', decision.symbol);
        if (claim !== 'claimed') {
          const why = claim === 'already'
            ? 'TP partiel dÃ©jÃ  pris pour ce cycle de position'
            : 'flag TP partiel non persistable (migration manquante)';
          return { success: false, message: `Vente partielle ${decision.symbol} annulÃ©e : ${why}` };
        }
        partialClaimed = true;
      }

      const first = await readSellHoldings(decision.symbol, false);
      const totalHolding = first.kraken + first.coinbase;
      if (totalHolding <= 0.000001) {
        if (partialClaimed) await releasePartialTp(db, 'live', decision.symbol);
        return { success: false, message: `Aucune position ${decision.symbol} trouvÃ©e sur Kraken ou Coinbase` };
      }

      // Cap au rÃ©ellement dÃ©tenu (tous exchanges confondus)
      const targetEur = Math.min(decision.amount_eur, totalHolding * currentPrice.price_eur);
      if (targetEur < MIN_SELL_EUR) {
        if (partialClaimed) await releasePartialTp(db, 'live', decision.symbol);
        return { success: false, message: `PoussiÃ¨re ignorÃ©e: vente ${decision.symbol} de ${targetEur.toFixed(2)}â‚¬ < ${MIN_SELL_EUR}â‚¬ minimum exchange` };
      }

      const price = { price_eur: currentPrice.price_eur, price_usd: currentPrice.price_usd };
      const built = buildSellLegs(decision.symbol, currentPrice.price_eur, targetEur,
        first.krakenPair, first.coinbaseProduct, first.kraken, first.coinbase);
      const dropped: string[] = [...built.dropped];
      if (built.legs.length === 0) {
        if (partialClaimed) await releasePartialTp(db, 'live', decision.symbol);
        return { success: false, message: `Vente ${decision.symbol} impossible : ${dropped.join(' ; ') || 'montants sous les minimums exchange'}` };
      }

      const exec = await execSellLegs(decision.symbol, price, eurUsdRate,
        decision.reasoning, decision.confidence, built.legs, cycleId);
      let done = exec.done;
      const errors: string[] = [...exec.errors];
      let txid = exec.txid;
      let shortfall = targetEur - done.reduce((s, d) => s + d.net + d.fee, 0);

      // Retry once : si une jambe a Ã©chouÃ© sur "fonds insuffisants" (solde bougÃ©
      // entre lecture et ordre) et qu'il reste un montant significatif, on relit
      // les VRAIS soldes (bypass cache) et on reconstruit les jambes du reliquat.
      if (shortfall >= MIN_SELL_EUR && errors.some(e => /insufficient funds/i.test(e))) {
        console.warn(`[LiveTrader] Retry vente ${decision.symbol} (${shortfall.toFixed(2)}â‚¬ restants) aprÃ¨s re-lecture`);
        clearKrakenBalanceCache();
        clearCoinbaseBalanceCache();
        const fresh = await readSellHoldings(decision.symbol, true);
        const rb = buildSellLegs(decision.symbol, currentPrice.price_eur, shortfall,
          fresh.krakenPair, fresh.coinbaseProduct, fresh.kraken, fresh.coinbase);
        dropped.push(...rb.dropped.map(d => `retry: ${d}`));
        if (rb.legs.length > 0) {
          const r2 = await execSellLegs(decision.symbol, price, eurUsdRate,
            decision.reasoning, decision.confidence, rb.legs, cycleId);
          done = [...done, ...r2.done];
          errors.push(...r2.errors);
          txid = txid ?? r2.txid;
          shortfall = targetEur - done.reduce((s, d) => s + d.net + d.fee, 0);
        }
      }

      if (done.length > 0) {
        // L'avg d'achat ne change pas Ã  la vente (moyenne conservÃ©e sur le reliquat).
        // Sync en frais (post-trade).
        await syncPortfolioFromExchange('both', { fresh: true });
      } else {
        if (partialClaimed) await releasePartialTp(db, 'live', decision.symbol);
        return { success: false, message: `Vente ${decision.symbol} Ã©chouÃ©e : ${errors.join(' ; ')}` };
      }

      const netKraken = done.filter(d => d.exchange === 'kraken').reduce((s, d) => s + d.net, 0);
      const netCoinbase = done.filter(d => d.exchange === 'coinbase').reduce((s, d) => s + d.net, 0);
      const soldCrypto = done.reduce((s, d) => s + d.crypto, 0);
      const where = [...new Set(done.map(d => d.exchange))].join(' + ');
      const dominant = netKraken >= netCoinbase ? 'kraken' as const : 'coinbase' as const;

      const parts = [`[LIVE] Vendu ${soldCrypto.toFixed(6)} ${decision.symbol} Ã  ${currentPrice.price_eur.toFixed(4)}â‚¬ sur ${where}`];
      if (shortfall > 0.01) parts.push(`(partiel : ${shortfall.toFixed(2)}â‚¬ non vendus)`);
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

    return { success: true, message: `Action ${decision.action} â€” pas d'exÃ©cution` };
  } catch (error) {
    const msg = formatLiveError(error);
    console.error(`[LiveTrader] Error ${decision.action} ${decision.symbol}:`, msg);
    return { success: false, message: `Erreur ${decision.symbol}: ${msg}` };
  }
}

export async function syncPortfolioFromExchange(
  exchange: 'kraken' | 'coinbase' | 'both' = 'both',
  opts?: { fresh?: boolean }
): Promise<void> {
  try {
    const balances: Record<string, number> = {};

    if (exchange === 'kraken' || exchange === 'both') {
      const krakenBalances = await getKrakenBalance(opts);
      for (const [symbol, amount] of Object.entries(krakenBalances)) {
        balances[symbol] = (balances[symbol] ?? 0) + amount;
      }
    }

    if (exchange === 'coinbase' || exchange === 'both') {
      try {
        const coinbaseBalances = await getCoinbaseBalance(opts);
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
