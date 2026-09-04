import { sql, sqlForContext, DbContext } from './db';
import { PortfolioSummary, PortfolioHolding, BotDecision, MarketData } from './types';
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

  // In live mode: sync from exchanges first to get real balances
  if (env === 'live') {
    try {
      const { getKrakenBalance } = await import('./exchanges/kraken');
      const { getCoinbaseBalance } = await import('./exchanges/coinbase');

      let cashEur = 0;
      try { const kb = await getKrakenBalance(); cashEur += kb['EUR'] ?? 0; } catch {}
      try { const cb = await getCoinbaseBalance(); cashEur += cb['EUR'] ?? cb['USDC'] ? (cb['EUR'] ?? 0) + (cb['USDC'] ?? 0) * 0.92 : 0; } catch {}

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

  for (const holding of holdings) {
    if (holding.symbol === 'EUR') {
      cash_eur = parseFloat(str(holding, 'amount'));
      continue;
    }
    const symbol = String(holding.symbol ?? '');
    const currentPrice = priceMap[symbol] ?? 0;
    const amount = parseFloat(str(holding, 'amount'));
    const avgBuyPrice = parseFloat(str(holding, 'avg_buy_price_eur'));
    const currentValue = amount * currentPrice;
    const costBasis = amount * avgBuyPrice;
    const pnl = currentValue - costBasis;
    const pnlPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
    crypto_value_eur += currentValue;
    holdingDetails.push({
      symbol,
      name: marketData.find(m => m.symbol === symbol)?.name ?? symbol,
      amount,
      avg_buy_price_eur: avgBuyPrice,
      current_price_eur: currentPrice,
      current_value_eur: currentValue,
      pnl_eur: pnl,
      pnl_percent: pnlPercent,
    });
  }

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
        await db`
          UPDATE portfolio SET amount = ${newTotal}, avg_buy_price_eur = ${newAvg}, updated_at = NOW()
          WHERE symbol = ${decision.symbol} AND env = ${env}
        `;
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

export async function checkStopLossAndTakeProfit(
  marketData: MarketData[],
  envOverride?: TradingEnv,
  ctx?: DbContext
): Promise<{ symbol: string; action: 'SELL'; reason: string }[]> {
  const db = dbFor(ctx);
  const env = envOverride ?? await getCurrentEnv();
  const holdings = (await db`
    SELECT * FROM portfolio WHERE symbol != 'EUR' AND env = ${env}
  `) as Row[];

  const configRows = (await db`SELECT * FROM bot_config`) as Row[];
  const configMap: Record<string, string> = {};
  configRows.forEach(c => { configMap[String(c.key ?? '')] = String(c.value ?? ''); });

  const stopLossPct = parseFloat(configMap.stop_loss_pct ?? '8');
  const takeProfitPct = parseFloat(configMap.take_profit_pct ?? '15');
  const actions: { symbol: string; action: 'SELL'; reason: string }[] = [];

  for (const holding of holdings) {
    const symbol = String(holding.symbol ?? '');
    const market = marketData.find(m => m.symbol === symbol);
    if (!market) continue;

    const avgBuyPrice = parseFloat(str(holding, 'avg_buy_price_eur'));
    const change = ((market.price_eur - avgBuyPrice) / avgBuyPrice) * 100;

    if (change <= -stopLossPct) {
      actions.push({ symbol, action: 'SELL', reason: `Stop-loss: ${change.toFixed(2)}% depuis achat à ${avgBuyPrice.toFixed(4)}€` });
    } else if (change >= takeProfitPct) {
      actions.push({ symbol, action: 'SELL', reason: `Take-profit: +${change.toFixed(2)}% depuis achat à ${avgBuyPrice.toFixed(4)}€` });
    }
  }
  return actions;
}
