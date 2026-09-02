import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

/**
 * Safe migration — adds missing columns and backfills NULL env values.
 * ALTER TABLE and UPDATE are in separate try/catch so the UPDATE
 * always runs even if the column already existed.
 */
export async function GET() {
  try {
    const migrations: string[] = [];

    // 1. trades.env
    try {
      await sql`ALTER TABLE trades ADD COLUMN IF NOT EXISTS env VARCHAR(10) DEFAULT 'paper'`;
      migrations.push('trades.env: column ensured');
    } catch { migrations.push('trades.env ALTER: skipped'); }
    try {
      await sql`UPDATE trades SET env = 'paper' WHERE env IS NULL`;
      migrations.push('trades.env: NULL rows backfilled');
    } catch { migrations.push('trades.env UPDATE: skipped'); }

    // 2. portfolio.env
    try {
      await sql`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS env VARCHAR(10) DEFAULT 'paper'`;
      migrations.push('portfolio.env: column ensured');
    } catch { migrations.push('portfolio.env ALTER: skipped'); }
    try {
      await sql`UPDATE portfolio SET env = 'paper' WHERE env IS NULL`;
      migrations.push('portfolio.env: NULL rows backfilled');
    } catch { migrations.push('portfolio.env UPDATE: skipped'); }

    // 3. portfolio_snapshots.env
    try {
      await sql`ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS env VARCHAR(10) DEFAULT 'paper'`;
      migrations.push('portfolio_snapshots.env: column ensured');
    } catch { migrations.push('portfolio_snapshots.env ALTER: skipped'); }
    try {
      await sql`UPDATE portfolio_snapshots SET env = 'paper' WHERE env IS NULL`;
      migrations.push('portfolio_snapshots.env: NULL rows backfilled');
    } catch { migrations.push('portfolio_snapshots.env UPDATE: skipped'); }

    // 4. bot_decisions.env
    try {
      await sql`ALTER TABLE bot_decisions ADD COLUMN IF NOT EXISTS env VARCHAR(10) DEFAULT 'paper'`;
      migrations.push('bot_decisions.env: column ensured');
    } catch { migrations.push('bot_decisions.env ALTER: skipped'); }
    try {
      await sql`UPDATE bot_decisions SET env = 'paper' WHERE env IS NULL`;
      migrations.push('bot_decisions.env: NULL rows backfilled');
    } catch { migrations.push('bot_decisions.env UPDATE: skipped'); }

    // 5. Ensure trading_mode config key exists
    await sql`INSERT INTO bot_config (key, value) VALUES ('trading_mode', 'paper') ON CONFLICT (key) DO NOTHING`;
    migrations.push('trading_mode config key ensured');

    // 6. Ensure EUR portfolio row exists for paper env
    await sql`
      INSERT INTO portfolio (currency, symbol, amount, avg_buy_price_eur, env)
      VALUES ('EUR', 'EUR', 5000, 1, 'paper')
      ON CONFLICT DO NOTHING
    `;
    migrations.push('paper EUR portfolio row ensured');

    // Return current state for verification
    const config = (await sql`SELECT key, value FROM bot_config ORDER BY key`) as Array<{ key: string; value: string }>;
    const portfolioRows = (await sql`SELECT symbol, amount, env FROM portfolio ORDER BY env, symbol`) as Array<{ symbol: string; amount: string; env: string }>;

    return NextResponse.json({
      success: true,
      migrations,
      current_config: Object.fromEntries(config.map(c => [c.key, c.value])),
      portfolio_rows: portfolioRows,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
