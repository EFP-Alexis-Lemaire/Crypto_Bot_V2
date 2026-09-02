import { NextResponse } from 'next/server';
import { sqlForContext, getDbContext } from '@/lib/db';

export async function GET(request: Request) {
  const ctx = getDbContext(request);
  const db = sqlForContext(ctx);
  const results: Record<string, unknown> = { ctx };

  // Check each table independently so one failure doesn't block the rest
  try {
    const rows = await db`SELECT id, symbol, amount FROM portfolio ORDER BY symbol LIMIT 20`;
    results.portfolio_rows = rows;
  } catch (e) { results.portfolio_error = String(e); }

  try {
    const rows = await db`SELECT COUNT(*) as count FROM trades`;
    results.trades_total = rows;
  } catch (e) { results.trades_error = String(e); }

  try {
    const rows = await db`SELECT COUNT(*) as count FROM bot_decisions`;
    results.decisions_total = rows;
  } catch (e) { results.decisions_error = String(e); }

  try {
    const rows = await db`SELECT key, value FROM bot_config ORDER BY key`;
    results.config = Object.fromEntries((rows as Array<{key:string;value:string}>).map(c => [c.key, c.value]));
  } catch (e) { results.config_error = String(e); }

  // Check which columns exist
  try {
    const cols = await db`
      SELECT table_name, column_name 
      FROM information_schema.columns 
      WHERE table_name IN ('portfolio','trades','bot_decisions','portfolio_snapshots')
      AND column_name = 'env'
      ORDER BY table_name
    `;
    results.env_column_exists_in = (cols as Array<{table_name:string}>).map(r => r.table_name);
  } catch (e) { results.column_check_error = String(e); }

  return NextResponse.json(results);
}
