import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    APP_ENV: process.env.APP_ENV ?? '(not set)',
    VERCEL_ENV: process.env.VERCEL_ENV ?? '(not set)',
    NODE_ENV: process.env.NODE_ENV ?? '(not set)',
    has_DATABASE_URL: !!process.env.DATABASE_URL,
    has_DATABASE_URL_PROD: !!process.env.DATABASE_URL_PROD,
    // Show last 10 chars only to identify which DB is used without exposing credentials
    DATABASE_URL_tail: process.env.DATABASE_URL?.slice(-30) ?? '(not set)',
    DATABASE_URL_PROD_tail: process.env.DATABASE_URL_PROD?.slice(-30) ?? '(not set)',
    db_in_use: process.env.APP_ENV === 'production'
      ? (process.env.DATABASE_URL_PROD ? 'DATABASE_URL_PROD' : 'DATABASE_URL (fallback)')
      : 'DATABASE_URL',
  });
}
