import { NextResponse } from 'next/server';
import { sqlForContext, getDbContext } from '@/lib/db';
import { generateDailyPlan, readDailyPlan } from '@/lib/daily-plan';

// Endpoint dashboard du plan du jour (protégé par le Basic Auth du proxy).
// GET  = lecture du plan stocké (aucun appel IA / CoinGecko)
// POST = génération (1 appel IA) — equivalent du bouton « Plan du jour »
export async function GET(request: Request) {
  const ctx = getDbContext(request);
  const db = sqlForContext(ctx);
  const plan = await readDailyPlan(db);
  return NextResponse.json({
    ok: true,
    plan,
    ctx,
    error: plan ? null : 'Aucun plan du jour généré (cron 7h ou bouton « Plan du jour »).',
  });
}

export async function POST(request: Request) {
  const ctx = getDbContext(request);
  const db = sqlForContext(ctx);
  const modeRows = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
  const env = modeRows[0]?.value === 'live' ? 'live' : 'paper';

  const result = await generateDailyPlan(ctx, env);
  return NextResponse.json({ ...result, ctx, env });
}
