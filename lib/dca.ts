import { sqlForContext, DbContext } from './db';
import { BotDecision, MarketData } from './types';
import { executePaperTrade } from './portfolio';
import { executeLiveTrade } from './exchanges/live-trader';
import { sendTradeAlert } from './telegram';

type Row = Record<string, unknown>;
type Db = ReturnType<typeof sqlForContext>;

export interface DcaExecution {
  decision: BotDecision;
  marketCoin: MarketData;
  result: { success: boolean; message: string; exchange?: 'kraken' | 'coinbase'; chargedEur?: number };
}

// Achats programmés hebdomadaires (DCA) : enveloppe répartie à parts égales
// sur les symboles configurés, le jour configuré (UTC).
// - Ne consomme PAS le budget max_trades de l'IA (enveloppe séparée, planifiée).
// - Garde anti-doublon : 1 exécution max par période de 6 jours (et par env).
// - Tourne même si le coupe-circuit est actif (acheter le creux, c'est le principe du DCA).
// - Échecs (cash insuffisant, produit indisponible...) = SKIP loggé, jamais bloquant.
export async function runScheduledDca(opts: {
  db: Db;
  ctx: DbContext;
  env: 'paper' | 'live';
  isLive: boolean;
  marketData: MarketData[];
  eurUsdRate: number;
  cycleId: string;
}): Promise<DcaExecution[]> {
  const { db, ctx, env, isLive, marketData, eurUsdRate, cycleId } = opts;
  const out: DcaExecution[] = [];

  const cfgRows = (await db`SELECT key, value FROM bot_config`) as Row[];
  const cfg: Record<string, string> = {};
  cfgRows.forEach(c => { cfg[String(c.key)] = String(c.value); });

  if (cfg.dca_enabled !== 'true') return out;
  const total = parseFloat(cfg.dca_amount_eur ?? '0');
  if (!(total > 0)) return out;
  const weekday = parseInt(cfg.dca_weekday ?? '1');
  if (new Date().getUTCDay() !== weekday) return out;
  const symbols = (cfg.dca_symbols ?? 'BTC')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
  if (symbols.length === 0) return out;

  // Déjà exécuté cette semaine ?
  const ran = (await db`
    SELECT COUNT(*) AS n FROM trades
    WHERE env = ${env} AND reasoning LIKE '[DCA]%' AND executed_at > NOW() - INTERVAL '6 days'
  `) as Row[];
  if (parseInt(String(ran[0]?.n ?? '0')) > 0) return out;

  const perSymbol = total / symbols.length;

  for (const symbol of symbols) {
    const marketCoin = marketData.find(m => m.symbol === symbol);
    if (!marketCoin) {
      await db`INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, env)
        VALUES (${cycleId}, ${symbol}, 'SKIP', ${`[DCA] ${symbol} introuvable dans les données marché.`}, 0, 0, 'dca-schedule', ${env})`;
      continue;
    }
    if (perSymbol < 5) {
      await db`INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, env)
        VALUES (${cycleId}, ${symbol}, 'SKIP', ${`[DCA] Part de ${perSymbol.toFixed(2)}€ < 5€ minimum exchange.`}, 0, 0, 'dca-schedule', ${env})`;
      continue;
    }

    const decision: BotDecision = {
      symbol,
      action: 'BUY',
      amount_eur: parseFloat(perSymbol.toFixed(2)),
      reasoning: `[DCA] Achat programmé hebdo (${total.toFixed(0)}€ répartis sur ${symbols.join(', ')}).`,
      confidence: 100,
      risk_score: 10,
      timeframe: 'Long terme',
    };
    const result = isLive
      ? await executeLiveTrade(decision, marketCoin, eurUsdRate)
      : await executePaperTrade(decision, marketCoin, eurUsdRate, env, ctx);
    out.push({ decision, marketCoin, result });

    await db`INSERT INTO bot_decisions (cycle_id, symbol, action, reasoning, confidence, risk_score, model_used, env)
      VALUES (${cycleId}, ${symbol}, 'BUY', ${decision.reasoning}, 100, 10, 'dca-schedule', ${env})`;
    await sendTradeAlert(decision, result.success, marketCoin.price_eur, result.message, isLive, ctx);
  }

  return out;
}
