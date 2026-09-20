import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

/**
 * Protection du dashboard par mot de passe (HTTP Basic Auth).
 *
 * - Tout le site et /api/* exigent DASHBOARD_USER / DASHBOARD_PASSWORD
 *   (à définir dans les variables d'environnement Vercel, onglet Production).
 * - /api/cron/* sont EXCLUS : ils utilisent leur propre contrôle
 *   (Bearer CRON_SECRET, voir lib/cron-auth.ts) pour cron-job.org et les
 *   crons natifs Vercel.
 * - /robots.txt reste public pour que les crawlers lisent "Disallow: /".
 *
 * Si les identifiants ne sont pas configurés : fail-closed en prod (500),
 * ouvert en dev local pour ne pas gêner le développement.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function unauthorized(): NextResponse {
  return new NextResponse('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="CryptoBot", charset="UTF-8"',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Cache-Control': 'no-store',
    },
  });
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Crons : contrôle Bearer dédié dans chaque route, pas de Basic Auth ici
  // (sinon cron-job.org et Vercel Cron seraient bloqués).
  if (pathname.startsWith('/api/cron/')) {
    return NextResponse.next();
  }

  // robots.txt public pour que les moteurs voient "Disallow: /"
  if (pathname === '/robots.txt') {
    return NextResponse.next();
  }

  const user = process.env.DASHBOARD_USER ?? '';
  const pass = process.env.DASHBOARD_PASSWORD ?? '';
  const isProd =
    process.env.VERCEL_ENV === 'production' ||
    process.env.APP_ENV === 'production';

  if (!user || !pass) {
    if (isProd) {
      return new NextResponse(
        'Server misconfigured: DASHBOARD_USER / DASHBOARD_PASSWORD manquants',
        { status: 500 }
      );
    }
    return NextResponse.next(); // dev local : ouvert
  }

  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (
        idx > 0 &&
        safeEqual(decoded.slice(0, idx), user) &&
        safeEqual(decoded.slice(idx + 1), pass)
      ) {
        return NextResponse.next();
      }
    } catch {
      // Header malformé -> 401 ci-dessous
    }
  }

  return unauthorized();
}
