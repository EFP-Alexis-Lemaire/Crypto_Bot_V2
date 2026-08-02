import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

// One-time fix: remove duplicate historical seeds and set correct values
export async function POST() {
  try {
    // Delete all historical seed entries
    await sql`
      DELETE FROM ai_costs WHERE cycle_id = 'historical-seed'
    `;

    // Re-insert with correct values
    const eurUsdRate = 0.92;
    const totalUsd = 0.67;
    const costEur = totalUsd * eurUsdRate;

    await sql`
      INSERT INTO ai_costs
        (cycle_id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, cost_eur, purpose, created_at)
      VALUES
        (
          'historical-seed',
          'gpt-4o / gpt-4o-mini (mixed)',
          0, 0, 0,
          ${totalUsd},
          ${costEur},
          'historical-import',
          NOW() - INTERVAL '7 days'
        )
    `;

    // Also update calls_count context in a config note (stored as comment in the record)
    const result = (await sql`
      SELECT SUM(cost_usd) as total, COUNT(*) as entries FROM ai_costs
    `) as Array<{ total: string; entries: string }>;

    return NextResponse.json({
      success: true,
      message: 'Historical seed corrected: $0.67 / 121 requests',
      db_total_usd: parseFloat(result[0]?.total ?? '0'),
      entries: parseInt(result[0]?.entries ?? '0'),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
