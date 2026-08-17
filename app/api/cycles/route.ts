import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') ?? '20');

  try {
    type Row = Record<string, unknown>;

    // Get cycle summaries
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
    `) as Row[];

    if (cycles.length === 0) {
      return NextResponse.json({ cycles: [] });
    }

    // Single query for all decisions (fix N+1)
    const cycleIds = cycles.map(c => String(c.cycle_id));
    const allDecisions = (await sql`
      SELECT
        cycle_id,
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
      WHERE cycle_id = ANY(${cycleIds})
      ORDER BY decided_at ASC
    `) as Row[];

    // Group decisions by cycle_id
    const decisionsByCycle: Record<string, Row[]> = {};
    allDecisions.forEach(d => {
      const cid = String(d.cycle_id);
      if (!decisionsByCycle[cid]) decisionsByCycle[cid] = [];
      decisionsByCycle[cid].push(d);
    });

    const cyclesWithDetails = cycles.map(cycle => ({
      ...cycle,
      decisions: decisionsByCycle[String(cycle.cycle_id)] ?? [],
    }));

    return NextResponse.json({ cycles: cyclesWithDetails });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch cycles', details: String(error) },
      { status: 500 }
    );
  }
}
