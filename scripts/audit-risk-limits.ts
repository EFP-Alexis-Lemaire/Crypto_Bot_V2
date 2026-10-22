#!/usr/bin/env node
// Audit LECTURE SEULE des limites de risque sur l'historique live.
//   node scripts/audit-risk-limits.ts          # PROD (lecture seule)
//   node scripts/audit-risk-limits.ts --uat    # UAT
// Aucune écriture, aucun ordre : uniquement des SELECT.
import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { auditRiskLimits, type AuditSnapshot, type AuditTrade } from '../lib/risk-checks.ts';
import { RISK_CONFIGS, type RiskLevel } from '../lib/types.ts';

const useUat = process.argv.includes('--uat');

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

const url = useUat ? process.env.DATABASE_URL : process.env.DATABASE_URL_PROD;
if (!url) {
  console.error(`DATABASE_URL${useUat ? '' : '_PROD'} manquant`);
  process.exit(1);
}
const sql = neon(url);
const run = (text: string) => (typeof (sql as unknown as { query?: unknown }).query === 'function'
  ? (sql as unknown as { query: (q: string) => Promise<Record<string, unknown>[]> }).query(text)
  : (sql as unknown as (a: string[]) => Promise<Record<string, unknown>[]>)([text]));

const configRows = await run(`SELECT key, value FROM bot_config`);
const config: Record<string, string> = {};
for (const row of configRows) config[String(row.key)] = String(row.value);

const tradeRows = await run(`
  SELECT symbol, action, amount, total_eur, executed_at, reasoning
  FROM trades WHERE env = 'live' ORDER BY executed_at
`);
const snapshotRows = await run(`
  SELECT snapshotted_at, total_value_eur, cash_eur, holdings
  FROM portfolio_snapshots WHERE env = 'live' ORDER BY snapshotted_at
`);

const trades: AuditTrade[] = tradeRows.map(r => ({
  symbol: String(r.symbol),
  action: String(r.action),
  amount: Number(r.amount),
  total_eur: Number(r.total_eur),
  executed_at: new Date(r.executed_at as string).toISOString(),
  reasoning: r.reasoning ? String(r.reasoning) : undefined,
}));
const snapshots: AuditSnapshot[] = snapshotRows.map(r => ({
  captured_at: new Date(r.snapshotted_at as string).toISOString(),
  total_value_eur: Number(r.total_value_eur),
  cash_eur: Number(r.cash_eur),
  holdings: r.holdings,
}));

const maxTradesPerDay = Number(config.max_trades_per_day ?? 10);
const riskLevel = (config.risk_level ?? 'conservative') as RiskLevel;
const maxPositionPct = RISK_CONFIGS[riskLevel]?.max_position_size_pct;

const result = auditRiskLimits({
  trades,
  snapshots,
  maxTradesPerDay,
  maxPositionPct,
});

console.log(`Audit limites de risque — ${useUat ? 'UAT' : 'PROD'} (lecture seule)`);
console.log(`  config: max_trades_per_day=${maxTradesPerDay}, risk_level=${config.risk_level ?? '?'}, stop_loss_pct=${config.stop_loss_pct ?? '?'}, take_profit_pct=${config.take_profit_pct ?? '?'}`);
console.log(`  trades live: ${result.trades} sur ${result.days} jours (${(result.trades / Math.max(result.days, 1)).toFixed(2)}/jour)`);
console.log(`  sorties stop-loss/trailing: ${result.stop_loss_sells}, take-profit: ${result.take_profit_sells}`);
console.log(`  concentration max: ${result.max_position_pct}%`);
console.log('');
console.log('Jours au-dessus de la limite:');
for (const d of result.trades_per_day.filter(x => x.over_limit)) {
  console.log(`  - ${d.day}: ${d.count} trades`);
}
console.log('Doublons potentiels:');
for (const d of result.duplicate_candidates) {
  console.log(`  - ${d.symbol} ${d.action} x${d.count} ~${d.total_eur}€ à ${d.delta_ms}ms d'écart (${d.first_at} / ${d.second_at})`);
}
console.log('');
if (result.violations.length === 0) {
  console.log('Aucune violation détectée.');
} else {
  console.log(`${result.violations.length} violation(s):`);
  for (const v of result.violations) console.log(`  ! ${v}`);
  if (process.argv.includes('--fail-on-violations')) process.exit(2);
}
