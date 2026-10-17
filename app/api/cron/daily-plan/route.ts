import { NextResponse } from 'next/server';
import { sqlForContext } from '@/lib/db';
import { generateDailyPlan } from '@/lib/daily-plan';
import { cronUnauthorized } from '@/lib/cron-auth';

// Cron 7h : génère le plan du jour (rétro + prévision) et l'écrit en DB.
// Les cycles suivants l'appliquent (stance contraignante + contexte).
// Auth : Bearer CRON_SECRET (cron-job.org / Vercel Cron) ou ?secret=
export async function GET(request: Request) {
  const url = new URL(request.url);
  const secret = process.env.CRON_SECRET;
  const authorizedByQuery = Boolean(secret) && url.searchParams.get('secret') === secret;
  const unauthorized = authorizedByQuery ? null : cronUnauthorized(request);
  if (unauthorized) return unauthorized;

  const queryCtx = url.searchParams.get('ctx') ?? url.searchParams.get('db');
  const headerCtx = request.headers.get('x-db-context');
  const ctx = (queryCtx === 'prod' || queryCtx === 'uat')
    ? queryCtx
    : (headerCtx === 'prod' || headerCtx === 'uat')
      ? headerCtx
      : process.env.APP_ENV === 'production' ? 'prod' : 'uat';

  const db = sqlForContext(ctx);
  const modeRows = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
  const env = modeRows[0]?.value === 'live' ? 'live' : 'paper';

  const result = await generateDailyPlan(ctx, env);
  return NextResponse.json({ ...result, ctx, env });
}

export async function POST(request: Request) {
  return GET(request);
}
