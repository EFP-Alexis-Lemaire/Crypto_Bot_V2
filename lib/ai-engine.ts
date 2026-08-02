import OpenAI from 'openai';
import {
  MarketData,
  TechnicalIndicators,
  NewsItem,
  BotDecision,
  RiskLevel,
  RISK_CONFIGS,
} from './types';
import { logAICost } from './ai-costs';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface AnalysisContext {
  marketData: MarketData[];
  technicalIndicators: TechnicalIndicators[];
  news: NewsItem[];
  fearGreedIndex: { value: number; label: string };
  currentPortfolio: {
    cash_eur: number;
    total_value_eur: number;
    holdings: Array<{
      symbol: string;
      amount: number;
      current_value_eur: number;
      pnl_percent: number;
    }>;
  };
  riskLevel: RiskLevel;
  tradesExecutedToday: number;
  eurUsdRate: number;
}

export async function analyzeMarketWithAI(
  context: AnalysisContext
): Promise<BotDecision[]> {
  const riskConfig = RISK_CONFIGS[context.riskLevel];

  // Step 1: Fast pre-screening with GPT-4o-mini
  const screeningPrompt = buildScreeningPrompt(context);
  
  let candidatesJson: string;
  try {
    const screeningResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Tu es un analyste crypto expert. Tu identifies les opportunités de trading les plus prometteuses en analysant données techniques et fondamentales. Réponds UNIQUEMENT en JSON valide.`,
        },
        { role: 'user', content: screeningPrompt },
      ],
      temperature: 0.3,
      max_tokens: 1000,
      response_format: { type: 'json_object' },
    });
    candidatesJson = screeningResponse.choices[0].message.content ?? '{"candidates":[]}';

    // Log AI cost
    if (screeningResponse.usage) {
      await logAICost('gpt-4o-mini', screeningResponse.usage, context.eurUsdRate, undefined, 'screening');
    }
  } catch (error) {
    console.error('Screening error:', error);
    return [];
  }

  let candidates: string[] = [];
  try {
    const parsed = JSON.parse(candidatesJson);
    candidates = parsed.candidates ?? [];
  } catch {
    return [];
  }

  if (candidates.length === 0) return [];

  // Step 2: Deep analysis with GPT-4o on top candidates only
  const decisionPrompt = buildDecisionPrompt(context, candidates, riskConfig);

  let decisionJson: string;
  try {
    const decisionResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `Tu es un gestionnaire de portefeuille crypto expert avec 15 ans d'expérience. 
          Tu prends des décisions réfléchies et conservatrices pour protéger le capital.
          Priorité : préserver le capital, gains constants > gains rapides.
          Tu favorises les cryptos tradées en EUR quand possible.
          Tu analyses TOUJOURS le contexte macro, technique et fondamental.
          Réponds UNIQUEMENT en JSON valide avec la structure demandée.`,
        },
        { role: 'user', content: decisionPrompt },
      ],
      temperature: 0.2,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    });
    decisionJson = decisionResponse.choices[0].message.content ?? '{"decisions":[]}';

    // Log AI cost
    if (decisionResponse.usage) {
      await logAICost('gpt-4o', decisionResponse.usage, context.eurUsdRate, undefined, 'decision');
    }
  } catch (error) {
    console.error('Decision error:', error);
    return [];
  }

  try {
    const parsed = JSON.parse(decisionJson);
    const decisions: BotDecision[] = (parsed.decisions ?? []).filter(
      (d: BotDecision) => {
        // Filter by minimum confidence based on risk level
        if (d.action === 'BUY' || d.action === 'SELL') {
          return d.confidence >= riskConfig.min_confidence;
        }
        return true;
      }
    );

    // Enforce max trades limit
    const remainingTrades = riskConfig.max_trades_per_day - context.tradesExecutedToday;
    const actionDecisions = decisions.filter(d => d.action !== 'HOLD' && d.action !== 'SKIP');
    return actionDecisions.slice(0, remainingTrades);
  } catch {
    return [];
  }
}

function buildScreeningPrompt(context: AnalysisContext): string {
  const marketSummary = context.marketData
    .slice(0, 20)
    .map(
      m =>
        `${m.symbol}: ${m.price_eur.toFixed(4)}€ (24h: ${m.change_24h.toFixed(1)}%, 7d: ${m.change_7d.toFixed(1)}%)`
    )
    .join('\n');

  const newsSummary = context.news
    .slice(0, 10)
    .map(n => `[${n.sentiment.toUpperCase()}] ${n.title}`)
    .join('\n');

  return `
Analyse rapide du marché crypto pour identifier les 3-5 meilleures opportunités de trading.

FEAR & GREED INDEX: ${context.fearGreedIndex.value}/100 (${context.fearGreedIndex.label})
TAUX EUR/USD: ${context.eurUsdRate}

DONNÉES MARCHÉ:
${marketSummary}

ACTUALITÉS RÉCENTES:
${newsSummary}

PORTEFEUILLE ACTUEL:
- Cash disponible: ${context.currentPortfolio.cash_eur.toFixed(2)}€
- Valeur totale: ${context.currentPortfolio.total_value_eur.toFixed(2)}€
- Positions: ${context.currentPortfolio.holdings.map(h => `${h.symbol}: ${h.current_value_eur.toFixed(2)}€ (${h.pnl_percent.toFixed(1)}%)`).join(', ') || 'Aucune'}

Retourne un JSON avec les symboles candidats:
{"candidates": ["BTC", "ETH", ...]}
`;
}

function buildDecisionPrompt(
  context: AnalysisContext,
  candidates: string[],
  riskConfig: ReturnType<typeof Object.values>[0]
): string {
  const candidateData = context.marketData.filter(m =>
    candidates.includes(m.symbol)
  );

  const technicals = context.technicalIndicators.filter(t =>
    candidates.includes(t.symbol)
  );

  const relevantNews = context.news.filter(n =>
    !n.currencies ||
    n.currencies.some(c => candidates.includes(c))
  );

  const portfolioDetail = JSON.stringify(context.currentPortfolio, null, 2);

  return `
Prends des décisions de trading RÉFLÉCHIES pour le portefeuille suivant.

=== CONTEXTE MARCHÉ ===
Fear & Greed: ${context.fearGreedIndex.value}/100 (${context.fearGreedIndex.label})
Taux EUR/USD: ${context.eurUsdRate} (FAVORISE les paires EUR quand disponibles)

=== FRAIS DE PLATEFORME (CRITIQUE) ===
Frais par transaction: 0.26% (Kraken taker)
Coût aller-retour complet (achat + vente future): ~0.52%
→ Un trade de 750€ coûte ~3.90€ en frais aller-retour
→ NE JAMAIS prendre un trade si le potentiel de gain est < 1.5% (en dessous du seuil de rentabilité avec frais)
→ Objectif minimum de gain NET après frais: au moins 2% pour que le trade ait du sens

=== CANDIDATS ANALYSÉS ===
${candidateData.map(m => {
  const tech = technicals.find(t => t.symbol === m.symbol);
  return `
${m.symbol} (${m.name}):
  Prix: ${m.price_eur.toFixed(6)}€ / ${m.price_usd.toFixed(6)}$
  Variation 24h: ${m.change_24h.toFixed(2)}%
  Variation 7j: ${m.change_7d.toFixed(2)}%
  Volume 24h: ${(m.volume_24h_usd / 1000000).toFixed(1)}M$
  Market Cap Rank: #${m.market_cap_rank}
  Distance ATH: ${m.ath_change_percentage.toFixed(1)}%
  ${tech ? `RSI(14): ${tech.rsi_14?.toFixed(1) ?? 'N/A'}
  MACD: ${tech.macd?.toFixed(6) ?? 'N/A'} | Signal: ${tech.macd_signal?.toFixed(6) ?? 'N/A'}
  Tendance: ${tech.trend}
  SMA20: ${tech.sma_20?.toFixed(6) ?? 'N/A'} | SMA50: ${tech.sma_50?.toFixed(6) ?? 'N/A'}` : ''}
`;
}).join('')}

=== ACTUALITÉS PERTINENTES ===
${relevantNews.slice(0, 8).map(n => `[${n.sentiment.toUpperCase()}] ${n.title} (${n.source})`).join('\n')}

=== PORTEFEUILLE ACTUEL ===
${portfolioDetail}

=== PARAMÈTRES DE RISQUE (${context.riskLevel.toUpperCase()}) ===
- Max position: ${(riskConfig as { max_position_size_pct: number }).max_position_size_pct}% du portefeuille total
- Stop-loss: ${(riskConfig as { stop_loss_pct: number }).stop_loss_pct}%
- Take-profit: ${(riskConfig as { take_profit_pct: number }).take_profit_pct}%
- Trades restants aujourd'hui: ${(riskConfig as { max_trades_per_day: number }).max_trades_per_day - context.tradesExecutedToday}
- Max crypto en portefeuille: ${(riskConfig as { max_portfolio_crypto_pct: number }).max_portfolio_crypto_pct}% de la valeur totale

=== RÈGLES IMPORTANTES ===
1. Ne jamais investir plus de ${(riskConfig as { max_position_size_pct: number }).max_position_size_pct}% du portefeuille total sur une seule position
2. Garder toujours au minimum 20% en cash (EUR)
3. Si RSI > 75: signal de survente, prudence sur les BUY
4. Si RSI < 25: signal de survendu, opportunité potentielle
5. Priorise qualité sur quantité (mieux vaut 1 bon trade que 5 moyens)
6. Pour les petites cryptos: réduction de position obligatoire (max 5% par position)
7. Si tu vends, précise pourquoi maintenant et pas plus tôt ou plus tard
8. FRAIS: chaque trade coûte ~0.26% à l'achat ET ~0.26% à la vente = 0.52% aller-retour. Ne recommande un achat que si tu estimes un potentiel de +3% minimum NET (pour couvrir les frais + générer un vrai gain)
9. ÉVITE les trades "timides" à faible conviction — si confiance < 65%, dis SKIP plutôt que d'entrer avec un petit montant

Retourne un JSON avec tes décisions:
{
  "decisions": [
    {
      "symbol": "BTC",
      "action": "BUY", // BUY | SELL | HOLD | SKIP
      "amount_eur": 500, // montant en EUR
      "reasoning": "Explication détaillée et argumentée de la décision...",
      "confidence": 72, // 0-100
      "risk_score": 35, // 0-100 (100 = très risqué)
      "target_price_eur": 52000,
      "stop_loss_eur": 44000,
      "take_profit_eur": 58000,
      "timeframe": "1-2 semaines"
    }
  ],
  "market_sentiment_analysis": "Analyse globale du marché en 2-3 phrases",
  "portfolio_recommendation": "Recommandation globale sur le portefeuille"
}
`;
}
