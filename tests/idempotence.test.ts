import { afterAll, describe, expect, it } from 'vitest';
import { claimPartialTp, releasePartialTp } from '@/lib/partial-tp';
import { claimOrderIntent, finishOrderIntent } from '@/lib/order-intents';
import { sql, uniqueKey, uniqueSuffix } from './helpers';

const symbols: string[] = [];
const intentKeys: string[] = [];

afterAll(async () => {
  if (!sql) return;
  for (const symbol of symbols) {
    await sql`DELETE FROM portfolio WHERE symbol = ${symbol}`;
  }
  for (const key of intentKeys) {
    await sql`DELETE FROM order_intents WHERE idempotency_key = ${key}`;
  }
});

describe.skipIf(!sql)('TP partiel atomique (UAT)', () => {
  it('deux réclamations concurrentes -> une seule gagne', async () => {
    const symbol = `T${uniqueSuffix()}`.slice(0, 20);
    symbols.push(symbol);
    await sql!`INSERT INTO portfolio (currency, symbol, amount, avg_buy_price_eur, env)
      VALUES ('EUR', ${symbol}, 1, 1, 'paper')`;

    const results = await Promise.all([
      claimPartialTp(sql!, 'paper', symbol),
      claimPartialTp(sql!, 'paper', symbol),
      claimPartialTp(sql!, 'paper', symbol),
    ]);
    expect(results.filter(r => r === 'claimed')).toHaveLength(1);
    expect(results.filter(r => r === 'already')).toHaveLength(2);

    await releasePartialTp(sql!, 'paper', symbol);
    expect(await claimPartialTp(sql!, 'paper', symbol)).toBe('claimed');
  });
});

describe.skipIf(!sql)('idempotence des ordres (UAT)', () => {
  it('un intent ne peut être réservé qu\'une fois, sauf échec rejouable', async () => {
    const key = uniqueKey('intent');
    intentKeys.push(key);
    const input = {
      idempotencyKey: key,
      env: 'paper',
      cycleId: 'cycle-test',
      symbol: 'TEST',
      action: 'BUY' as const,
      exchange: 'kraken' as const,
      amountEur: 100,
    };

    const [a, b] = await Promise.all([claimOrderIntent(sql!, input), claimOrderIntent(sql!, input)]);
    expect([a, b].filter(r => r === 'claimed')).toHaveLength(1);
    expect([a, b].filter(r => r === 'duplicate')).toHaveLength(1);

    await finishOrderIntent(sql!, key, 'sent', 'TX-1');
    expect(await claimOrderIntent(sql!, input)).toBe('duplicate');

    await finishOrderIntent(sql!, key, 'failed_retryable', null, 'insufficient funds');
    expect(await claimOrderIntent(sql!, input)).toBe('claimed');
  });
});

describe.skipIf(!sql)('index unique des exécutions (UAT)', () => {
  it('rejette deux trades avec le même external_order_id', async () => {
    const externalId = uniqueKey('ext');
    const insert = (fee: number) => sql!`
      INSERT INTO trades (symbol, action, amount, price_eur, total_eur, fee_eur, mode, env, exchange, external_order_id, fee_source)
      VALUES ('TEST', 'BUY', 1, 1, 1, ${fee}, 'live', 'live', 'kraken', ${externalId}, 'exchange')`;

    await insert(0);
    await expect(insert(0)).rejects.toThrow();
    await sql!`DELETE FROM trades WHERE external_order_id = ${externalId}`;
  });
});
