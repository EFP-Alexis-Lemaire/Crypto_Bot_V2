import { NextResponse } from 'next/server';
import { sqlForContext, resolveDbContext } from '@/lib/db';
import { generateDailyPlan } from '@/lib/daily-plan';
import { cronUnauthorized } from '@/lib/cron-auth';

// Génération du plan du jour — endpoint GET dédié au cron Vercel 7h (vercel.json).
// /api/cron/daily-plan en GET ne fait QUE lire le plan existant (0 appel IA),
// sinon chaque affichage du dashboard régénérait un plan.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const secret = process.env.CRON_SECRET;
  const authorizedByQuery = Boolean(secret) && url.searchParams.get('secret') === secret;
  const unauthorized = authorizedByQuery ? null : cronUnauthorized(request);
  if (unauthorized) return unauthorized;

  const ctx = resolveDbContext(request);
  const db = sqlForContext(ctx);
  const modeRows = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
  const env = modeRows[0]?.value === 'live' ? 'live' : 'paper';

  const result = await generateDailyPlan(ctx, env);
  return NextResponse.json({ ...result, generated: true, ctx, env });
}
