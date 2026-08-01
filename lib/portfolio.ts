import { sql } from './db';
import { PortfolioSummary, PortfolioHolding, BotDecision, MarketData } from './types';

type Row = Record<string, unknown>;

function str(row: Row, field: string, fallback = '0'): string {
  return String(row[field] ?? fallback);
}

export async function getPortfolioSummary(
  marketData: MarketData[]
): Promise<PortfolioSummary> {
  const holdings = (await sql`SELECT * FROM portfolio`) as Row[];

  const priceMap: Record<string, number> = {};
  marketData.forEach(m => {
    priceMap[m.symbol] = m.price_eur;
  });

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
  const initial = parseFloat(process.env.INITIAL_PORTFOLIO_EUR ?? '5000');
  const pnl_eur = total_value_eur - initial;
  const pnl_percent = (pnl_eur / initial) * 100;

  return {
    total_value_eur,
    cash_eur,
    crypto_value_eur,
    pnl_eur,
    pnl_percent,
    holdings: holdingDetails.filter(h => h.amount > 0),
  };
}

export async function executePaperTrade(
  decision: BotDecision,
  currentPrice: MarketData,
  eurUsdRate: number
): Promise<{ success: boolean; message: string }> {
  try {
    if (decision.action === 'BUY') {
      const cashResult = (await sql`
        SELECT amount FROM portfolio WHERE symbol = 'EUR'
      `) as Row[];
      const cashEur = parseFloat(str(cashResult[0] ?? {}, 'amount'));

      if (cashEur < decision.amount_eur) {
        return {
          success: false,
          message: `Fonds insuffisants: ${cashEur.toFixed(2)}€ disponible, ${decision.amount_eur.toFixed(2)}€ requis`,
        };
      }

      const fee = decision.amount_eur * 0.001;
      const netAmount = decision.amount_eur - fee;
      const cryptoAmount = netAmount / currentPrice.price_eur;

      await sql`
        UPDATE portfolio 
        SET amount = amount - ${decision.amount_eur}, updated_at = NOW()
        WHERE symbol = 'EUR'
      `;

      const existing = (await sql`
        SELECT * FROM portfolio WHERE symbol = ${decision.symbol}
      `) as Row[];

      if (existing.length > 0) {
        const existingAmount = parseFloat(str(existing[0], 'amount'));
        const existingAvg = parseFloat(str(existing[0], 'avg_buy_price_eur'));
        const newTotalAmount = existingAmount + cryptoAmount;
        const newAvgPrice =
          (existingAmount * existingAvg + cryptoAmount * currentPrice.price_eur) /
          newTotalAmount;

        await sql`
          UPDATE portfolio 
          SET amount = ${newTotalAmount}, 
              avg_buy_price_eur = ${newAvgPrice},
              updated_at = NOW()
          WHERE symbol = ${decision.symbol}
        `;
      } else {
        await sql`
          INSERT INTO portfolio (currency, symbol, amount, avg_buy_price_eur)
          VALUES ('CRYPTO', ${decision.symbol}, ${cryptoAmount}, ${currentPrice.price_eur})
        `;
      }

      await sql`
        INSERT INTO trades (symbol, action, amount, price_eur, price_usd, eur_usd_rate, total_eur, fee_eur, mode, reasoning, confidence)
        VALUES (
          ${decision.symbol}, 'BUY', ${cryptoAmount}, ${currentPrice.price_eur},
          ${currentPrice.price_usd}, ${eurUsdRate}, ${decision.amount_eur},
          ${fee}, 'paper', ${decision.reasoning}, ${decision.confidence}
        )
      `;

      return {
        success: true,
        message: `Acheté ${cryptoAmount.toFixed(6)} ${decision.symbol} à ${currentPrice.price_eur.toFixed(4)}€`,
      };
    }

    if (decision.action === 'SELL') {
      const holdingResult = (await sql`
        SELECT * FROM portfolio WHERE symbol = ${decision.symbol}
      `) as Row[];

      if (holdingResult.length === 0 || parseFloat(str(holdingResult[0], 'amount')) <= 0) {
        return {
          success: false,
          message: `Aucune position ${decision.symbol} à vendre`,
        };
      }

      const holding = holdingResult[0];
      const currentHoldingValue =
        parseFloat(str(holding, 'amount')) * currentPrice.price_eur;
      const sellValue = Math.min(decision.amount_eur, currentHoldingValue);
      const cryptoToSell = sellValue / currentPrice.price_eur;
      const fee = sellValue * 0.001;
      const eurReceived = sellValue - fee;

      const newAmount = parseFloat(str(holding, 'amount')) - cryptoToSell;
      if (newAmount <= 0.000001) {
        await sql`DELETE FROM portfolio WHERE symbol = ${decision.symbol}`;
      } else {
        await sql`
          UPDATE portfolio 
          SET amount = ${newAmount}, updated_at = NOW()
          WHERE symbol = ${decision.symbol}
        `;
      }

      await sql`
        UPDATE portfolio 
        SET amount = amount + ${eurReceived}, updated_at = NOW()
        WHERE symbol = 'EUR'
      `;

      await sql`
        INSERT INTO trades (symbol, action, amount, price_eur, price_usd, eur_usd_rate, total_eur, fee_eur, mode, reasoning, confidence)
        VALUES (
          ${decision.symbol}, 'SELL', ${cryptoToSell}, ${currentPrice.price_eur},
          ${currentPrice.price_usd}, ${eurUsdRate}, ${eurReceived},
          ${fee}, 'paper', ${decision.reasoning}, ${decision.confidence}
        )
      `;

      return {
        success: true,
        message: `Vendu ${cryptoToSell.toFixed(6)} ${decision.symbol} à ${currentPrice.price_eur.toFixed(4)}€, reçu ${eurReceived.toFixed(2)}€`,
      };
    }

    return { success: true, message: `Action ${decision.action} sur ${decision.symbol} - pas d'exécution requise` };
  } catch (error) {
    console.error('Trade execution error:', error);
    return { success: false, message: `Erreur: ${error}` };
  }
}

