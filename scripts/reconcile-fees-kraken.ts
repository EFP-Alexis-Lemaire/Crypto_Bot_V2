#!/usr/bin/env node
// Recalcul des frais/prix réels Kraken sur TOUT l'historique, sur une COPIE DE
// TEST (table `trades_backfill_sim` dans UAT). Aucune écriture sur PROD :
// PROD est uniquement lu (trades + config). Kraken est uniquement lu.
//
//   node scripts/reconcile-fees-kraken.ts
//
// Sortie : rapport avant/après (frais, réalisé FIFO, écart par symbole) +
// JSON détaillé dans %TEMP%/opencode/reconcile-fees-kraken.json.
import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { computeFifo } from '../lib/fifo.ts';
import { krakenPrivateRequest } from '../lib/exchanges/kraken.ts';
import {
  normalizeKrakenPair,
  reconcileKrakenFills,
  type KrakenFill,
  type RecordedTrade,
} from '../lib/fee-reconcile.ts';

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

const prodUrl = process.env.DATABASE_URL_PROD;
const uatUrl = process.env.DATABASE_URL;
if (!prodUrl || !uatUrl) {
  console.error('DATABASE_URL_PROD et DATABASE_URL requis');
  process.exit(1);
}
if (prodUrl === uatUrl) {
  console.error('UAT et PROD identiques : copie de test impossible, arrêt');
  process.exit(1);
}

const prod = neon(prodUrl);
const uat = neon(uatUrl);
const run = (sql: typeof prod, text: string) =>
  (typeof (sql as unknown as { query?: unknown }).query === 'function'
    ? (sql as unknown as { query: (q: string) => Promise<Record<string, unknown>[]> }).query(text)
    : (sql as unknown as (a: string[]) => Promise<Record<string, unknown>[]>)([text]));

// --- Kraken (lecture seule) -------------------------------------------------
async function fetchKrakenFills(startSec: number): Promise<KrakenFill[]> {
  const fills: KrakenFill[] = [];
  let offset = 0;
  let total = Infinity;
  while (fills.length < total && offset < 5000) {
    const result = await krakenPrivateRequest<{
      trades?: Record<string, {
        ordertxid: string; pair: string; time: number; type: string;
        vol: string; cost: string; fee: string;
      }>;
      count?: number;
    }>('TradesHistory', { start: startSec, ofs: offset });
    const rows = Object.entries(result.trades ?? {});
    total = Number(result.count ?? rows.length);
    for (const [txid, t] of rows) {
      const side = t.type === 'buy' ? 'BUY' : t.type === 'sell' ? 'SELL' : null;
      if (!side) continue;
      fills.push({
        txid,
        ordertxid: t.ordertxid,
        time: Number(t.time),
        side,
        symbol: normalizeKrakenPair(t.pair),
        vol: parseFloat(t.vol),
        cost: parseFloat(t.cost),
        fee: parseFloat(t.fee),
      });
    }
    if (rows.length === 0) break;
    offset += rows.length;
  }
  return fills;
}

// --- 1. Lire PROD (aucune écriture) ----------------------------------------
const tradeRows = await run(prod, `
  SELECT id, symbol, action, amount, total_eur, fee_eur, executed_at, reasoning
  FROM trades WHERE env = 'live' ORDER BY executed_at, id
`);
const trades: RecordedTrade[] = tradeRows.map(r => ({
  id: Number(r.id),
  symbol: String(r.symbol),
  action: String(r.action),
  amount: Number(r.amount),
  total_eur: Number(r.total_eur),
  fee_eur: Number(r.fee_eur ?? 0),
  executed_at: new Date(r.executed_at as string).toISOString(),
}));

// --- 2. Lire Kraken (fills réels) ------------------------------------------
const startSec = Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000);
const fills = await fetchKrakenFills(startSec);

// --- 3. Rapprochement pur --------------------------------------------------
const reconciliation = reconcileKrakenFills(trades, fills);

// --- 4. Copie de test dans UAT --------------------------------------------
await run(uat, `DROP TABLE IF EXISTS trades_backfill_sim`);
await run(uat, `
  CREATE TABLE trades_backfill_sim (
    id INTEGER PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    action VARCHAR(10) NOT NULL,
    amount NUMERIC,
    total_eur NUMERIC,
    fee_eur NUMERIC,
    executed_at TIMESTAMPTZ NOT NULL
  )
`);
const esc = (v: string) => `'${v.replace(/'/g, "''")}'`;
const values = trades
  .map(t => `(${t.id}, ${esc(t.symbol)}, ${esc(t.action)}, ${t.amount}, ${t.total_eur}, ${t.fee_eur}, ${esc(t.executed_at)}::timestamptz)`)
  .join(',\n');
await run(uat, `INSERT INTO trades_backfill_sim (id, symbol, action, amount, total_eur, fee_eur, executed_at) VALUES ${values}`);

const correctedById = new Map(reconciliation.corrected.filter(c => c.corrected).map(c => [c.id, c]));
for (const c of correctedById.values()) {
  await run(uat, `UPDATE trades_backfill_sim SET amount = ${c.amount}, total_eur = ${c.total_eur}, fee_eur = ${c.fee_eur} WHERE id = ${c.id}`);
}

