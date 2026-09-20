import { NextResponse } from 'next/server';

/**
 * Vérifie le Bearer CRON_SECRET sur les routes /api/cron/*.
 *
 * - CRON_SECRET défini : exige `Authorization: Bearer <secret>`.
 *   Vercel Cron l'envoie automatiquement quand la variable existe ;
 *   cron-job.org doit l'envoyer manuellement (champ "Headers").
 * - CRON_SECRET absent : fail-closed en prod (500), ouvert en dev local.
 *
 * Retourne une réponse d'erreur si refusé, sinon null (= autorisé).
 */
export function cronUnauthorized(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  const isProd =
    process.env.VERCEL_ENV === 'production' ||
    process.env.APP_ENV === 'production';

  if (!secret) {
    if (isProd) {
      return NextResponse.json(
        { error: 'Server misconfigured: CRON_SECRET manquant' },
        { status: 500 }
      );
    }
    return null; // dev local sans secret : ouvert
  }

  if (request.headers.get('authorization')?.trim() !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
