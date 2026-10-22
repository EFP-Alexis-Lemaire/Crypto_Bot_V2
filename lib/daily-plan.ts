import { sqlForContext, DbContext } from './db';
import { NextResponse } from 'next/server';
import { getFearGreedIndex, getEurUsdRate, WATCHLIST_COINS, getBtcDominance } from './market-data';
import { resolveMarketState } from './market-service';
import { getPortfolioSummary } from './portfolio';
import { getDrawdownReview } from './memory';
import { logAICost } from './ai-costs';
import OpenAI from 'openai';

type Db = ReturnType<typeof sqlForContext>;

export type Stance = 'defensive' | 'selective' | 'opportunistic' | 'aggressive';

export interface DailyPlan {
  stance: Stance;
  summary: string;
  expected_actions: string[];
  watchlist: string[];
  risks: string[];
  retro: string;
  generated_at: string;
}

// Écrit le plan du jour en bot_config (debounce : 1 écriture / jour).
// Le plan devient CONTRAIGNANT : chaque cycle le lit et l'applique.
export async function writeDailyPlan(db: Db, plan: DailyPlan): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const payload = JSON.stringify(plan);
  await db`
    INSERT INTO bot_config (key, value, updated_at)
    VALUES ('daily_plan', ${payload}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = ${payload}, updated_at = NOW()
  `;
  await db`
    INSERT INTO bot_config (key, value, updated_at)
    VALUES ('daily_plan_date', ${today}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = ${today}, updated_at = NOW()
  `;
}

// Lit le plan du jour (null si pas généré aujourd'hui)
export async function readDailyPlan(db: Db): Promise<DailyPlan | null> {
  try {
    const rows = (await db`SELECT key, value FROM bot_config WHERE key IN ('daily_plan', 'daily_plan_date')`) as Array<{ key: string; value: string }>;
    const map: Record<string, string> = {};
    rows.forEach(r => { map[r.key] = r.value; });
    const today = new Date().toISOString().slice(0, 10);
    if (map.daily_plan_date !== today || !map.daily_plan) return null;
    return JSON.parse(map.daily_plan) as DailyPlan;
  } catch {
    return null;
  }
}

// Posture adaptative : si le marché s'effondre en cours de journée,
// on force la stance defensive immédiatement (le plan du matin est dépassé).
export function adaptiveStance(current: Stance, drawdown24hPct: number | null): Stance {
  if (drawdown24hPct === null) return current;
  if (drawdown24hPct <= -10) return 'defensive';
  if (drawdown24hPct <= -5 && current === 'aggressive') return 'selective';
  return current;
}