export async function savePortfolioSnapshot(
  portfolio: PortfolioSummary
): Promise<void> {
  await sql`
    INSERT INTO portfolio_snapshots 
      (total_value_eur, cash_eur, crypto_value_eur, pnl_eur, pnl_percent, holdings)
    VALUES (
      ${portfolio.total_value_eur},
      ${portfolio.cash_eur},
      ${portfolio.crypto_value_eur},
      ${portfolio.pnl_eur},
      ${portfolio.pnl_percent},
      ${JSON.stringify(portfolio.holdings)}
    )
  `;
}

export async function checkStopLossAndTakeProfit(
  marketData: MarketData[]
): Promise<{ symbol: string; action: 'SELL'; reason: string }[]> {
  // Simple holdings query (no complex join with invalid SQL)
  const holdings = (await sql`
    SELECT * FROM portfolio WHERE symbol != 'EUR'
  `) as Row[];

  const configRows = (await sql`SELECT * FROM bot_config`) as Row[];
  const configMap: Record<string, string> = {};
  configRows.forEach((c) => {
    configMap[String(c.key ?? '')] = String(c.value ?? '');
  });

  const stopLossPct = parseFloat(configMap.stop_loss_pct ?? '8');
  const takeProfitPct = parseFloat(configMap.take_profit_pct ?? '15');

  const actions: { symbol: string; action: 'SELL'; reason: string }[] = [];

  for (const holding of holdings) {
    const symbol = String(holding.symbol ?? '');
    const market = marketData.find(m => m.symbol === symbol);
    if (!market) continue;

    const avgBuyPrice = parseFloat(str(holding, 'avg_buy_price_eur'));
    const currentPrice = market.price_eur;
    const changeFromBuy = ((currentPrice - avgBuyPrice) / avgBuyPrice) * 100;

    if (changeFromBuy <= -stopLossPct) {
      actions.push({
        symbol,
        action: 'SELL',
        reason: `Stop-loss déclenché: ${changeFromBuy.toFixed(2)}% depuis l'achat à ${avgBuyPrice.toFixed(4)}€`,
      });
    } else if (changeFromBuy >= takeProfitPct) {
      actions.push({
        symbol,
        action: 'SELL',
        reason: `Take-profit déclenché: +${changeFromBuy.toFixed(2)}% depuis l'achat à ${avgBuyPrice.toFixed(4)}€`,
      });
    }
  }

  return actions;
}
