import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') ?? '20');

  try {
    const decisions = await sql`
      SELECT * FROM bot_decisions
      ORDER BY decided_at DESC
      LIMIT ${limit}
    `;

    return NextResponse.json({ decisions });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch decisions', details: String(error) },
      { status: 500 }
    );
  }
}
