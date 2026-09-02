import { NextResponse } from 'next/server';
import { sqlForContext, getDbContext } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const ctx = getDbContext(request);
    const db = sqlForContext(ctx);

    const result = (await db`
      SELECT data, created_at FROM morning_reports
      ORDER BY report_date DESC
      LIMIT 1
    `) as Array<{ data: unknown; created_at: string }>;

    if (result.length === 0) {
      return NextResponse.json({ report: null });
    }

    return NextResponse.json({
      report: result[0].data,
      created_at: result[0].created_at,
      ctx,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
