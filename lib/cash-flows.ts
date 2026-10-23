import { isMissingSchemaError } from './order-intents';
import { getKrakenLedger } from './exchanges/kraken';

type Row = Record<string, unknown>;
type Db = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;

export interface NetContributions {
  initial: number;
  deposits: number;
  withdrawals: number;
  total: number;
  inception: string | null;
  basis: 'flows' | 'config';
  complete: boolean;
}

export interface SyncCashFlowsResult {
  scanned: number;
  inserted: number;
  error?: string;
}

// Verbatim des types de ledger fiat à importer. Les mouvements internes
// (trade, receive, spend, conversion) et les frais de ledger ne sont PAS des
// versements/retraits de capital : les inclure fausserait le P&L.
const CASH_FLOW_TYPES = ['deposit', 'withdrawal'] as const;

// Importe les dépôts/retraits fiat Kraken (ZEUR) dans cash_flows.
// Idempotent : external_id (refid Kraken) unique par exchange.
export async function syncKrakenCashFlows(db: Db, env: string): Promise<SyncCashFlowsResult> {
  let scanned = 0;
  let inserted = 0;
  try {
    for (const type of CASH_FLOW_TYPES) {
      const entries = await getKrakenLedger({ type });
      for (const entry of entries) {
        if (entry.type !== type) continue;
        if (!Number.isFinite(entry.amount) || entry.amount === 0) continue;
        scanned++;
        const amountEur = Math.abs(entry.amount);
        const rows = (await db`
          INSERT INTO cash_flows (env, exchange, kind, amount_eur, external_id, occurred_at)
          VALUES (${env}, 'kraken', ${type}, ${amountEur}, ${entry.refid},
                  to_timestamp(${entry.time}))
          ON CONFLICT (exchange, external_id) DO NOTHING
          RETURNING id
        `) as Row[];
        inserted += rows.length;
      }
    }
    return { scanned, inserted };
  } catch (e) {
    if (isMissingSchemaError(e)) {
      return { scanned, inserted, error: 'table cash_flows absente (migration non appliquée)' };
    }
    return { scanned, inserted, error: e instanceof Error ? e.message : String(e) };
  }
}

// Capital réellement versé : référence (`initial_portfolio_eur`, déjà ajustée
// par l'utilisateur lors d'un virement/retrait) + dépôts/retraits survenus
// APRÈS la dernière édition de cette référence. Les mouvements antérieurs sont
// déjà intégrés à la référence : les recompter gonflerait le capital et ferait
// apparaître une fausse perte.
// `flowSince` = date de dernière édition de `initial_portfolio_eur` ; à défaut,
// on retombe sur le premier trade live.
export async function getNetContributions(
  db: Db,
  env: string,
  initialConfig: number,
  flowSince?: string | null,
): Promise<NetContributions> {
  const fallback: NetContributions = {
    initial: initialConfig,
    deposits: 0,
    withdrawals: 0,
    total: initialConfig,
    inception: flowSince ?? null,
    basis: 'config',
    complete: false,
  };
  try {
    const inceptionRows = (await db`
      SELECT MIN(executed_at) AS at FROM trades WHERE env = ${env}
    `) as Row[];
    const rawInception = inceptionRows[0]?.at;
    const tradeInception = rawInception
      ? new Date(rawInception as string | number | Date).toISOString()
      : null;
    const since = flowSince ?? tradeInception;
    const strict = flowSince != null;

    const flows = (since
      ? strict
        ? await db`
            SELECT kind, COALESCE(SUM(amount_eur), 0) AS total, COUNT(*) AS n
            FROM cash_flows
            WHERE env = ${env} AND occurred_at > ${since}
            GROUP BY kind
          `
        : await db`
            SELECT kind, COALESCE(SUM(amount_eur), 0) AS total, COUNT(*) AS n
            FROM cash_flows
            WHERE env = ${env} AND occurred_at >= ${since}
            GROUP BY kind
          `
      : await db`
          SELECT kind, COALESCE(SUM(amount_eur), 0) AS total, COUNT(*) AS n
          FROM cash_flows
          WHERE env = ${env}
          GROUP BY kind
        `) as Row[];

    let deposits = 0;
    let withdrawals = 0;
    for (const row of flows) {
      const total = parseFloat(String(row.total ?? 0)) || 0;
      if (row.kind === 'deposit') deposits += total;
      if (row.kind === 'withdrawal') withdrawals += total;
    }

    return {
      initial: initialConfig,
      deposits,
      withdrawals,
      total: initialConfig + deposits - withdrawals,
      inception: since,
      basis: 'flows',
      complete: true,
    };
  } catch (e) {
    if (!isMissingSchemaError(e)) {
      console.error('[CashFlows] calcul du capital versé impossible:', e instanceof Error ? e.message : String(e));
    }
    return fallback;
  }
}
