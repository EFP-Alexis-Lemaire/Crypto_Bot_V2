import { NextResponse } from 'next/server';
import { sqlForContext, getDbContext } from '@/lib/db';
import { getFearGreedIndex } from '@/lib/market-data';

type Row = Record<string, unknown>;

interface Check {
  ok: boolean;
  ms: number;
  detail?: string;
}

async function timed(fn: () => Promise<unknown>, timeoutMs = 8000): Promise<Check> {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    return { ok: true, ms: Date.now() - start };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      ms: Date.now() - start,
      detail: /not configured/i.test(msg) ? 'clés non configurées' : msg.slice(0, 120),
    };
  }
}

// GET : état des connexions (exchanges, CoinGecko, DB) + dernier cycle.
// Léger, sans appel payant (OpenAI = simple présence de la clé).
export async function GET(request: Request) {
  const ctx = getDbContext(request);
  const db = sqlForContext(ctx);

  const [kraken, coinbase, coingecko, dbPing, meta] = await Promise.all([
    timed(async () => {
      const { getKrakenBalance } = await import('@/lib/exchanges/kraken');
      await getKrakenBalance();
    }),
    timed(async () => {
      const { getCoinbaseBalance } = await import('@/lib/exchanges/coinbase');
      await getCoinbaseBalance();
    }),
    timed(async () => {
      await getFearGreedIndex();
    }),
    timed(async () => {
      await db`SELECT 1`;
    }),
    (async () => {
      try {
        const mode = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
        const env = mode[0]?.value === 'live' ? 'live' : 'paper';
        const lastCycle = (await db`
          SELECT MAX(decided_at) AS at FROM bot_decisions WHERE env = ${env}
        `) as Row[];
        const lastTrade = (await db`
          SELECT MAX(executed_at) AS at FROM trades WHERE env = ${env} AND action IN ('BUY','SELL')
        `) as Row[];
        return {
          trading_mode: mode[0]?.value ?? 'paper',
          last_cycle_at: lastCycle[0]?.at ? String(lastCycle[0].at) : null,
          last_trade_at: lastTrade[0]?.at ? String(lastTrade[0].at) : null,
        };
      } catch {
        return { trading_mode: 'unknown', last_cycle_at: null, last_trade_at: null };
      }
    })(),
  ]);

  return NextResponse.json({
    ctx,
    kraken,
    coinbase,
    coingecko,
    db: dbPing,
    openai_configured: Boolean(process.env.OPENAI_API_KEY),
    ...meta,
  });
}
