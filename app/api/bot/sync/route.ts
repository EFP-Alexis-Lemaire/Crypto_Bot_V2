import { NextResponse } from 'next/server';
import { syncPortfolioFromExchange, getConsolidatedBalance } from '@/lib/exchanges/live-trader';
import { sql } from '@/lib/db';

export const maxDuration = 30;

/**
 * POST /api/bot/sync — Sync portfolio from live exchanges
 * GET  /api/bot/sync — Get consolidated balance without syncing DB
 */
export async function GET() {
  try {
    const mode = (await sql`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
    const isLive = mode[0]?.value === 'live';

    if (!isLive) {
      return NextResponse.json({
        mode: 'paper',
        message: 'Sync only available in live mode',
        balances: null,
      });
    }

    const balances = await getConsolidatedBalance();
    return NextResponse.json({ mode: 'live', balances });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST() {
  try {
    const mode = (await sql`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
    const isLive = mode[0]?.value === 'live';

    if (!isLive) {
      return NextResponse.json({
        success: false,
        message: 'Sync only available in live mode',
      });
    }

    await syncPortfolioFromExchange('both');

    const balances = await getConsolidatedBalance();
    return NextResponse.json({
      success: true,
      message: 'Portfolio synced from exchanges',
      balances,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
