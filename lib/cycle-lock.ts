type Row = Record<string, unknown>;
type Db = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;

export const CYCLE_LOCK_KEY = 'cycle_running_since';
// Un cycle qui dure plus longtemps est considéré comme planté (verrou périmé)
export const LOCK_TTL_MS = 10 * 60 * 1000;

// Verrou anti-chevauchement des cycles d'analyse (cron auto + bouton Analyser
// manuel + crons qui se chevauchent). Sans ça, deux cycles lisent les mêmes
// soldes, routent vers le même exchange, et le second se prend
// "Insufficient funds" (cas SUI/UNI : même montant, un seul passe).
// Scopé par DB (ctx) : UAT et PROD ne se bloquent pas mutuellement.
// Libération OBLIGATOIRE via releaseCycleLock (finally).
//
// L'acquisition est un seul aller-retour SQL conditionnel (INSERT ... ON
// CONFLICT ... WHERE périmé ... RETURNING). Deux cycles concurrents ne
// peuvent pas gagner : PostgreSQL sérialise l'écriture sur la ligne et un
// seul INSERT/UPDATE satisfait la condition de péremption.
// Fail-closed : si la DB est injoignable on ne lance PAS le cycle, car on ne
// peut alors ni lire les soldes ni tracer les ordres de façon fiable.

export interface CycleLockOptions {
  key?: string;
  ttlMs?: number;
  log?: (message: string) => void;
}

function parseLockValue(value: unknown): { since: number; owner: string | null } {
  const raw = String(value ?? '');
  if (!raw) return { since: 0, owner: null };
  // Format v2 : "<timestamp>|<cycleId>". Format v1 : "<timestamp>".
  const [tsPart, ...rest] = raw.split('|');
  const since = /^\d+$/.test(tsPart) ? Number(tsPart) : 0;
  const owner = rest.length > 0 ? rest.join('|') || null : null;
  return { since, owner };
}

export function createCycleLock(options: CycleLockOptions = {}) {
  const key = options.key ?? CYCLE_LOCK_KEY;
  const ttlMs = options.ttlMs ?? LOCK_TTL_MS;
  const log = options.log ?? ((message: string) => console.log(message));

  async function acquire(db: Db, cycleId: string): Promise<boolean> {
    const now = Date.now();
    const staleBefore = now - ttlMs;
    const value = `${now}|${cycleId}`;
    try {
      const rows = (await db`
        INSERT INTO bot_config (key, value, updated_at)
        VALUES (${key}, ${value}, NOW())
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW()
          WHERE CASE
            WHEN split_part(bot_config.value, '|', 1) ~ '^[0-9]+$'
            THEN split_part(bot_config.value, '|', 1)::bigint
            ELSE 0
          END < ${staleBefore}
        RETURNING value
      `) as Row[];
      if (rows.length === 1) return true;

      const current = (await db`SELECT value FROM bot_config WHERE key = ${key}`) as Row[];
      const { since, owner } = parseLockValue(current[0]?.value);
      const heldBy = owner ?? 'inconnu';
      const sinceLabel = since > 0 ? new Date(since).toISOString() : 'date inconnue';
      log(`[CycleLock] Cycle ${cycleId} ignoré — verrou tenu par ${heldBy} depuis ${sinceLabel} (TTL ${Math.round(ttlMs / 60000)} min)`);
      return false;
    } catch (e) {
      log(`[CycleLock] acquire impossible (DB) — cycle ${cycleId} NON lancé par sécurité: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  async function release(db: Db, cycleId?: string): Promise<void> {
    try {
      if (cycleId) {
        // Ne libère que si on est bien le détenteur (évite qu'un cycle lent
        // libère le verrou d'un cycle suivant après péremption).
        await db`
          UPDATE bot_config SET value = '', updated_at = NOW()
          WHERE key = ${key} AND split_part(value, '|', 2) = ${cycleId}
        `;
      } else {
        await db`UPDATE bot_config SET value = '', updated_at = NOW() WHERE key = ${key}`;
      }
    } catch { /* silent */ }
  }

  return { key, ttlMs, acquire, release };
}

const defaultLock = createCycleLock();

export const acquireCycleLock = defaultLock.acquire;
export const releaseCycleLock = defaultLock.release;

// Cycle actuellement détenteur du verrou (identifiant renseigné à l'acquisition).
// Permet de tracer les ordres d'un cycle sans changer les signatures des routes.
export async function getCycleLockOwner(db: Db, key: string = CYCLE_LOCK_KEY): Promise<string | null> {
  try {
    const rows = (await db`SELECT value FROM bot_config WHERE key = ${key}`) as Row[];
    return parseLockValue(rows[0]?.value).owner;
  } catch {
    return null;
  }
}
