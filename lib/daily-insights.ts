import { sqlForContext, DbContext } from './db';
import { getFearGreedIndex, getEurUsdRate, WATCHLIST_COINS } from './market-data';
import { resolveMarketState } from './market-service';
import { getPortfolioSummary } from './portfolio';
import { computeFifo } from './fifo';
import { getDrawdownReview } from './memory';
import { logAICost } from './ai-costs';
import OpenAI from 'openai';

type Row = Record<string, unknown>;
const num = (v: unknown): number => parseFloat(String(v ?? 0)) || 0;

export interface DailyInsights {
  // Rétro 24h : ce qui a été fait + ce que l'IA en a compris
  retro: {
    trades: Array<{ symbol: string; action: string; amount_eur: number; price_eur: number; realized_eur: number | null; reasoning: string }>;
    realized_total_eur: number;
    fees_eur: number;
    buys: number;
    sells: number;
    // Leçons de la revue des pertes (si pertes significatives)
    loss_review: { dd_pct: number; dd_eur: number; lessons: string[] } | null;
  };
  // Prévision du jour : ce que le bot VA faire selon l'IA
  plan: {
    stance: 'defensive' | 'selective' | 'opportunistic' | 'aggressive';
    summary: string;
    expected_actions: string[];
    watchlist: string[];
    risks: string[];
  };
  fear_greed: { value: number; label: string };
  eur_usd: number;
  degraded: boolean;
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Analyse du daily report : rétro 24h (trades + erreurs comprises) + prévision
// du jour (ce que le bot VA faire). 1 seul appel IA (gpt-4o-mini, ~0.01€).
export async function buildDailyInsights(
  ctx: DbContext,
  env: 'paper' | 'live',
): Promise<DailyInsights> {
  const db = sqlForContext(ctx);

  // --- Données de base ---
  const [marketState, fearGreedRaw, eurUsd] = await Promise.all([
    resolveMarketState(ctx, WATCHLIST_COINS),
    getFearGreedIndex() as Promise<{ value: number; label: string }>,
    getEurUsdRate(),
  ]);
  const marketData = marketState.data;
  const fearGreed = fearGreedRaw as { value: number; label: string };
  const portfolio = await getPortfolioSummary(marketData, env, ctx);

  // --- Rétro 24h ---
  const trades = (await db`
    SELECT symbol, action, amount, total_eur, price_eur, fee_eur, reasoning, executed_at
    FROM trades
    WHERE env = ${env} AND action IN ('BUY', 'SELL')
    AND executed_at > NOW() - INTERVAL '24 hours'
    ORDER BY executed_at ASC
  `) as Row[];

  const { perTradeRealized } = computeFifo(
    trades.map(t => ({
      symbol: String(t.symbol),
      action: String(t.action),
      amount: num(t.amount),
      total_eur: num(t.total_eur),
      fee_eur: num(t.fee_eur),
    }))
  );

  const retroTrades = trades.map((t, i) => ({
    symbol: String(t.symbol),
    action: String(t.action),
    amount_eur: num(t.total_eur),
    price_eur: num(t.price_eur),
    realized_eur: perTradeRealized[i],
    reasoning: String(t.reasoning ?? ''),
  }));
  const realizedTotal = retroTrades.reduce((s, t) => s + (t.realized_eur ?? 0), 0);
  const feesTotal = trades.reduce((s, t) => s + num(t.fee_eur), 0);
  const buys = trades.filter(t => String(t.action) === 'BUY').length;
  const sells = trades.filter(t => String(t.action) === 'SELL').length;

  // Revue des pertes (si drawdown 3j < -2%)
  const lossReview = await getDrawdownReview(ctx, env);

  // --- Prévision du jour (IA) ---
  const topMovers = [...marketData]
    .sort((a, b) => Math.abs(b.change_24h) - Math.abs(a.change_24h))
    .slice(0, 8)
    .map(m => `${m.symbol}: ${m.change_24h.toFixed(1)}% (7j: ${m.change_7d.toFixed(1)}%)`)
    .join('\n');

  const holdingsBrief = portfolio.holdings
    .filter(h => h.current_value_eur >= 5)
    .map(h => `${h.symbol}: ${h.current_value_eur.toFixed(0)}€ (${h.pnl_percent >= 0 ? '+' : ''}${h.pnl_percent.toFixed(1)}%)`)
    .join(', ') || 'aucune';

  const prompt = `Tu es le trader du bot crypto. Analyse la journée qui vient de se terminer et prédis ce que le bot VA faire aujourd'hui.

=== HIER (24h) ===
Trades: ${trades.length} (${buys} achats / ${sells} ventes)
${retroTrades.map(t => `- ${t.action} ${t.symbol} ${t.amount_eur.toFixed(0)}€ à ${t.price_eur.toFixed(4)}€${t.realized_eur !== null ? ` (réalisé ${t.realized_eur >= 0 ? '+' : ''}${t.realized_eur.toFixed(2)}€)` : ''}`).join('\n') || '- Aucun trade'}
Réalisé net: ${realizedTotal.toFixed(2)}€ | Frais: ${feesTotal.toFixed(2)}€
${lossReview ? `PERTES 3J: ${lossReview.dd_pct.toFixed(2)}% (${lossReview.dd_eur.toFixed(2)}€)\nLeçons: ${lossReview.lessons.join(' | ')}` : 'Pas de pertes significatives sur 3j.'}

=== AUJOURD'HUI ===
Fear & Greed: ${fearGreed.value}/100 (${fearGreed.label})
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

  let plan: DailyInsights['plan'] = {
    stance: 'selective',
    summary: 'Analyse indisponible — comportement par défaut : sélectif.',
    expected_actions: [],
    watchlist: [],
    risks: [],
  };
  let degraded = !marketState.fresh;
  if (degraded) {
    console.warn(
      `[DailyInsights] Données marché périmées (${marketState.ageMinutes ?? '?'} min) — insights sur données anciennes.`
    );
  }

  try {
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
      await logAICost('gpt-4o-mini', response.usage, eurUsd, undefined, 'daily-insights', ctx);
    }
    const parsed = JSON.parse(response.choices[0].message.content ?? '{}');
    plan = {
      stance: parsed.stance ?? 'selective',
      summary: parsed.plan ?? '',
      expected_actions: parsed.expected_actions ?? [],
      watchlist: parsed.watchlist ?? [],
      risks: parsed.risks ?? [],
    };
  } catch (e) {
    degraded = true;
    console.warn('[DailyInsights] IA indisponible, plan par défaut:', e instanceof Error ? e.message : String(e));
  }

  return {
    retro: {
      trades: retroTrades,
      realized_total_eur: Number(realizedTotal.toFixed(2)),
      fees_eur: Number(feesTotal.toFixed(2)),
      buys,
      sells,
      loss_review: lossReview
        ? { dd_pct: lossReview.dd_pct, dd_eur: lossReview.dd_eur, lessons: lossReview.lessons }
        : null,
    },
    plan,
    fear_greed: { value: fearGreed.value, label: fearGreed.label },
    eur_usd: eurUsd,
    degraded,
  };
}
