import { isMissingSchemaError } from './order-intents';

type Row = Record<string, unknown>;
type Db = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;

export type PartialTpClaim = 'claimed' | 'already' | 'unsupported';

// Réclamation atomique du TP partiel : un seul cycle peut passer de
// non-fait à fait. Sans ce garde-fou, deux cycles concurrents (ou un retry)
// pouvaient vendre 50 % deux fois de suite.
export async function claimPartialTp(db: Db, env: string, symbol: string): Promise<PartialTpClaim> {
  try {
    const rows = (await db`
      UPDATE portfolio SET partial_tp_taken = TRUE
      WHERE env = ${env} AND symbol = ${symbol}
        AND (partial_tp_taken = FALSE OR partial_tp_taken IS NULL)
      RETURNING id
    `) as Row[];
    return rows.length > 0 ? 'claimed' : 'already';
  } catch (e) {
    if (isMissingSchemaError(e)) {
      console.warn('[PartialTP] colonne partial_tp_taken absente — vente partielle refusée par sécurité');
      return 'unsupported';
    }
    throw e;
  }
}

export async function releasePartialTp(db: Db, env: string, symbol: string): Promise<void> {
  try {
    await db`
      UPDATE portfolio SET partial_tp_taken = FALSE
      WHERE env = ${env} AND symbol = ${symbol} AND partial_tp_taken = TRUE
    `;
  } catch (e) {
    if (!isMissingSchemaError(e)) throw e;
  }
}
