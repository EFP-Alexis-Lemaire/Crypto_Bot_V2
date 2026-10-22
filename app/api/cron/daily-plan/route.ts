import { NextResponse } from 'next/server';
import { sqlForContext, resolveDbContext } from '@/lib/db';
import { generateDailyPlan, readDailyPlan } from '@/lib/daily-plan';
import { cronUnauthorized } from '@/lib/cron-auth';

// Cron 7h : génère le plan du jour (rétro + prévision) et l'écrit en DB.
// Les cycles suivants l'appliquent (stance contraignante + contexte).
// Auth : Bearer CRON_SECRET (cron-job.org / Vercel Cron) ou ?secret=
//
// GET  = plan du jour. Si il n'existe pas encore -> il est généré (1 appel IA)
//        puis renvoyé. Si il existe déjà -> il est renvoyé tel quel (0 appel IA).
// POST = force la régénération.
// Avant, le GET régénérait un plan à chaque affichage du dashboard : ça
// brûlait du quota CoinGecko et de l'OpenAI pour rien. Le dashboard lit
// maintenant /api/daily-plan (lecture seule).
export async function GET(request: Request) {
  const url = new URL(request.url);
  const secret = process.env.CRON_SECRET;
  const authorizedByQuery = Boolean(secret) && url.searchParams.get('secret') === secret;
  const unauthorized = authorizedByQuery ? null : cronUnauthorized(request);
  if (unauthorized) return unauthorized;

  const ctx = resolveDbContext(request);
  const db = sqlForContext(ctx);
  const plan = await readDailyPlan(db);

  if (plan) {
    return NextResponse.json({ ok: true, plan, generated: false, ctx });
  }

  const modeRows = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
  const env = modeRows[0]?.value === 'live' ? 'live' : 'paper';

  const result = await generateDailyPlan(ctx, env);
  return NextResponse.json({ ...result, generated: true, ctx, env });
}

export async function POST(request: Request) {
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
