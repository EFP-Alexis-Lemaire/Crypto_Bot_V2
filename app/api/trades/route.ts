import { NextResponse } from 'next/server';
import { sqlForContext, getDbContext } from '@/lib/db';
import { getCurrentEnv } from '@/lib/env';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') ?? '50');
  const symbol = searchParams.get('symbol');
  const ctx = getDbContext(request);
  const db = sqlForContext(ctx);

  try {
    const configResult = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
    const env = (configResult[0]?.value ?? 'paper') as string;
    let trades;

    if (symbol) {
      trades = await db`
        SELECT * FROM trades WHERE symbol = ${symbol} AND env = ${env}
        ORDER BY executed_at DESC LIMIT ${limit}
      `;
    } else {
      trades = await db`
        SELECT * FROM trades WHERE env = ${env}
        ORDER BY executed_at DESC LIMIT ${limit}
      `;
    }

    return NextResponse.json({ trades, env, ctx });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch trades', details: String(error) },
      { status: 500 }
    );
  }
}
