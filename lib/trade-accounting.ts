export type TradeSide = 'BUY' | 'SELL';

// Remplissage réel renvoyé par l'exchange après exécution.
export interface ExchangeFill {
  // Quantité crypto réellement exécutée (vol_exec Kraken / filled_size Coinbase)
  volume: number;
  // Contrepartie en devise de cotation HORS frais (cost Kraken / filled_value Coinbase)
  quoteCost: number;
  // Frais en devise de cotation (fee Kraken / total_fees Coinbase)
  feeEur: number;
  // Prix moyen d'exécution
  fillPriceEur: number;
  // false si l'ordre n'est pas entièrement exécuté
  closed: boolean;
}

export interface EstimatedFill {
  priceEur: number;
  budgetEur: number;
  feeRate: number;
}

export interface TradeAccounting {
  amount: number;
  price_eur: number;
  total_eur: number;
  fee_eur: number;
  fee_source: 'exchange' | 'estimate';
}

export function isUsableFill(fill: ExchangeFill | null | undefined): fill is ExchangeFill {
  return !!fill && Number.isFinite(fill.volume) && fill.volume > 0
    && Number.isFinite(fill.quoteCost) && fill.quoteCost > 0
    && Number.isFinite(fill.feeEur) && fill.feeEur >= 0;
}

// Convention comptable unique :
//   BUY  : sortie de cash = quoteCost + frais ; amount = volume exécuté
//   SELL : entrée de cash = quoteCost - frais ; amount = volume exécuté
// En cas d'absence de fill réel, on retombe sur l'estimation historique
// (budget pour un achat, produit visé pour une vente) en marquant fee_source.
export function computeTradeAccounting(
  side: TradeSide,
  fill: ExchangeFill | null | undefined,
  estimate: EstimatedFill,
): TradeAccounting {
  if (isUsableFill(fill)) {
    const price = Number.isFinite(fill.fillPriceEur) && fill.fillPriceEur > 0
      ? fill.fillPriceEur
      : fill.quoteCost / fill.volume;
    const total = side === 'BUY' ? fill.quoteCost + fill.feeEur : fill.quoteCost - fill.feeEur;
    return {
      amount: fill.volume,
      price_eur: price,
      total_eur: total,
      fee_eur: fill.feeEur,
      fee_source: 'exchange',
    };
  }

  const fee = estimate.budgetEur * estimate.feeRate;
  const amount = side === 'BUY'
    ? (estimate.budgetEur - fee) / estimate.priceEur
    : estimate.budgetEur / estimate.priceEur;
  const total = side === 'BUY' ? estimate.budgetEur : Math.max(0, estimate.budgetEur - fee);

  return {
    amount,
    price_eur: estimate.priceEur,
    total_eur: total,
    fee_eur: fee,
    fee_source: 'estimate',
  };
}
