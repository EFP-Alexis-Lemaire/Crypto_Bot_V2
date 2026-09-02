import { NextResponse } from 'next/server';
import { sqlForContext, getDbContext } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') ?? '20');
  const ctx = getDbContext(request);
  const db = sqlForContext(ctx);

  try {
    const configResult = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
    const env = (configResult[0]?.value ?? 'paper') as string;

    const decisions = await db`
      SELECT * FROM bot_decisions WHERE env = ${env}
      ORDER BY decided_at DESC LIMIT ${limit}
    `;

    return NextResponse.json({ decisions, env, ctx });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch decisions', details: String(error) },
      { status: 500 }
    );
  }
}
