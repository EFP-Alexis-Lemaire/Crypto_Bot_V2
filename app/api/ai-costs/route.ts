import { NextResponse } from 'next/server';
import { sqlForContext, getDbContext, DbContext } from '@/lib/db';
import { getTotalAICosts } from '@/lib/ai-costs';

export async function GET(request: Request) {
  try {
    const ctx = getDbContext(request);
    const db = sqlForContext(ctx);

    // Ensure table exists in the correct DB
    await db`
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

    const costs = await getTotalAICosts(ctx);
    return NextResponse.json({ costs, ctx });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
