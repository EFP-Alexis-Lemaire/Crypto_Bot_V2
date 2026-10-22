import { describe, expect, it } from 'vitest';
import { auditRiskLimits } from '@/lib/risk-checks';

describe('auditRiskLimits', () => {
  it('détecte la paire NEAR quasi identique à quelques ms (cas réel)', () => {
    const result = auditRiskLimits({
      maxTradesPerDay: 10,
      trades: [
        { symbol: 'NEAR', action: 'BUY', amount: 40.89, total_eur: 156.38, executed_at: '2026-09-30T10:00:00.000Z' },
        { symbol: 'NEAR', action: 'BUY', amount: 40.89, total_eur: 156.4, executed_at: '2026-09-30T10:00:00.150Z' },
        { symbol: 'BTC', action: 'BUY', amount: 0.001, total_eur: 60, executed_at: '2026-09-30T10:00:00.160Z' },
      ],
    });
    expect(result.duplicate_candidates).toHaveLength(1);
    expect(result.duplicate_candidates[0].symbol).toBe('NEAR');
    expect(result.duplicate_candidates[0].delta_ms).toBe(150);
    expect(result.violations.some(v => v.includes('doublons potentiels'))).toBe(true);
  });

  it('ne confond pas deux jambes de vente sur des exchanges différents (cas SOL réel)', () => {
    const result = auditRiskLimits({
      maxTradesPerDay: 10,
      trades: [
        { symbol: 'SOL', action: 'SELL', amount: 4.1, total_eur: 436.8, executed_at: '2026-09-27T16:01:06.148Z', reasoning: 'Alléger (via kraken)' },
        { symbol: 'SOL', action: 'SELL', amount: 2.05, total_eur: 216.82, executed_at: '2026-09-27T16:01:06.530Z', reasoning: 'Alléger (via coinbase)' },
      ],
    });
    expect(result.duplicate_candidates).toHaveLength(0);
  });

  it('signale deux jambes identiques sur le MÊME exchange (cas UNI/ADA réel)', () => {
    const result = auditRiskLimits({
      maxTradesPerDay: 10,
      trades: [
        { symbol: 'ADA', action: 'SELL', amount: 268.59, total_eur: 58.28, executed_at: '2026-10-01T22:01:04.625Z', reasoning: 'TP (via coinbase)' },
        { symbol: 'ADA', action: 'SELL', amount: 268.59, total_eur: 58.28, executed_at: '2026-10-01T22:01:04.630Z', reasoning: 'TP (via coinbase)' },
      ],
    });
    expect(result.duplicate_candidates).toHaveLength(1);
    expect(result.duplicate_candidates[0].count).toBe(2);
  });

  it('ne confond pas deux achats espacés du même symbole', () => {
    const result = auditRiskLimits({
      maxTradesPerDay: 10,
      trades: [
        { symbol: 'BTC', action: 'BUY', amount: 0.001, total_eur: 60, executed_at: '2026-09-30T10:00:00.000Z' },
        { symbol: 'BTC', action: 'BUY', amount: 0.001, total_eur: 60, executed_at: '2026-09-30T10:05:00.000Z' },
      ],
    });
    expect(result.duplicate_candidates).toHaveLength(0);
  });

  it('signale les journées au-dessus de la limite', () => {
    const trades = Array.from({ length: 4 }, (_, i) => ({
      symbol: 'BTC',
      action: 'BUY',
      amount: 0.001,
      total_eur: 60 + i,
      executed_at: `2026-09-30T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
    }));
    const result = auditRiskLimits({ maxTradesPerDay: 2, trades });
    expect(result.days_over_limit).toBe(1);
    expect(result.trades_per_day[0].count).toBe(4);
  });

  it('détecte cash négatif et concentration excessive', () => {
    const result = auditRiskLimits({
      maxTradesPerDay: 10,
      maxPositionPct: 10,
      trades: [],
      snapshots: [
        {
          captured_at: '2026-09-30T10:00:00.000Z',
          total_value_eur: 1000,
          cash_eur: -5,
          holdings: [{ symbol: 'BTC', current_value_eur: 400 }],
        },
      ],
    });
    expect(result.negative_cash_snapshots).toBe(1);
    expect(result.max_position_pct).toBe(40);
    expect(result.violations).toHaveLength(2);
  });

  it('compte les sorties stop-loss/trailing et take-profit', () => {
    const result = auditRiskLimits({
      maxTradesPerDay: 10,
      trades: [
        { symbol: 'A', action: 'SELL', amount: 1, total_eur: 10, executed_at: '2026-09-30T10:00:00Z', reasoning: 'Stop-loss: -9%' },
        { symbol: 'B', action: 'SELL', amount: 1, total_eur: 10, executed_at: '2026-09-30T10:01:00Z', reasoning: 'Trailing stop: -5%' },
        { symbol: 'C', action: 'SELL', amount: 1, total_eur: 10, executed_at: '2026-09-30T10:02:00Z', reasoning: 'Take-profit partiel (50%)' },
      ],
    });
    expect(result.stop_loss_sells).toBe(2);
    expect(result.take_profit_sells).toBe(1);
  });
});
