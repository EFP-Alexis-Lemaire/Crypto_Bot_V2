type Row = Record<string, unknown>;
type Db = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;

const LOCK_KEY = 'cycle_running_since';
// Un cycle qui dure plus longtemps est considéré comme planté (verrou périmé)
const LOCK_TTL_MS = 10 * 60 * 1000;

// Verrou anti-chevauchement des cycles d'analyse (cron auto + bouton Analyser
// manuel + crons qui se chevauchent). Sans ça, deux cycles lisent les mêmes
// soldes, routent vers le même exchange, et le second se prend
// "Insufficient funds" (cas SUI/UNI : même montant, un seul passe).
// Scopé par DB (ctx) : UAT et PROD ne se bloquent pas mutuellement.
// Libération OBLIGATOIRE via releaseCycleLock (finally).
export async function acquireCycleLock(db: Db, cycleId: string): Promise<boolean> {
  try {
    const rows = (await db`SELECT value FROM bot_config WHERE key = ${LOCK_KEY}`) as Row[];
    const since = parseInt(String(rows[0]?.value ?? '0')) || 0;
    if (since > 0 && Date.now() - since < LOCK_TTL_MS) {
      console.log(`[CycleLock] Cycle ${cycleId} ignoré — un cycle tourne déjà depuis ${new Date(since).toISOString()}`);
      return false;
    }
    const now = String(Date.now());
    await db`
      INSERT INTO bot_config (key, value, updated_at)
      VALUES (${LOCK_KEY}, ${now}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = ${now}, updated_at = NOW()
    `;
    return true;
  } catch (e) {
    // DB inaccessible : fail-open (mieux vaut un cycle risqué que pas de cycle)
    console.warn('[CycleLock] acquire impossible, on continue sans verrou:', e instanceof Error ? e.message : String(e));
    return true;
  }
}

export async function releaseCycleLock(db: Db): Promise<void> {
  try {
    await db`UPDATE bot_config SET value = '', updated_at = NOW() WHERE key = ${LOCK_KEY}`;
  } catch { /* silent */ }
}
