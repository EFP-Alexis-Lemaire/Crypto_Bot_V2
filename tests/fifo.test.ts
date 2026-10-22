import { describe, expect, it } from 'vitest';
import { computeFifo } from '@/lib/fifo';

describe('computeFifo', () => {
  it('dépile les lots les plus anciens et intègre frais (total net)', () => {
    const { perTradeRealized, perSymbol } = computeFifo([
      { symbol: 'BTC', action: 'BUY', amount: 1, total_eur: 100, fee_eur: 0.26 },
      { symbol: 'BTC', action: 'BUY', amount: 1, total_eur: 200, fee_eur: 0.52 },
      { symbol: 'BTC', action: 'SELL', amount: 1.5, total_eur: 240, fee_eur: 0.62 },
    ]);

    // net unitaire vente = 160 ; lot1 : 1 × (160-100) = 60 ; lot2 : 0.5 × (160-200) = -20
    expect(perTradeRealized).toEqual([null, null, 40]);
    expect(perSymbol.BTC.buys).toBe(2);
    expect(perSymbol.BTC.sells).toBe(1);
    expect(perSymbol.BTC.realized_eur).toBe(40);
    expect(perSymbol.BTC.volume_eur).toBe(300);
    expect(perSymbol.BTC.fees_eur).toBe(1.4);
  });

  it('vente sans lot connu -> réalisé 0 (position pré-existante)', () => {
    const { perTradeRealized } = computeFifo([
      { symbol: 'ETH', action: 'SELL', amount: 2, total_eur: 300 },
    ]);
    expect(perTradeRealized).toEqual([0]);
  });

  it('fenêtre sinceTs : les lots restent calculés sur tout l\'historique', () => {
    const trades = [
      { symbol: 'ADA', action: 'BUY', amount: 100, total_eur: 100, executed_at: '2026-01-01T00:00:00Z' },
      { symbol: 'ADA', action: 'SELL', amount: 100, total_eur: 150, executed_at: '2026-02-01T00:00:00Z' },
    ];
    const windowed = computeFifo(trades, { sinceTs: Date.parse('2026-01-15T00:00:00Z') });
    expect(windowed.perSymbol.ADA.sells).toBe(1);
    expect(windowed.perSymbol.ADA.realized_eur).toBe(50);
    expect(windowed.perSymbol.ADA.buys).toBe(0);
  });

  it('vente partielle laisse un reliquat de lot', () => {
    const { perTradeRealized } = computeFifo([
      { symbol: 'SOL', action: 'BUY', amount: 10, total_eur: 1000 },
      { symbol: 'SOL', action: 'SELL', amount: 4, total_eur: 480 },
      { symbol: 'SOL', action: 'SELL', amount: 6, total_eur: 600 },
    ]);
    // lot 100/unité : vente 4 à 120 → +80 ; vente 6 à 100 → 0
    expect(perTradeRealized).toEqual([null, 80, 0]);
  });
});
