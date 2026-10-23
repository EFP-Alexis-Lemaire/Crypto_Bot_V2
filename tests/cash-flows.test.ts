import { afterAll, describe, expect, it } from 'vitest';
import { getNetContributions } from '@/lib/cash-flows';
import { sql, uniqueSuffix } from './helpers';

const envs: string[] = [];

afterAll(async () => {
  if (!sql) return;
  for (const env of envs) {
    await sql`DELETE FROM cash_flows WHERE env = ${env}`;
    await sql`DELETE FROM trades WHERE env = ${env}`;
  }
});

describe.skipIf(!sql)('P&L net des versements (UAT)', () => {
  it('ignore les dépôts antérieurs au 1er trade, ajoute les suivants, déduit les retraits', async () => {
    const env = `t${uniqueSuffix()}`.slice(0, 10);
    envs.push(env);

    await sql!`INSERT INTO trades (symbol, action, amount, price_eur, total_eur, fee_eur, mode, env, executed_at)
      VALUES ('TEST', 'BUY', 1, 100, 100, 0, 'live', ${env}, '2026-01-10T12:00:00Z')`;

    const insertFlow = (kind: string, amount: number, id: string, at: string) => sql!`
      INSERT INTO cash_flows (env, exchange, kind, amount_eur, external_id, occurred_at)
      VALUES (${env}, 'kraken', ${kind}, ${amount}, ${id}, ${at})`;

    await insertFlow('deposit', 500, `${env}-d0`, '2026-01-01T00:00:00Z');
    await insertFlow('deposit', 295, `${env}-d1`, '2026-01-20T00:00:00Z');
    await insertFlow('withdrawal', 50, `${env}-w1`, '2026-01-25T00:00:00Z');

    const result = await getNetContributions(sql!, env, 1005);
    expect(result.basis).toBe('flows');
    expect(result.deposits).toBe(295);
    expect(result.withdrawals).toBe(50);
    expect(result.total).toBe(1005 + 295 - 50);
    expect(result.inception).toBe('2026-01-10T12:00:00.000Z');
  });

  it('ne compte que les flux postérieurs à la dernière édition du capital', async () => {
    const env = `e${uniqueSuffix()}`.slice(0, 10);
    envs.push(env);

    const insertFlow = (kind: string, amount: number, id: string, at: string) => sql!`
      INSERT INTO cash_flows (env, exchange, kind, amount_eur, external_id, occurred_at)
      VALUES (${env}, 'kraken', ${kind}, ${amount}, ${id}, ${at})`;

    await insertFlow('deposit', 500, `${env}-d0`, '2026-01-01T00:00:00Z');
    await insertFlow('deposit', 295, `${env}-d1`, '2026-01-20T00:00:00Z');
    await insertFlow('withdrawal', 50, `${env}-w1`, '2026-01-25T00:00:00Z');

    const result = await getNetContributions(sql!, env, 1405, '2026-01-22T00:00:00Z');
    expect(result.basis).toBe('flows');
    expect(result.deposits).toBe(0);
    expect(result.withdrawals).toBe(50);
    expect(result.total).toBe(1405 - 50);
    expect(result.inception).toBe('2026-01-22T00:00:00Z');
  });

  it('sans table/données incohérentes -> repli sur la référence de config', async () => {
    const result = await getNetContributions(sql!, 'env-inexistant', 1400);
    expect(result.total).toBe(1400);
    expect(result.basis).toBe('flows');
    expect(result.deposits).toBe(0);
  });
});
