import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { getTotalAICosts } from '@/lib/ai-costs';

export async function GET() {
  try {
    // Ensure table exists
    await sql`
      CREATE TABLE IF NOT EXISTS ai_costs (
        id SERIAL PRIMARY KEY,
        cycle_id VARCHAR(50),
        model VARCHAR(50) NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd DECIMAL(10, 6) NOT NULL DEFAULT 0,
        cost_eur DECIMAL(10, 6) NOT NULL DEFAULT 0,
        purpose VARCHAR(50) DEFAULT 'analysis',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `;

    const costs = await getTotalAICosts();
    return NextResponse.json({ costs });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
