#!/usr/bin/env node
// Synchronise les dépôts/retraits fiat Kraken (ZEUR) dans cash_flows.
// Idempotent (UNIQUE exchange+external_id). Par défaut : UAT.
//   node scripts/sync-cash-flows.ts          # UAT
//   node scripts/sync-cash-flows.ts --prod   # PROD (accord explicite requis)
import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { getKrakenLedger } from '../lib/exchanges/kraken.ts';

function loadEnvLocal() {
  const file = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[m[1]] = value;
  }
}
loadEnvLocal();

const useProd = process.argv.includes('--prod');
const url = useProd ? process.env.DATABASE_URL_PROD : process.env.DATABASE_URL;
if (!url) {
  console.error(`DATABASE_URL${useProd ? '_PROD' : ''} manquant`);
  process.exit(1);
}
const sql = neon(url);
const run = (text: string) =>
  (typeof (sql as unknown as { query?: unknown }).query === 'function'
    ? (sql as unknown as { query: (q: string) => Promise<Record<string, unknown>[]> }).query(text)
    : (sql as unknown as (a: string[]) => Promise<Record<string, unknown>[]>)([text]));

const env = 'live';
let scanned = 0;
let inserted = 0;
const deposits = await getKrakenLedger({ type: 'deposit' });
const withdrawals = await getKrakenLedger({ type: 'withdrawal' });

for (const [kind, entries] of [['deposit', deposits], ['withdrawal', withdrawals]] as const) {
  for (const entry of entries) {
    if (entry.type !== kind || !Number.isFinite(entry.amount) || entry.amount === 0) continue;
    scanned++;
    const amount = Math.abs(entry.amount);
    const rows = await sql`
      INSERT INTO cash_flows (env, exchange, kind, amount_eur, external_id, occurred_at)
      VALUES (${env}, 'kraken', ${kind}, ${amount}, ${entry.refid}, to_timestamp(${entry.time}))
      ON CONFLICT (exchange, external_id) DO NOTHING
      RETURNING id`;
    inserted += rows.length;
  }
}

console.log(`Flux Kraken scannés: ${scanned}, insérés: ${inserted}`);
console.log('Dépôts Kraken (ZEUR):');
for (const e of deposits) {
  console.log(`  ${new Date(e.time * 1000).toISOString()} +${Math.abs(e.amount).toFixed(2)}€ ref=${e.refid} subtype=${e.subtype}`);
}
console.log('Retraits Kraken (ZEUR):');
for (const e of withdrawals) {
  console.log(`  ${new Date(e.time * 1000).toISOString()} -${Math.abs(e.amount).toFixed(2)}€ ref=${e.refid} subtype=${e.subtype}`);
}

const configRows = await run(`SELECT value, updated_at FROM bot_config WHERE key = 'initial_portfolio_eur'`);
const initial = parseFloat(String(configRows[0]?.value ?? '1400'));
const editedAt = configRows[0]?.updated_at ? new Date(String(configRows[0].updated_at)).toISOString() : null;
const flowRows = editedAt
  ? await run(`SELECT kind, COALESCE(SUM(amount_eur),0) AS total FROM cash_flows WHERE env = 'live' AND occurred_at > '${editedAt}' GROUP BY kind`)
  : await run(`SELECT kind, COALESCE(SUM(amount_eur),0) AS total FROM cash_flows WHERE env = 'live' GROUP BY kind`);
let dep = 0;
let wit = 0;
for (const row of flowRows) {
  if (row.kind === 'deposit') dep += Number(row.total);
  if (row.kind === 'withdrawal') wit += Number(row.total);
}
console.log('');
console.log(`Référence: ${initial.toFixed(2)}€ (éditée ${editedAt ?? 'jamais'}) | flux postérieurs: +${dep.toFixed(2)}€ / -${wit.toFixed(2)}€`);
console.log(`Capital versé retenu: ${(initial + dep - wit).toFixed(2)}€`);