// Garde-fous dérivés de la stance (appliqués dans le post-traitement IA)
export const STANCE_RULES: Record<Stance, {
  minConfidence: number;
  sizeMultiplier: number;
  allowSmallCaps: boolean;
  label: string;
}> = {
  defensive: { minConfidence: 80, sizeMultiplier: 0.5, allowSmallCaps: false, label: 'DÉFENSIF' },
  selective: { minConfidence: 70, sizeMultiplier: 0.75, allowSmallCaps: false, label: 'SÉLECTIF' },
  opportunistic: { minConfidence: 65, sizeMultiplier: 1, allowSmallCaps: true, label: 'OPPORTUNISTE' },
  aggressive: { minConfidence: 55, sizeMultiplier: 1.25, allowSmallCaps: true, label: 'AGRESSIF' },
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Génère le plan du jour (rétro 24h + prévision) et l'écrit en DB.
// Appelé par le cron 7h (et le bouton "Plan du jour" du dashboard).
// 1 appel gpt-4o-mini (~0,01€). Jamais bloquant : en cas d'échec, pas de plan
// (les cycles repassent en stance par défaut "selective").
export async function generateDailyPlan(
  ctx: DbContext,
  env: 'paper' | 'live',
): Promise<{ ok: boolean; plan?: DailyPlan; error?: string }> {
  const db = sqlForContext(ctx);
  try {
    const [marketState, fearGreedRaw, eurUsd, btcDominance] = await Promise.all([
      resolveMarketState(ctx, WATCHLIST_COINS),
      getFearGreedIndex() as Promise<{ value: number; label: string }>,
      getEurUsdRate(),
      getBtcDominance(),
    ]);
    const marketData = marketState.data;
    const fearGreed = fearGreedRaw as { value: number; label: string };
    const portfolio = await getPortfolioSummary(marketData, env, ctx);

    // Rétro 24h
    const trades = (await db`
      SELECT symbol, action, total_eur, price_eur, reasoning FROM trades
      WHERE env = ${env} AND action IN ('BUY', 'SELL')
      AND executed_at > NOW() - INTERVAL '24 hours'
      ORDER BY executed_at ASC
    `) as Array<Record<string, unknown>>;
    const lossReview = await getDrawdownReview(ctx, env);

    const topMovers = [...marketData]
      .sort((a, b) => Math.abs(b.change_24h) - Math.abs(a.change_24h))
      .slice(0, 8)
      .map(m => `${m.symbol}: ${m.change_24h.toFixed(1)}% (7j: ${m.change_7d.toFixed(1)}%)`)
      .join('\n');

    const holdingsBrief = portfolio.holdings
      .filter(h => h.current_value_eur >= 5)
      .map(h => `${h.symbol}: ${h.current_value_eur.toFixed(0)}€ (${h.pnl_percent >= 0 ? '+' : ''}${h.pnl_percent.toFixed(1)}%)`)
      .join(', ') || 'aucune';

    const prompt = `Tu es le trader du bot crypto. Génère le plan de trading pour AUJOURD'HUI.

=== HIER (24h) ===
Trades: ${trades.length}
${trades.map(t => `- ${String(t.action)} ${String(t.symbol)} ${parseFloat(String(t.total_eur)).toFixed(0)}€`).join('\n') || '- Aucun trade'}
${lossReview ? `PERTES 3J: ${lossReview.dd_pct.toFixed(2)}% (${lossReview.dd_eur.toFixed(2)}€)\nLeçons: ${lossReview.lessons.join(' | ')}` : 'Pas de pertes significatives sur 3j.'}

=== AUJOURD'HUI ===
Fear & Greed: ${fearGreed.value}/100 (${fearGreed.label})
Dominance BTC: ${btcDominance !== null ? btcDominance.toFixed(1) + '%' : 'N/A'}
Données marché: ${marketState.fresh ? 'fraîches (temps réel)' : `PÉRIMÉES (dernière mise à jour il y a ${marketState.ageMinutes ?? '?'} min)`}
Portefeuille: ${portfolio.total_value_eur.toFixed(2)}€ (cash ${portfolio.cash_eur.toFixed(2)}€)
Positions: ${holdingsBrief}
Top mouvements 24h:
${topMovers}

=== TA MISSION ===
1. RÉTRO : en 2-3 phrases, explique ce que le bot a fait hier et CE QU'IL A COMPRIS de ses erreurs (ex: "acheté ETH en plein crash, stop loss déclenché le lendemain — leçon: pas d'achat en tendance baissière sans confirmation volume"). Sois concret et honnête.
2. PLAN : en 2-3 phrases, dis ce que le bot VA faire aujourd'hui (ex: "gros crash hier → je n'acheterai pas grand chose, je garde le cash" ou "marché porteur → quelques opportunités sur les breakouts"). Sois direct et actionnable.
3. ACTIONS ATTENDUES : 3-5 points concrets (ex: "ACHAT possible sur BTC si VolZ ≥ 2", "VENTE si stop touché sur X", "SKIP sur les small-caps").
4. SURVEILLANCE : 2-3 cryptos à surveiller aujourd'hui avec raison brève.
5. RISQUES : 1-2 risques du jour.

Réponds UNIQUEMENT en JSON valide:
{
  "retro": "<rétro 2-3 phrases>",
  "plan": "<plan 2-3 phrases>",
  "expected_actions": ["<action 1>", "<action 2>", "<action 3>"],
  "watchlist": ["<crypto: raison>", "<crypto: raison>"],
  "risks": ["<risque 1>", "<risque 2>"],
  "stance": "defensive" | "selective" | "opportunistic" | "aggressive"
}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Tu es un trader crypto senior. Réponds UNIQUEMENT en JSON valide, en français.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 700,
      response_format: { type: 'json_object' },
    });
    if (response.usage) {
      await logAICost('gpt-4o-mini', response.usage, eurUsd, undefined, 'daily-plan', ctx);
    }
    const parsed = JSON.parse(response.choices[0].message.content ?? '{}');
    const plan: DailyPlan = {
      stance: parsed.stance ?? 'selective',
      summary: parsed.plan ?? '',
      expected_actions: parsed.expected_actions ?? [],
      watchlist: parsed.watchlist ?? [],
      risks: parsed.risks ?? [],
      retro: parsed.retro ?? '',
      generated_at: new Date().toISOString(),
    };
    await writeDailyPlan(db, plan);
    return { ok: true, plan };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
