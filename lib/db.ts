import { neon } from '@neondatabase/serverless';

// Lazy initialization to avoid build-time errors when DATABASE_URL is not set
let _sql: ReturnType<typeof neon> | null = null;

function getSQL() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url || url === 'your_neon_database_url_here') {
      throw new Error(
        'DATABASE_URL is not configured. Please add it to your .env.local file.'
      );
    }
    _sql = neon(url);
  }
  return _sql;
}

// Typed query result row
export type Row = Record<string, unknown>;

// Typed query helper - returns typed rows
export async function query<T extends Row = Row>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<T[]> {
  const db = getSQL();
  const result = await db(strings, ...values);
  return result as unknown as T[];
}

// Keep sql as a template tag for compatibility
export const sql = (strings: TemplateStringsArray, ...values: unknown[]) =>
  query(strings, ...values);

export async function initializeDatabase() {
  const db = getSQL();

  // Portfolio table
  await db`
    CREATE TABLE IF NOT EXISTS portfolio (
      id SERIAL PRIMARY KEY,
      currency VARCHAR(10) NOT NULL,
      symbol VARCHAR(20) NOT NULL,
      amount DECIMAL(20, 8) NOT NULL DEFAULT 0,
      avg_buy_price_eur DECIMAL(20, 8) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `;

  // Trades history
  await db`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(20) NOT NULL,
      action VARCHAR(10) NOT NULL,
      amount DECIMAL(20, 8) NOT NULL,
      price_eur DECIMAL(20, 8) NOT NULL,
      price_usd DECIMAL(20, 8),
      eur_usd_rate DECIMAL(10, 6),
      total_eur DECIMAL(20, 8) NOT NULL,
      fee_eur DECIMAL(20, 8) DEFAULT 0,
      mode VARCHAR(10) NOT NULL DEFAULT 'paper',
      reasoning TEXT,
      confidence INTEGER,
      executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `;

  // Bot decisions log
  await db`
    CREATE TABLE IF NOT EXISTS bot_decisions (
      id SERIAL PRIMARY KEY,
      cycle_id VARCHAR(50) NOT NULL,
      symbol VARCHAR(20),
      action VARCHAR(10) NOT NULL,
      reasoning TEXT NOT NULL,
      market_data JSONB,
      news_summary TEXT,
      technical_indicators JSONB,
      confidence INTEGER,
      risk_score INTEGER,
      model_used VARCHAR(50),
      decided_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `;

  // Portfolio snapshots
  await db`
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id SERIAL PRIMARY KEY,
      total_value_eur DECIMAL(20, 8) NOT NULL,
      cash_eur DECIMAL(20, 8) NOT NULL,
      crypto_value_eur DECIMAL(20, 8) NOT NULL,
      pnl_eur DECIMAL(20, 8) NOT NULL,
      pnl_percent DECIMAL(10, 4) NOT NULL,
      holdings JSONB,
      snapshotted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `;

  // Bot config
  await db`
    CREATE TABLE IF NOT EXISTS bot_config (
      id SERIAL PRIMARY KEY,
      key VARCHAR(100) UNIQUE NOT NULL,
      value TEXT NOT NULL,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `;

  // Insert default config
  await db`
    INSERT INTO bot_config (key, value) VALUES
      ('risk_level', 'moderate'),
      ('trading_mode', 'paper'),
      ('max_trades_per_day', '5'),
      ('max_position_size_pct', '20'),
      ('stop_loss_pct', '8'),
      ('take_profit_pct', '15'),
      ('initial_portfolio_eur', '5000'),
      ('is_active', 'true')
    ON CONFLICT (key) DO NOTHING
  `;

  // Initialize paper portfolio with EUR cash
  await db`
    INSERT INTO portfolio (currency, symbol, amount, avg_buy_price_eur)
    VALUES ('EUR', 'EUR', 5000, 1)
    ON CONFLICT DO NOTHING
  `;

  // AI costs tracking table
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

  console.log('Database initialized successfully');
}
