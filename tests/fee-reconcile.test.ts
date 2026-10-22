import { describe, expect, it } from 'vitest';
import { normalizeKrakenPair, reconcileKrakenFills, type KrakenFill, type RecordedTrade } from '@/lib/fee-reconcile';

describe('reconcileKrakenFills', () => {
  it('normalise les paires Kraken', () => {
    expect(normalizeKrakenPair('XXBTZEUR')).toBe('BTC');
    expect(normalizeKrakenPair('XETHZEUR')).toBe('ETH');
    expect(normalizeKrakenPair('SOLEUR')).toBe('SOL');
    expect(normalizeKrakenPair('NEAREUR')).toBe('NEAR');
    expect(normalizeKrakenPair('XXRPZEUR')).toBe('XRP');
    expect(normalizeKrakenPair('XLTCZEUR')).toBe('LTC');
  });

  it('corrige un achat : total = cost + fee (cas NEAR réel)', () => {
    const trades: RecordedTrade[] = [
      { id: 21, symbol: 'NEAR', action: 'BUY', amount: 40.890796, total_eur: 157.0, fee_eur: 0.408, executed_at: '2026-09-23T22:01:08.527Z' },
    ];
    const fills: KrakenFill[] = [
      { txid: 'OV36RJ-U', ordertxid: 'O1', time: Date.parse('2026-09-23T22:01:08.700Z') / 1000, side: 'BUY', symbol: 'NEAR', vol: 40.8895, cost: 156.372, fee: 0.938 },
    ];
    const result = reconcileKrakenFills(trades, fills);
    expect(result.matched).toBe(1);
    expect(result.corrected[0].total_eur).toBeCloseTo(157.31, 2);
    expect(result.corrected[0].fee_eur).toBeCloseTo(0.938, 3);
    expect(result.corrected[0].txid).toBe('OV36RJ-U');
    expect(result.corrected[0].delta_fee_eur).toBeCloseTo(0.53, 2);
  });

  it('corrige une vente : total = cost - fee (cas ADA réel)', () => {
    const trades: RecordedTrade[] = [
      { id: 10, symbol: 'ADA', action: 'SELL', amount: 1494.17891283, total_eur: 314.838, fee_eur: 0.82071, executed_at: '2026-09-21T00:00:00.000Z' },
    ];
    const fills: KrakenFill[] = [
      { txid: 'T1', ordertxid: 'O1', time: Date.parse('2026-09-21T00:00:01.000Z') / 1000, side: 'SELL', symbol: 'ADA', vol: 1494.17891283, cost: 315.76964, fee: 2.52616 },
    ];
    const result = reconcileKrakenFills(trades, fills);
    expect(result.corrected[0].total_eur).toBeCloseTo(313.24348, 4);
    expect(result.corrected[0].fee_eur).toBeCloseTo(2.52616, 5);
    expect(result.corrected[0].delta_total_eur).toBeCloseTo(-1.59452, 4);
  });

  it('ne rapproche ni un mauvais sens, ni un volume trop différent, ni une date lointaine', () => {
    const base = { symbol: 'NEAR', vol: 10, cost: 30, fee: 0.18 } as const;
    const trades: RecordedTrade[] = [
      { id: 1, symbol: 'NEAR', action: 'SELL', amount: 10, total_eur: 30, fee_eur: 0.18, executed_at: '2026-09-23T22:00:00.000Z' },
      { id: 2, symbol: 'BTC', action: 'BUY', amount: 10, total_eur: 30, fee_eur: 0.18, executed_at: '2026-09-23T22:00:00.000Z' },
      { id: 3, symbol: 'NEAR', action: 'BUY', amount: 50, total_eur: 30, fee_eur: 0.18, executed_at: '2026-09-23T22:00:00.000Z' },
      { id: 4, symbol: 'NEAR', action: 'BUY', amount: 10, total_eur: 30, fee_eur: 0.18, executed_at: '2026-09-20T22:00:00.000Z' },
    ];
    const fills = [{ txid: 'T', ordertxid: 'O', time: Date.parse('2026-09-23T22:00:05.000Z') / 1000, side: 'BUY', ...base }] as KrakenFill[];
    const result = reconcileKrakenFills(trades, fills);
    expect(result.matched).toBe(0);
    expect(result.unmatchedFills).toHaveLength(1);
  });

  it('gère deux fills très proches (double exécution) sans réutiliser la même ligne', () => {
    const trades: RecordedTrade[] = [
      { id: 21, symbol: 'NEAR', action: 'BUY', amount: 40.89, total_eur: 157.02, fee_eur: 0.408, executed_at: '2026-09-23T22:01:08.527Z' },
      { id: 22, symbol: 'NEAR', action: 'BUY', amount: 40.89, total_eur: 157.02, fee_eur: 0.408, executed_at: '2026-09-23T22:01:08.698Z' },
    ];
    const fills: KrakenFill[] = [
      { txid: 'A', ordertxid: 'O1', time: Date.parse('2026-09-23T22:01:08.600Z') / 1000, side: 'BUY', symbol: 'NEAR', vol: 40.89, cost: 156.38, fee: 0.938 },
      { txid: 'B', ordertxid: 'O2', time: Date.parse('2026-09-23T22:01:08.760Z') / 1000, side: 'BUY', symbol: 'NEAR', vol: 40.89, cost: 156.40, fee: 0.938 },
    ];
    const result = reconcileKrakenFills(trades, fills);
    expect(result.matched).toBe(2);
    expect(result.corrected.map(c => c.txid).sort()).toEqual(['A', 'B']);
    expect(result.unmatchedTrades).toHaveLength(0);
  });
});
