import { describe, expect, it } from 'vitest';
import { computeTradeAccounting, isUsableFill } from '@/lib/trade-accounting';

describe('computeTradeAccounting', () => {
  it('BUY réel : débit = contrepartie + frais, quantité = volume exécuté (cas ADA 21/09)', () => {
    const fill = {
      volume: 1494.17891283,
      quoteCost: 314.99178,
      feeEur: 2.51993,
      fillPriceEur: 0.210813,
      closed: true,
    };
    const result = computeTradeAccounting('BUY', fill, { priceEur: 0.21027, budgetEur: 315, feeRate: 0.0026 });
    expect(result.amount).toBe(1494.17891283);
    expect(result.total_eur).toBeCloseTo(317.51171, 5);
    expect(result.fee_eur).toBeCloseTo(2.51993, 5);
    expect(result.price_eur).toBeCloseTo(0.210813, 6);
    expect(result.fee_source).toBe('exchange');
  });

  it('SELL réel : crédit = contrepartie - frais (cas ADA 21/09)', () => {
    const fill = {
      volume: 1494.17891283,
      quoteCost: 315.76964,
      feeEur: 2.52616,
      fillPriceEur: 0.211333,
      closed: true,
    };
    const result = computeTradeAccounting('SELL', fill, { priceEur: 0.211333, budgetEur: 314.838, feeRate: 0.0026 });
    expect(result.amount).toBe(1494.17891283);
    expect(result.total_eur).toBeCloseTo(313.24348, 5);
    expect(result.fee_eur).toBeCloseTo(2.52616, 5);
    expect(result.fee_source).toBe('exchange');
  });

  it('BUY sans fill : repli sur estimation historique (budget = débit, frais déduits du volume)', () => {
    const result = computeTradeAccounting('BUY', null, { priceEur: 0.21027, budgetEur: 315, feeRate: 0.0026 });
    expect(result.total_eur).toBe(315);
    expect(result.fee_eur).toBeCloseTo(0.819, 6);
    expect(result.amount).toBeCloseTo((315 - 0.819) / 0.21027, 8);
    expect(result.price_eur).toBe(0.21027);
    expect(result.fee_source).toBe('estimate');
  });

  it('SELL sans fill : repli sur estimation (net = produit - frais)', () => {
    const result = computeTradeAccounting('SELL', null, { priceEur: 10, budgetEur: 100, feeRate: 0.006 });
    expect(result.amount).toBe(10);
    expect(result.total_eur).toBeCloseTo(99.4, 6);
    expect(result.fee_eur).toBeCloseTo(0.6, 6);
    expect(result.fee_source).toBe('estimate');
  });

  it('fill partiel non exploitable (volume/cost nuls) traité comme absent', () => {
    const bad = { volume: 0, quoteCost: 0, feeEur: 0, fillPriceEur: 0, closed: false };
    expect(isUsableFill(bad)).toBe(false);
    const result = computeTradeAccounting('BUY', bad, { priceEur: 2, budgetEur: 20, feeRate: 0.0026 });
    expect(result.fee_source).toBe('estimate');
    expect(result.total_eur).toBe(20);
  });

  it('fill sans prix moyen : prix recalculé depuis contrepartie/volume', () => {
    const result = computeTradeAccounting('SELL', {
      volume: 2,
      quoteCost: 100,
      feeEur: 1,
      fillPriceEur: 0,
      closed: true,
    }, { priceEur: 50, budgetEur: 100, feeRate: 0.0026 });
    expect(result.price_eur).toBe(50);
    expect(result.total_eur).toBe(99);
  });
});
