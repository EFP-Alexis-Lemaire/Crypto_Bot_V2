type Row = Record<string, unknown>;
type Db = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;

// Table créée par scripts/migrate-v2.mjs. Tant qu'elle n'existe pas, on
// dégrade proprement (le verrou de cycle reste la protection principale).
export function isMissingSchemaError(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  if (err?.code === '42P01' || err?.code === '42703') return true;
  const message = String(err?.message ?? '').toLowerCase();
  return message.includes('does not exist') && (message.includes('relation') || message.includes('column'));
}

export type IntentStatus = 'pending' | 'sent' | 'failed' | 'failed_retryable';

export interface OrderIntentInput {
  idempotencyKey: string;
  env: string;
  cycleId: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  exchange: 'kraken' | 'coinbase';
  amountEur: number;
}

export type ClaimResult = 'claimed' | 'duplicate' | 'degraded';

// Réservation atomique AVANT l'envoi à l'exchange. Un doublon (autre cycle
// concurrent, relance du cron, double clic) ne peut pas réserver le même
// intent : l'UNIQUE + ON CONFLICT tranche côté PostgreSQL.
// Seul un échec explicitement rejouable (fonds insuffisants, aucune
// exécution possible) peut être ré-réservé ; timeout/5xx restent bloquants.
export async function claimOrderIntent(db: Db, input: OrderIntentInput): Promise<ClaimResult> {
  try {
    const rows = (await db`
      INSERT INTO order_intents
        (idempotency_key, env, cycle_id, symbol, action, exchange, amount_eur, status)
      VALUES
        (${input.idempotencyKey}, ${input.env}, ${input.cycleId}, ${input.symbol},
         ${input.action}, ${input.exchange}, ${input.amountEur}, 'pending')
      ON CONFLICT (idempotency_key) DO UPDATE
        SET status = 'pending', note = NULL, updated_at = NOW()
        WHERE order_intents.status = 'failed_retryable'
      RETURNING id
    `) as Row[];
    return rows.length === 1 ? 'claimed' : 'duplicate';
  } catch (e) {
    if (isMissingSchemaError(e)) {
      console.warn('[OrderIntent] table order_intents absente — idempotence inactive (migration non appliquée)');
      return 'degraded';
    }
    throw e;
  }
}

export async function finishOrderIntent(
  db: Db,
  idempotencyKey: string,
  status: Exclude<IntentStatus, 'pending'>,
  externalOrderId?: string | null,
  note?: string | null,
): Promise<void> {
  try {
    await db`
      UPDATE order_intents
      SET status = ${status}, external_order_id = ${externalOrderId ?? null},
          note = ${note ?? null}, updated_at = NOW()
      WHERE idempotency_key = ${idempotencyKey}
    `;
  } catch (e) {
    if (!isMissingSchemaError(e)) throw e;
  }
}
