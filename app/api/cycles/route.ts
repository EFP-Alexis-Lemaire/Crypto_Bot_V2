import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') ?? '20');

  try {
    // Get all unique cycles with their summary
    const cycles = (await sql`
      SELECT
        cycle_id,
        MIN(decided_at) AS started_at,
        COUNT(*) AS total_decisions,
        COUNT(CASE WHEN action = 'BUY' THEN 1 END) AS buys,
        COUNT(CASE WHEN action = 'SELL' THEN 1 END) AS sells,
        COUNT(CASE WHEN action = 'HOLD' THEN 1 END) AS holds,
        COUNT(CASE WHEN action = 'SKIP' THEN 1 END) AS skips,
        MAX(model_used) AS model_used
      FROM bot_decisions
      GROUP BY cycle_id
      ORDER BY started_at DESC
      LIMIT ${limit}
    `) as Array<Record<string, unknown>>;

    // For each cycle, get the decisions detail
    const cyclesWithDetails = await Promise.all(
      cycles.map(async (cycle) => {
        const decisions = (await sql`
          SELECT
            symbol,
            action,
            reasoning,
            confidence,
            risk_score,
            model_used,
            market_data,
            news_summary,
            decided_at
          FROM bot_decisions
          WHERE cycle_id = ${cycle.cycle_id as string}
          ORDER BY decided_at ASC
        `) as Array<Record<string, unknown>>;

        return {
          ...cycle,
          decisions,
        };
      })
    );

    return NextResponse.json({ cycles: cyclesWithDetails });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch cycles', details: String(error) },
      { status: 500 }
    );
  }
}