const simRows = await run(uat, `SELECT id, symbol, action, amount, total_eur, fee_eur, executed_at FROM trades_backfill_sim ORDER BY executed_at, id`);
const after: RecordedTrade[] = simRows.map(r => ({
  id: Number(r.id),
  symbol: String(r.symbol),
  action: String(r.action),
  amount: Number(r.amount),
  total_eur: Number(r.total_eur),
  fee_eur: Number(r.fee_eur ?? 0),
  executed_at: new Date(r.executed_at as string).toISOString(),
}));

// --- 5. Rapport avant/après -----------------------------------------------
const fifoBefore = computeFifo(trades);
const fifoAfter = computeFifo(after);
const sumRealized = (perSymbol: Record<string, { realized_eur: number }>) =>
  Number(Object.values(perSymbol).reduce((s, v) => s + v.realized_eur, 0).toFixed(2));
const realizedBefore = sumRealized(fifoBefore.perSymbol);
const realizedAfter = sumRealized(fifoAfter.perSymbol);

console.log('=== Réconciliation frais Kraken (copie de test UAT) ===');
console.log(`Trades live PROD (lecture seule): ${trades.length}`);
console.log(`Fills Kraken récupérés: ${fills.length}`);
console.log(`Appariés: ${reconciliation.matched} | fills non appariés: ${reconciliation.unmatchedFills.length} | trades non appariés: ${reconciliation.unmatchedTrades.length}`);
console.log('');
console.log(`Frais enregistrés (appariés): ${reconciliation.feesRecorded.toFixed(2)}€`);
console.log(`Frais réels Kraken (appariés): ${reconciliation.feesReal.toFixed(2)}€`);
console.log(`Écart frais: ${(reconciliation.feesReal - reconciliation.feesRecorded).toFixed(2)}€`);
console.log(`Écart cash cumulé (total_eur corrigé - enregistré): ${reconciliation.deltaTotal.toFixed(2)}€`);
console.log('');
console.log(`Réalisé FIFO avant: ${realizedBefore.toFixed(2)}€`);
console.log(`Réalisé FIFO après: ${realizedAfter.toFixed(2)}€`);
console.log(`Écart réalisé: ${(realizedAfter - realizedBefore).toFixed(2)}€`);
console.log('');
console.log('Par symbole (réalisé avant -> après):');
const symbols = [...new Set([...Object.keys(fifoBefore.perSymbol), ...Object.keys(fifoAfter.perSymbol)])].sort();
for (const symbol of symbols) {
  const before = fifoBefore.perSymbol[symbol]?.realized_eur ?? 0;
  const afterValue = fifoAfter.perSymbol[symbol]?.realized_eur ?? 0;
  if (Math.abs(afterValue - before) < 0.005) continue;
  console.log(`  ${symbol.padEnd(6)} ${before.toFixed(2).padStart(9)} -> ${afterValue.toFixed(2).padStart(9)}  (${(afterValue - before).toFixed(2)})`);
}
console.log('');
console.log('Top 10 écarts de frais:');
for (const c of [...reconciliation.corrected].sort((a, b) => b.delta_fee_eur - a.delta_fee_eur).slice(0, 10)) {
  if (c.delta_fee_eur <= 0.001) continue;
  console.log(`  #${c.id} ${c.symbol} ${c.action} frais ${c.fee_eur.toFixed(3)}€ (+${c.delta_fee_eur.toFixed(3)}) total ${c.total_eur.toFixed(2)}€ txid=${c.txid}`);
}
if (reconciliation.unmatchedFills.length > 0) {
  console.log('');
  console.log('Fills Kraken sans ligne DB (mouvements manuels/hors bot):');
  for (const f of reconciliation.unmatchedFills.slice(0, 15)) {
    console.log(`  ${new Date(f.time * 1000).toISOString()} ${f.side} ${f.symbol} vol=${f.vol} cost=${f.cost} fee=${f.fee}`);
  }
}

const outDir = path.resolve(process.env.TEMP ?? process.env.TMP ?? '.', 'opencode');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'reconcile-fees-kraken.json');
fs.writeFileSync(outFile, JSON.stringify({
  generated_at: new Date().toISOString(),
  trades: trades.length,
  fills: fills.length,
  matched: reconciliation.matched,
  unmatched_fills: reconciliation.unmatchedFills,
  unmatched_trades: reconciliation.unmatchedTrades,
  fees_recorded: reconciliation.feesRecorded,
  fees_real: reconciliation.feesReal,
  delta_total: reconciliation.deltaTotal,
  realized_before: realizedBefore,
  realized_after: realizedAfter,
  per_symbol_before: fifoBefore.perSymbol,
  per_symbol_after: fifoAfter.perSymbol,
  corrected: reconciliation.corrected.filter(c => c.corrected),
}, null, 2));
console.log('');
console.log(`Détail JSON: ${outFile}`);
console.log('PROD non modifié. Copie de test UAT: table trades_backfill_sim.');
