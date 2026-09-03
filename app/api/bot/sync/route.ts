import { NextResponse } from 'next/server';
import { syncPortfolioFromExchange, getConsolidatedBalance } from '@/lib/exchanges/live-trader';
import { sqlForContext, getDbContext } from '@/lib/db';

export const maxDuration = 30;

export async function GET(request: Request) {
  try {
    const ctx = getDbContext(request);
    const db = sqlForContext(ctx);
    const mode = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
    const isLive = mode[0]?.value === 'live';

    if (!isLive) {
      return NextResponse.json({ mode: 'paper', message: 'Sync only available in live mode', balances: null });
    }

    const balances = await getConsolidatedBalance();
    return NextResponse.json({ mode: 'live', balances, ctx });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const ctx = getDbContext(request);
    const db = sqlForContext(ctx);
    const mode = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
    const isLive = mode[0]?.value === 'live';

    if (!isLive) {
      return NextResponse.json({ success: false, message: 'Passe en mode LIVE avant de synchroniser (trading_mode = live)' });
    }

    await syncPortfolioFromExchange('both');
    const balances = await getConsolidatedBalance();

    return NextResponse.json({ success: true, message: 'Portfolio synced from exchanges', balances, ctx });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
