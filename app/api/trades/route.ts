import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') ?? '50');
  const symbol = searchParams.get('symbol');

  try {
    let trades;
    if (symbol) {
      trades = await sql`
        SELECT * FROM trades
        WHERE symbol = ${symbol}
        ORDER BY executed_at DESC
        LIMIT ${limit}
      `;
    } else {
      trades = await sql`
        SELECT * FROM trades
        ORDER BY executed_at DESC
        LIMIT ${limit}
      `;
    }

    return NextResponse.json({ trades });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch trades', details: String(error) },
      { status: 500 }
    );
  }
}
