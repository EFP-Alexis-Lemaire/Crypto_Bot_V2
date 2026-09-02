/**
 * Script d'initialisation de la base de données de production.
 * Lance avec : node scripts/init-prod-db.mjs
 * Nécessite DATABASE_URL_PROD dans .env.local
 */

import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Lire .env.local manuellement
const envPath = resolve(__dirname, '../.env.local');
const envContent = readFileSync(envPath, 'utf-8');
const envVars = Object.fromEntries(
  envContent
    .split('\n')
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    })
);

const url = envVars['DATABASE_URL_PROD'];
if (!url || url === 'your_prod_neon_database_url_here') {
  console.error('❌ DATABASE_URL_PROD non configurée dans .env.local');
  process.exit(1);
}

console.log('🔗 Connexion à la DB prod...');
const db = neon(url);

async function run() {
  try {
    // 1. Portfolio
    await db`
      CREATE TABLE IF NOT EXISTS portfolio (
        id SERIAL PRIMARY KEY,
        currency VARCHAR(10) NOT NULL,
        symbol VARCHAR(20) NOT NULL,
        amount DECIMAL(20, 8) NOT NULL DEFAULT 0,
        avg_buy_price_eur DECIMAL(20, 8) NOT NULL DEFAULT 0,
        env VARCHAR(10) NOT NULL DEFAULT 'paper',
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `;
    console.log('✅ Table portfolio créée');

    // 2. Trades
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
        env VARCHAR(10) NOT NULL DEFAULT 'paper',
        executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `;
    console.log('✅ Table trades créée');

    // 3. Bot decisions
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
        env VARCHAR(10) NOT NULL DEFAULT 'paper',
        decided_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `;
    console.log('✅ Table bot_decisions créée');

    // 4. Portfolio snapshots
    await db`
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id SERIAL PRIMARY KEY,
        total_value_eur DECIMAL(20, 8) NOT NULL,
        cash_eur DECIMAL(20, 8) NOT NULL,
        crypto_value_eur DECIMAL(20, 8) NOT NULL,
        pnl_eur DECIMAL(20, 8) NOT NULL,
        pnl_percent DECIMAL(10, 4) NOT NULL,
        holdings JSONB,
        env VARCHAR(10) NOT NULL DEFAULT 'paper',
        snapshotted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `;
    console.log('✅ Table portfolio_snapshots créée');

    // 5. Bot config
    await db`
      CREATE TABLE IF NOT EXISTS bot_config (
        id SERIAL PRIMARY KEY,
        key VARCHAR(100) UNIQUE NOT NULL,
        value TEXT NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `;
    console.log('✅ Table bot_config créée');

    // 6. AI costs
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
    console.log('✅ Table ai_costs créée');

    // 7. Morning reports
    await db`
      CREATE TABLE IF NOT EXISTS morning_reports (
        id SERIAL PRIMARY KEY,
        report_date DATE UNIQUE NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `;
    console.log('✅ Table morning_reports créée');

    // 8. Config par défaut
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
    console.log('✅ Config par défaut insérée');

    // 9. Portfolio EUR initial (paper + live)
    await db`
      INSERT INTO portfolio (currency, symbol, amount, avg_buy_price_eur, env)
      VALUES
        ('EUR', 'EUR', 5000, 1, 'paper'),
        ('EUR', 'EUR', 0, 1, 'live')
      ON CONFLICT DO NOTHING
    `;
    console.log('✅ Portfolio initial créé (paper: 5000€, live: 0€ — sera sync depuis exchange)');

    console.log('\n🎉 Base de données prod initialisée avec succès !');
    console.log('   → Pense à appeler /api/migrate sur le déploiement prod pour toute migration future.');
  } catch (err) {
    console.error('❌ Erreur:', err);
    process.exit(1);
  }
}

run();
