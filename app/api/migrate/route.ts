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

    // 5. Ensure trading_mode config key exists (default paper for fresh DB)
    await sql`INSERT INTO bot_config (key, value) VALUES ('trading_mode', 'paper') ON CONFLICT (key) DO NOTHING`;
    migrations.push('trading_mode config key ensured');

    // 5b. Auto-fix: if trading_mode='live' but no live portfolio rows exist, reset to 'paper'
    // This handles fresh prod DBs where trading_mode was set to 'live' before any data existed
    try {
      const liveRows = (await sql`SELECT COUNT(*) as count FROM portfolio WHERE env = 'live' AND symbol != 'EUR'`) as Array<{ count: string }>;
      const tradingModeRow = (await sql`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
      const currentMode = tradingModeRow[0]?.value;
      const liveCount = parseInt(liveRows[0]?.count ?? '0');
      if (currentMode === 'live' && liveCount === 0) {
        await sql`UPDATE bot_config SET value = 'paper', updated_at = NOW() WHERE key = 'trading_mode'`;
        migrations.push('trading_mode: reset to paper (no live data found)');
      }
    } catch { migrations.push('trading_mode auto-fix: skipped'); }

    // 6. Ensure EUR portfolio row exists for paper env — deduplicate if needed
    // First remove any duplicate EUR paper rows keeping only the one with highest amount
    try {
      await sql`
        DELETE FROM portfolio
        WHERE symbol = 'EUR' AND env = 'paper' AND id NOT IN (
          SELECT id FROM portfolio
          WHERE symbol = 'EUR' AND env = 'paper'
          ORDER BY amount DESC
          LIMIT 1
        )
      `;
      migrations.push('portfolio EUR paper: duplicates removed');
    } catch { migrations.push('portfolio EUR paper dedup: skipped'); }

    // Then insert if still missing
    await sql`
      INSERT INTO portfolio (currency, symbol, amount, avg_buy_price_eur, env)
      SELECT 'EUR', 'EUR', 5000, 1, 'paper'
      WHERE NOT EXISTS (SELECT 1 FROM portfolio WHERE symbol = 'EUR' AND env = 'paper')
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
