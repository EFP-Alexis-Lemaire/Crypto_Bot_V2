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

export async function executeLiveTrade(
  decision: BotDecision,
  currentPrice: MarketData,
  eurUsdRate: number
): Promise<{ success: boolean; message: string; txid?: string }> {
  const exchange = getPreferredExchange(decision.symbol);

  if (!exchange) {
    return { success: false, message: `${decision.symbol} non disponible sur Kraken ou Coinbase` };
  }

  const PLATFORM_FEE_RATE = exchange === 'kraken' ? 0.0026 : 0.006;

  try {
    if (decision.action === 'BUY') {
      const liveBalance = exchange === 'kraken'
        ? await getKrakenBalance()
        : await getCoinbaseBalance();

      const cashEur = liveBalance['EUR'] ?? 0;
      const minTrade = 10;

      if (cashEur < minTrade) {
        return { success: false, message: `Solde insuffisant sur ${exchange}: ${cashEur.toFixed(2)}€` };
      }

      const actualAmount = Math.min(decision.amount_eur, cashEur * 0.95);
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
      await db`
        INSERT INTO trades (symbol, action, amount, price_eur, price_usd, eur_usd_rate, total_eur, fee_eur, mode, reasoning, confidence, env)
        VALUES (
          ${decision.symbol}, 'BUY', ${cryptoAmount}, ${currentPrice.price_eur},
          ${currentPrice.price_usd}, ${eurUsdRate}, ${actualAmount},
          ${fee}, 'live', ${decision.reasoning}, ${decision.confidence}, 'live'
        )
      `;

      await syncPortfolioFromExchange(exchange);

      return {
        success: true,
        message: `[LIVE] Acheté ${cryptoAmount.toFixed(6)} ${decision.symbol} à ${currentPrice.price_eur.toFixed(4)}€ sur ${exchange}`,
        txid,
      };
    }

    if (decision.action === 'SELL') {
      const holdingResult = (await db`
        SELECT * FROM portfolio WHERE symbol = ${decision.symbol} AND env = 'live'
      `) as Row[];

      if (holdingResult.length === 0 || parseFloat(String(holdingResult[0].amount ?? 0)) <= 0) {
        return { success: false, message: `Aucune position ${decision.symbol} à vendre` };
      }

      const holding = holdingResult[0];
      const holdingAmount = parseFloat(String(holding.amount));
      const sellValue = Math.min(decision.amount_eur, holdingAmount * currentPrice.price_eur);
      const cryptoToSell = sellValue / currentPrice.price_eur;
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

      await db`
        INSERT INTO trades (symbol, action, amount, price_eur, price_usd, eur_usd_rate, total_eur, fee_eur, mode, reasoning, confidence, env)
        VALUES (
          ${decision.symbol}, 'SELL', ${cryptoToSell}, ${currentPrice.price_eur},
          ${currentPrice.price_usd}, ${eurUsdRate}, ${eurReceived},
          ${fee}, 'live', ${decision.reasoning}, ${decision.confidence}, 'live'
        )
      `;

      await syncPortfolioFromExchange(exchange);

      return {
        success: true,
        message: `[LIVE] Vendu ${cryptoToSell.toFixed(6)} ${decision.symbol} à ${currentPrice.price_eur.toFixed(4)}€ sur ${exchange}`,
        txid,
      };
    }

    return { success: true, message: `Action ${decision.action} — pas d'exécution` };
  } catch (error) {
    console.error(`[LiveTrader] Error on ${exchange}:`, error);
    return { success: false, message: `Erreur ${exchange}: ${error instanceof Error ? error.message : String(error)}` };
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
