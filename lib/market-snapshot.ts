import { sqlForContext, DbContext } from './db';
import { MarketData } from './types';

// Dernier état marché réussi, persisté en DB (par contexte UAT/PROD).
// But : quand CoinGecko tombe (quota épuisé, API down, rate-limit), le
// dashboard et les cycles peuvent afficher/expliquer au lieu d'un tableau
// vide, et on sait exactement depuis quand les données datent.
const SNAPSHOT_KEY = 'market_snapshot';

export interface MarketSnapshot {
  data: MarketData[];
  at: string; // ISO
}

export async function saveMarketSnapshot(ctx: DbContext, data: MarketData[]): Promise<void> {
  if (!data || data.length === 0) return;
  try {
    const db = sqlForContext(ctx);
    const payload = JSON.stringify({ data, at: new Date().toISOString() } satisfies MarketSnapshot);
    await db`
      INSERT INTO bot_config (key, value, updated_at)
      VALUES (${SNAPSHOT_KEY}, ${payload}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = ${payload}, updated_at = NOW()
    `;
  } catch {
    // Non bloquant : un snapshot en échec ne doit pas casser le cycle.
  }
}

export async function readMarketSnapshot(ctx: DbContext): Promise<MarketSnapshot | null> {
  try {
    const db = sqlForContext(ctx);
    const rows = (await db`SELECT value FROM bot_config WHERE key = ${SNAPSHOT_KEY}`) as Array<{ value: string }>;
    const raw = rows[0]?.value;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MarketSnapshot;
    if (!parsed?.data?.length || !parsed.at) return null;
    return parsed;
  } catch {
    return null;
  }
}
