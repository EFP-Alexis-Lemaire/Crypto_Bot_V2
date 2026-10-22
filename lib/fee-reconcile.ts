// Rapprochement PUR entre les fills réels Kraken et les lignes `trades`
// enregistrées par le bot. Sert à recalculer frais/prix/montants réels sur
// tout l'historique SANS toucher à la prod (script sur copie de test).

export interface KrakenFill {
  txid: string;
  ordertxid: string;
  // secondes epoch
  time: number;
  side: 'BUY' | 'SELL';
  symbol: string;
  vol: number;
  // contrepartie hors frais (EUR)
  cost: number;
  fee: number;
}

export interface RecordedTrade {
  id: number;
  symbol: string;
  action: string;
  amount: number;
  total_eur: number;
  fee_eur: number;
  executed_at: string;
}

export interface CorrectedTrade extends RecordedTrade {
  corrected: boolean;
  txid?: string;
  delta_total_eur: number;
  delta_fee_eur: number;
}

export interface ReconcileResult {
  corrected: CorrectedTrade[];
  matched: number;
  unmatchedFills: KrakenFill[];
  unmatchedTrades: RecordedTrade[];
  feesRecorded: number;
  feesReal: number;
  deltaTotal: number;
}

export function normalizeKrakenPair(pair: string): string {
  let base = pair.toUpperCase().replace(/(ZEUR|EUR)$/, '');
  const map: Record<string, string> = { XBT: 'BTC', XXBT: 'BTC', XETH: 'ETH', XDG: 'DOGE' };
  if (map[base]) return map[base];
  // Kraken préfixe ses codes par X (crypto) / Z (fiat) : XXRP -> XRP, XLTC -> LTC.
  if (/^X[A-Z]{3}$/.test(base) || /^Z[A-Z]{3}$/.test(base)) base = base.slice(1);
  return map[base] ?? base;
}

// Convention : BUY total = cost + fee ; SELL total = cost - fee.
// price = cost / vol (prix moyen d'exécution hors frais).
export function reconcileKrakenFills(
  trades: RecordedTrade[],
  fills: KrakenFill[],
  opts?: { windowMs?: number; volTolerance?: number },
): ReconcileResult {
  const windowMs = opts?.windowMs ?? 180_000;
  const volTolerance = opts?.volTolerance ?? 0.01;
  const used = new Set<number>();
  const corrected: CorrectedTrade[] = [];
  const matchedFillIds = new Set<string>();

  const result: CorrectedTrade[] = trades.map(t => ({ ...t, corrected: false, delta_total_eur: 0, delta_fee_eur: 0 }));

  // Rapprochement glouton par proximité temporelle (les fills Kraken et les
  // lignes DB sont quasi simultanés : l'ordre est écrit juste après l'exécution).
  const sortedFills = [...fills].sort((a, b) => a.time - b.time);
  for (const fill of sortedFills) {
    const fillMs = fill.time * 1000;
    let best = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < trades.length; i++) {
      if (used.has(i)) continue;
      const t = trades[i];
      if (String(t.action) !== fill.side) continue;
      if (String(t.symbol) !== fill.symbol) continue;
      const delta = Math.abs(new Date(t.executed_at).getTime() - fillMs);
      if (delta > windowMs) continue;
      const vol = Number(t.amount);
      if (!(vol > 0) || Math.abs(vol - fill.vol) / fill.vol > volTolerance) continue;
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    }
    if (best < 0) continue;

    used.add(best);
    matchedFillIds.add(fill.txid);
    const t = trades[best];
    const total = fill.side === 'BUY' ? fill.cost + fill.fee : fill.cost - fill.fee;
    result[best] = {
      ...t,
      amount: fill.vol,
      total_eur: Number(total.toFixed(8)),
      fee_eur: Number(fill.fee.toFixed(8)),
      corrected: true,
      txid: fill.txid,
      delta_total_eur: Number((total - Number(t.total_eur)).toFixed(8)),
      delta_fee_eur: Number((fill.fee - Number(t.fee_eur)).toFixed(8)),
    };
    corrected.push(result[best]);
  }

  const unmatchedFills = sortedFills.filter(f => !matchedFillIds.has(f.txid));
  const unmatchedTrades = trades.filter((_, i) => !used.has(i));
  // Comparaison à périmètre identique : uniquement les lignes appariées.
  const feesRecorded = corrected.reduce((sum, t) => sum + (t.fee_eur - t.delta_fee_eur), 0);
  const feesReal = corrected.reduce((sum, t) => sum + Number(t.fee_eur || 0), 0);
  const deltaTotal = corrected.reduce((sum, t) => sum + t.delta_total_eur, 0);

  return {
    corrected: result,
    matched: corrected.length,
    unmatchedFills,
    unmatchedTrades,
    feesRecorded: Number(feesRecorded.toFixed(8)),
    feesReal: Number(feesReal.toFixed(8)),
    deltaTotal: Number(deltaTotal.toFixed(8)),
  };
}
