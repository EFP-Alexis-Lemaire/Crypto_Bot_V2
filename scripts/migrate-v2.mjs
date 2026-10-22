#!/usr/bin/env node
// Migration ADDITIVE (aucun DELETE/UPDATE de données métier).
// Par défaut : UAT (DATABASE_URL). PROD uniquement avec --prod explicite.
//
//   node scripts/migrate-v2.mjs          # UAT
//   node scripts/migrate-v2.mjs --prod   # PROD (accord explicite requis)
import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';

const useProd = process.argv.includes('--prod');

function loadEnvLocal() {
  const file = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
}
loadEnvLocal();

const url = useProd ? process.env.DATABASE_URL_PROD : process.env.DATABASE_URL;
if (!url) {
  console.error(`DATABASE_URL${useProd ? '_PROD' : ''} manquant`);
  process.exit(1);
}

const sql = neon(url);
const run = (text) => (typeof sql.query === 'function' ? sql.query(text) : sql([text]));

const statements = [
  // TP partiel : persistance du palier (sinon le TP 50% peut se répéter)
  `ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS partial_tp_taken BOOLEAN NOT NULL DEFAULT FALSE`,
  // Trailing : plus haut depuis l'achat (NULL = à initialiser, jamais de vente surprise)
  `ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS highest_price_eur NUMERIC`,
  // Traçabilité de l'exécution réelle
  `ALTER TABLE trades ADD COLUMN IF NOT EXISTS exchange VARCHAR(20)`,
  `ALTER TABLE trades ADD COLUMN IF NOT EXISTS external_order_id TEXT`,
  `ALTER TABLE trades ADD COLUMN IF NOT EXISTS fee_source VARCHAR(10)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS trades_env_external_order_uidx
     ON trades (env, external_order_id) WHERE external_order_id IS NOT NULL`,
  // Réservation d'ordres (idempotence)
  `CREATE TABLE IF NOT EXISTS order_intents (
     id BIGSERIAL PRIMARY KEY,
     idempotency_key TEXT NOT NULL UNIQUE,
     env VARCHAR(10) NOT NULL,
     cycle_id TEXT NOT NULL,
     symbol VARCHAR(20) NOT NULL,
     action VARCHAR(10) NOT NULL,
     exchange VARCHAR(20) NOT NULL,
     amount_eur NUMERIC NOT NULL,
     status VARCHAR(20) NOT NULL DEFAULT 'pending',
     external_order_id TEXT,
     note TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS order_intents_cycle_idx ON order_intents (env, cycle_id)`,
  // Flux de capital (P&L net des versements)
  `CREATE TABLE IF NOT EXISTS cash_flows (
     id BIGSERIAL PRIMARY KEY,
     env VARCHAR(10) NOT NULL,
     exchange VARCHAR(20) NOT NULL,
     kind VARCHAR(20) NOT NULL,
     amount_eur NUMERIC NOT NULL,
     external_id TEXT NOT NULL,
     occurred_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (exchange, external_id)
   )`,
  `CREATE INDEX IF NOT EXISTS cash_flows_env_idx ON cash_flows (env, occurred_at)`,
];

const checks = [
  { label: 'portfolio.partial_tp_taken', query: `SELECT 1 FROM information_schema.columns WHERE table_name='portfolio' AND column_name='partial_tp_taken'` },
  { label: 'portfolio.highest_price_eur', query: `SELECT 1 FROM information_schema.columns WHERE table_name='portfolio' AND column_name='highest_price_eur'` },
  { label: 'trades.exchange', query: `SELECT 1 FROM information_schema.columns WHERE table_name='trades' AND column_name='exchange'` },
  { label: 'trades.external_order_id', query: `SELECT 1 FROM information_schema.columns WHERE table_name='trades' AND column_name='external_order_id'` },
  { label: 'trades.fee_source', query: `SELECT 1 FROM information_schema.columns WHERE table_name='trades' AND column_name='fee_source'` },
  { label: 'order_intents', query: `SELECT 1 FROM information_schema.tables WHERE table_name='order_intents'` },
  { label: 'cash_flows', query: `SELECT 1 FROM information_schema.tables WHERE table_name='cash_flows'` },
];

function hostOf(u) {
  try { return new URL(u).host; } catch { return 'inconnu'; }
}

console.log(`Migration v2 — cible: ${useProd ? 'PROD' : 'UAT'} (${hostOf(url)})`);
for (const text of statements) {
  await run(text);
  console.log(`  OK  ${text.split('\n')[0].trim().slice(0, 90)}`);
}

let missing = 0;
for (const check of checks) {
  const rows = await run(check.query);
  const ok = Array.isArray(rows) && rows.length > 0;
  if (!ok) missing++;
  console.log(`  ${ok ? 'OK  ' : 'KO  '} ${check.label}`);
}

if (missing > 0) {
  console.error(`Migration incomplète : ${missing} objet(s) manquant(s)`);
  process.exit(1);
}
console.log('Migration v2 terminée (additive, idempotente).');
