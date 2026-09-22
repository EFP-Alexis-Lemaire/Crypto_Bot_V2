import { NextResponse } from 'next/server';
import { sqlForContext, getDbContext } from '@/lib/db';

/**
 * Safe migration — adds missing columns and backfills NULL env values.
 * Supports X-DB-Context header to run on UAT or PROD database.
 * Call /api/migrate with header X-DB-Context: prod to migrate the prod DB.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get('ctx') ?? url.searchParams.get('db');
  const ctx = (q === 'uat' || q === 'prod') ? q : getDbContext(request);
  const sql = sqlForContext(ctx);
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

    // 5c. Index unique requis par les upserts ON CONFLICT (symbol, env)
    // (portfolio.ts + live-trader.ts). Sans lui : erreur 42P10 "no unique or
    // exclusion constraint matching the ON CONFLICT specification" à chaque sync.
    // D'abord dédupliquer (garder la ligne la plus récente par couple symbol/env),
    // sinon la création de l'index échoue sur les DB existantes.
    try {
      await sql`
        DELETE FROM portfolio a USING portfolio b
        WHERE a.id < b.id
        AND a.symbol = b.symbol
        AND a.env = b.env
      `;
      migrations.push('portfolio: doublons (symbol, env) supprimés');
    } catch { migrations.push('portfolio dedup (symbol, env): skipped'); }
    try {
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS portfolio_symbol_env_uidx ON portfolio (symbol, env)`;
      migrations.push('portfolio_symbol_env_uidx: index unique créé');
    } catch { migrations.push('portfolio_symbol_env_uidx: skipped'); }

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

    // 7. portfolio.partial_tp_taken : flag "TP partiel 50% déjà pris" (take-profits par paliers)
    try {
      await sql`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS partial_tp_taken BOOLEAN NOT NULL DEFAULT FALSE`;
      migrations.push('portfolio.partial_tp_taken: colonne créée');
    } catch { migrations.push('portfolio.partial_tp_taken: skipped'); }

    // 8. portfolio.highest_price_eur : plus haut atteint depuis l'achat (trailing stop)
    try {
      await sql`ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS highest_price_eur DECIMAL(20, 8)`;
      migrations.push('portfolio.highest_price_eur: colonne créée');
    } catch { migrations.push('portfolio.highest_price_eur: skipped'); }

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
