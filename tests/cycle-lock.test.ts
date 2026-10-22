import { afterAll, describe, expect, it } from 'vitest';
import { createCycleLock } from '@/lib/cycle-lock';
import { sql, uniqueKey } from './helpers';

const keys: string[] = [];

function newLock(ttlMs = 60_000) {
  const key = uniqueKey('test_lock');
  keys.push(key);
  return createCycleLock({ key, ttlMs, log: () => {} });
}

afterAll(async () => {
  if (!sql) return;
  for (const key of keys) {
    await sql`DELETE FROM bot_config WHERE key = ${key}`;
  }
});

describe.skipIf(!sql)('verrou de cycle (UAT)', () => {
  it('10 acquisitions concurrentes -> exactement 1 gagnant', async () => {
    const lock = newLock();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => lock.acquire(sql!, `cycle-${i}`)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = `cycle-${results.indexOf(true)}`;

    const ownerRows = await sql!`SELECT value FROM bot_config WHERE key = ${lock.key}`;
    expect(String(ownerRows[0]?.value ?? '')).toContain(`|${winner}`);

    await lock.release(sql!, winner);
    expect(await lock.acquire(sql!, 'cycle-next')).toBe(true);
    await lock.release(sql!, 'cycle-next');
  });

  it('un verrou frais n\'est pas volé par un second cycle', async () => {
    const lock = newLock();
    expect(await lock.acquire(sql!, 'cycle-a')).toBe(true);
    expect(await lock.acquire(sql!, 'cycle-b')).toBe(false);
    await lock.release(sql!, 'cycle-a');
    expect(await lock.acquire(sql!, 'cycle-b')).toBe(true);
    await lock.release(sql!, 'cycle-b');
  });

  it('un verrou périmé est récupéré (TTL)', async () => {
    const lock = newLock(30);
    expect(await lock.acquire(sql!, 'cycle-old')).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(await lock.acquire(sql!, 'cycle-new')).toBe(true);
    await lock.release(sql!, 'cycle-new');
  });

  it('la libération par un non-détenteur ne retire pas le verrou', async () => {
    const lock = newLock();
    expect(await lock.acquire(sql!, 'cycle-owner')).toBe(true);
    await lock.release(sql!, 'cycle-other');
    expect(await lock.acquire(sql!, 'cycle-intruder')).toBe(false);
    await lock.release(sql!, 'cycle-owner');
    expect(await lock.acquire(sql!, 'cycle-intruder')).toBe(true);
    await lock.release(sql!, 'cycle-intruder');
  });

  it('fail-closed : DB injoignable -> cycle non lancé', async () => {
    const lock = newLock();
    const brokenDb = (async () => {
      throw new Error('DB down');
    }) as unknown as Parameters<typeof lock.acquire>[0];
    expect(await lock.acquire(brokenDb, 'cycle-x')).toBe(false);
  });
});
