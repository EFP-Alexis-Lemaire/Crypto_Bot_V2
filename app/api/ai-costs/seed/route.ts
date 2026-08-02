import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

// One-time seed to add historical AI costs before tracking was implemented
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { total_usd, calls_count, note } = body;

    // EUR/USD approximate rate at time of seeding
    const eurUsdRate = 0.92;
    const costEur = total_usd * eurUsdRate;

    // Insert as a single historical record
    await sql`
      INSERT INTO ai_costs
        (cycle_id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, cost_eur, purpose, created_at)
      VALUES
        (
          'historical-seed',
          'gpt-4o / gpt-4o-mini (mixed)',
          0,
          0,
          ${Math.round((total_usd / 0.000002) * calls_count)},
          ${total_usd},
          ${costEur},
          ${note ?? 'historical-import'},
          NOW() - INTERVAL '7 days'
        )
    `;

    return NextResponse.json({
      success: true,
      inserted: { total_usd, cost_eur: costEur, calls_count, note }
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
