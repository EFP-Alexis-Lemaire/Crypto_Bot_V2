// Vérifications de limites de risque à partir de l'historique réel.
// Fonctions PURES (aucune I/O) : utilisées par scripts/audit-risk-limits.ts
// et par les tests, sans toucher au code de trading.

export interface AuditTrade {
  symbol: string;
  action: string;
  amount: number;
  total_eur: number;
  executed_at: string;
  reasoning?: string;
}

export interface AuditSnapshot {
  captured_at: string;
  total_value_eur: number;
  cash_eur: number;
  holdings?: unknown;
}

export interface DuplicateCandidate {
  symbol: string;
  action: string;
  first_at: string;
  second_at: string;
  delta_ms: number;
  total_eur: number;
  count: number;
}

export interface RiskAuditResult {
  trades: number;
  days: number;
  trades_per_day: Array<{ day: string; count: number; over_limit: boolean }>;
  days_over_limit: number;
  duplicate_candidates: DuplicateCandidate[];
  negative_cash_snapshots: number;
  max_position_pct: number;
  stop_loss_sells: number;
  take_profit_sells: number;
  violations: string[];
}

export function auditRiskLimits(input: {
  trades: AuditTrade[];
  snapshots?: AuditSnapshot[];
  maxTradesPerDay: number;
  maxPositionPct?: number;
  duplicateWindowMs?: number;
}): RiskAuditResult {
  const window = input.duplicateWindowMs ?? 120_000;
  const trades = [...input.trades].sort(
    (a, b) => new Date(a.executed_at).getTime() - new Date(b.executed_at).getTime(),
  );

  const perDay = new Map<string, number>();
  for (const t of trades) {
    const day = String(t.executed_at).slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const trades_per_day = [...perDay.entries()]
    .map(([day, count]) => ({ day, count, over_limit: count > input.maxTradesPerDay }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const days_over_limit = trades_per_day.filter(d => d.over_limit).length;

  // Doublons potentiels : même symbole, même sens, montant quasi identique,
  // exécutés dans une fenêtre très courte (signature des cycles concurrents).
  // Deux jambes sur des exchanges DIFFÉRENTS sont une répartition légitime
  // (ex: vente split Kraken + Coinbase), pas un doublon.
  const duplicate_candidates: DuplicateCandidate[] = [];
  const ts = (t: AuditTrade) => new Date(t.executed_at).getTime();
  const venueOf = (t: AuditTrade): string | null => {
    const m = /\(via (kraken|coinbase)\)/i.exec(t.reasoning ?? '');
    return m ? m[1].toLowerCase() : null;
  };
  for (let i = 0; i < trades.length; i++) {
    const a = trades[i];
    const ta = ts(a);
    const va = venueOf(a);
    const group = [a];
    let j = i + 1;
    for (; j < trades.length; j++) {
      const b = trades[j];
      if (ts(b) - ta > window) break;
      if (b.symbol !== a.symbol || b.action !== a.action) continue;
      const vb = venueOf(b);
      if (va && vb && va !== vb) continue;
      const max = Math.max(Math.abs(a.total_eur), Math.abs(b.total_eur), 1e-9);
      if (Math.abs(a.total_eur - b.total_eur) / max > 0.005) continue;
      group.push(b);
    }
    if (group.length >= 2) {
      const total = group.reduce((sum, t) => sum + t.total_eur, 0);
      duplicate_candidates.push({
        symbol: a.symbol,
        action: a.action,
        first_at: a.executed_at,
        second_at: group[group.length - 1].executed_at,
        delta_ms: ts(group[group.length - 1]) - ta,
        total_eur: Number((total / group.length).toFixed(2)),
        count: group.length,
      });
      i = j - 1;
    }
  }

  let negative_cash_snapshots = 0;
  let max_position_pct = 0;
  for (const s of input.snapshots ?? []) {
    if (Number(s.cash_eur) < 0) negative_cash_snapshots++;
    if (!Array.isArray(s.holdings) || !(Number(s.total_value_eur) > 0)) continue;
    for (const h of s.holdings as Array<Record<string, unknown>>) {
      const value = Number(h.current_value_eur ?? h.value_eur ?? 0);
      if (!Number.isFinite(value) || value <= 0) continue;
      const pct = (value / Number(s.total_value_eur)) * 100;
      if (pct > max_position_pct) max_position_pct = pct;
    }
  }

  const stop_loss_sells = trades.filter(t => t.action === 'SELL' && /stop-loss|trailing stop/i.test(t.reasoning ?? '')).length;
  const take_profit_sells = trades.filter(t => t.action === 'SELL' && /take-profit/i.test(t.reasoning ?? '')).length;

  const violations: string[] = [];
  if (days_over_limit > 0) {
    const days = trades_per_day.filter(d => d.over_limit).map(d => `${d.day} (${d.count})`).join(', ');
    violations.push(`${days_over_limit} jour(s) au-dessus de max_trades_per_day=${input.maxTradesPerDay} : ${days}`);
  }
  if (duplicate_candidates.length > 0) {
    violations.push(`${duplicate_candidates.length} paire(s) de trades quasi identiques à moins de ${Math.round(window / 1000)}s (doublons potentiels)`);
  }
  if (negative_cash_snapshots > 0) {
    violations.push(`${negative_cash_snapshots} snapshot(s) avec cash négatif (incohérence de ledger)`);
  }
  if (input.maxPositionPct !== undefined && max_position_pct > input.maxPositionPct) {
    violations.push(`Concentration max ${max_position_pct.toFixed(1)}% > max_position_size_pct=${input.maxPositionPct}%`);
  }

  return {
    trades: trades.length,
    days: perDay.size,
    trades_per_day,
    days_over_limit,
    duplicate_candidates,
    negative_cash_snapshots,
    max_position_pct: Number(max_position_pct.toFixed(2)),
    stop_loss_sells,
    take_profit_sells,
    violations,
  };
}
