import OpenAI from 'openai';
import {
  MarketData,
  TechnicalIndicators,
  NewsItem,
  BotDecision,
  RiskLevel,
  RISK_CONFIGS,
  dynamicStopPct,
  MAJOR_SYMBOLS,
  MAJORS_RSI_MAX,
  DIP_MAX_POSITION_PCT,
  MIN_CASH_RESERVE_PCT,
} from './types';
import { logAICost } from './ai-costs';
import { getDefiTVL } from './market-data';
import { getBotMemory, formatMemoryForPrompt } from './memory';
import { DbContext } from './db';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface AnalysisContext {
  marketData: MarketData[];
  technicalIndicators: TechnicalIndicators[];
  news: NewsItem[];
  fearGreedIndex: { value: number; label: string };
  defiTVL?: { total_tvl_usd: number; change_1d: number; top_protocols: Array<{ name: string; tvl: number; change_1d: number }> };
  currentPortfolio: {
    cash_eur: number;
    total_value_eur: number;
    // Cash disponible PAR exchange (mode live multi-exchange).
    // Si absent (paper), cash_eur fait foi.
    cash_kraken_eur?: number;
    cash_coinbase_eur?: number;
    // Symboles impossibles à acheter sur Coinbase (mapping absent ou produit
    // non listé sur le compte/région) : seul le cash Kraken compte pour eux.
    unavailable_on_coinbase?: string[];
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
  // Contexte DB (UAT/PROD) pour la mémoire du bot. Défaut UAT.
  dbContext?: DbContext;
  // Régime de marché (breadth + dominance BTC + mode dip) pour calibrer l'agressivité
  marketRegime?: {
    breadth_pct: number | null;   // % des actifs suivis au-dessus de leur SMA50
    btc_dominance: number | null; // dominance BTC (% market cap)
    dip_mode?: boolean;           // crash objectif : plafond majors relevé
    btc_drawdown_30d?: number | null; // drawdown BTC vs plus haut 30j (%)
  };
}

export async function analyzeMarketWithAI(
  context: AnalysisContext
): Promise<BotDecision[]> {
  const riskConfig = RISK_CONFIGS[context.riskLevel];

  // Load bot memory in parallel with screening — mémoire du CONTEXTE
  // (UAT et PROD apprennent séparément, sans mélange)
  const memory = await getBotMemory(context.dbContext ?? 'uat');
  const memoryText = formatMemoryForPrompt(memory);

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
  const decisionPrompt = buildDecisionPrompt(context, candidates, riskConfig, memoryText);

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
    const totalValue = context.currentPortfolio.total_value_eur;
    const cashAvailable = context.currentPortfolio.cash_eur;
    // En mode live multi-exchange, un ordre est payé par UN SEUL exchange :
    // le cap se fait sur le max des deux soldes, jamais sur le total consolidé.
    const hasSplit = context.currentPortfolio.cash_kraken_eur !== undefined
      || context.currentPortfolio.cash_coinbase_eur !== undefined;
    const maxSingleExchangeCash = hasSplit
      ? Math.max(
          context.currentPortfolio.cash_kraken_eur ?? 0,
          context.currentPortfolio.cash_coinbase_eur ?? 0,
        )
      : cashAvailable;
    const capBase = Math.min(cashAvailable, maxSingleExchangeCash);

    const krakenOnly = new Set(context.currentPortfolio.unavailable_on_coinbase ?? []);
    const krakenCash = context.currentPortfolio.cash_kraken_eur;
    const volBySymbol: Record<string, number> = {};
    for (const t of context.technicalIndicators) {
      if (t.volatility_pct !== null && t.volatility_pct !== undefined && t.volatility_pct > 0) {
        volBySymbol[t.symbol] = t.volatility_pct;
      }
    }
    // Budget risque : un stop-out ne coûte jamais plus de X% du portefeuille
    const riskBudgetEur = totalValue * riskConfig.risk_per_trade_pct / 100;
    const maxPosEur = totalValue * riskConfig.max_position_size_pct / 100;

    const decisions: BotDecision[] = (parsed.decisions ?? [])
      .map((d: BotDecision) => {
        // Hard cap: amount_eur can never exceed the cash of a single exchange.
        // Symboles non-tradables sur Coinbase -> seul le cash Kraken compte.
        const symbolCap = d.action === 'BUY' && krakenOnly.has(d.symbol) && krakenCash !== undefined
          ? krakenCash
          : capBase;
        if (d.action === 'BUY' && d.amount_eur > symbolCap) {
          d.amount_eur = parseFloat((symbolCap * 0.80).toFixed(2));
        }
        // Hard cap risque : taille calibrée sur le stop dynamique (1.5× vol).
        // Ex: budget 15€, stop 6% → 250€ max, même si le cash permet plus.
        // Mode dip : BTC/ETH peuvent monter jusqu'à 50% (acheter la peur).
        if (d.action === 'BUY') {
          const vol = volBySymbol[d.symbol];
          const stopPct = dynamicStopPct(vol ?? null, riskConfig.stop_loss_pct);
          const riskCap = stopPct > 0 ? riskBudgetEur / (stopPct / 100) : symbolCap;
          const posCap = (context.marketRegime?.dip_mode ?? false) && MAJOR_SYMBOLS.includes(d.symbol)
            ? totalValue * DIP_MAX_POSITION_PCT / 100
            : maxPosEur;
          const finalCap = Math.min(symbolCap * 0.80, posCap, riskCap);
          if (d.amount_eur > finalCap) {
            d.amount_eur = parseFloat(Math.max(finalCap, 0).toFixed(2));
          }
          // Cohérence : le stop_loss annoncé suit le stop dynamique
          const marketPrice = context.marketData.find(m => m.symbol === d.symbol)?.price_eur;
          if (marketPrice && marketPrice > 0) {
            d.stop_loss_eur = parseFloat((marketPrice * (1 - stopPct / 100)).toFixed(6));
          }
        }
        // If after capping the amount is below minimum, convert to SKIP
        if (d.action === 'BUY' && d.amount_eur < 5) {
          return { ...d, action: 'SKIP' as const, reasoning: `Cash insuffisant (${cashAvailable.toFixed(2)}€ < 5€ minimum). ${d.reasoning}` };
        }
        return d;
      })
      .filter((d: BotDecision) => {
        if (d.action === 'BUY' || d.action === 'SELL') {
          return d.confidence >= riskConfig.min_confidence;
        }
        return true;
      });

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
- Cash disponible: ${context.currentPortfolio.cash_eur.toFixed(2)}€${context.currentPortfolio.cash_kraken_eur !== undefined ? ` (Kraken: ${context.currentPortfolio.cash_kraken_eur.toFixed(2)}€ / Coinbase: ${(context.currentPortfolio.cash_coinbase_eur ?? 0).toFixed(2)}€ — un achat est payé par UN SEUL exchange)` : ''}
- Valeur totale: ${context.currentPortfolio.total_value_eur.toFixed(2)}€
- Positions: ${context.currentPortfolio.holdings.map(h => `${h.symbol}: ${h.current_value_eur.toFixed(2)}€ (${h.pnl_percent.toFixed(1)}%)`).join(', ') || 'Aucune'}

Retourne un JSON avec les symboles candidats:
{"candidates": ["BTC", "ETH", ...]}
`;
}

function buildDecisionPrompt(
  context: AnalysisContext,
  candidates: string[],
  riskConfig: import('./types').RiskConfig,
  memoryText: string
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
  const breadth = context.marketRegime?.breadth_pct;
  const btcDom = context.marketRegime?.btc_dominance;
  const riskBudgetEur = (context.currentPortfolio.total_value_eur * riskConfig.risk_per_trade_pct / 100);
  const maxPosEur = (context.currentPortfolio.total_value_eur * riskConfig.max_position_size_pct / 100);

  return `
Prends des décisions de trading RÉFLÉCHIES pour le portefeuille suivant.

${memoryText}

=== CONTEXTE MARCHÉ ===
Fear & Greed: ${context.fearGreedIndex.value}/100 (${context.fearGreedIndex.label})
Taux EUR/USD: ${context.eurUsdRate} (FAVORISE les paires EUR quand disponibles)

=== RÉGIME DE MARCHÉ (CALIBRE TON AGRESSIVITÉ) ===
Breadth (% actifs suivis > SMA50): ${breadth !== null && breadth !== undefined ? `${breadth.toFixed(0)}%` : 'N/A'}
Dominance BTC: ${btcDom !== null && btcDom !== undefined ? `${btcDom.toFixed(1)}%` : 'N/A'}
${breadth !== null && breadth !== undefined && breadth < 30 ? `→ Marché FRAGILE : ultra-sélectif (confiance ≥ 75% exigée), montants réduits de moitié, aucun achat de small-cap.` : ''}
${breadth !== null && breadth !== undefined && breadth >= 30 && breadth < 55 ? `→ Marché NEUTRE : tailles normales, setups avec confirmation volume uniquement.` : ''}
${breadth !== null && breadth !== undefined && breadth >= 55 ? `→ Marché PORTEUR : tu peux dimensionner plein budget, les breakouts ont le vent dans le dos.` : ''}

=== RÈGLE MAJORS (BTC/ETH) ===
- Jamais de plafond "trop cher" au feeling : cher + fort = autorisé jusqu'à ${riskConfig.max_position_size_pct}% (plafond normal).
- Exemption RSI : RSI jusqu'à ${MAJORS_RSI_MAX} accepté UNIQUEMENT pour BTC/ETH si tendance bullish + breadth > 55 (les majors trendent plus longtemps ; la règle RSI>75 ne s'applique pas à eux dans ce cas).
- MODE DIP : ${(context.marketRegime?.dip_mode ?? false) ? `ACTIF 🩸 (drawdown BTC 30j : ${context.marketRegime?.btc_drawdown_30d !== null && context.marketRegime?.btc_drawdown_30d !== undefined ? context.marketRegime.btc_drawdown_30d.toFixed(1) + '%' : 'N/A'} | Fear&Greed : ${context.fearGreedIndex.value}) → plafond BTC/ETH relevé à ${DIP_MAX_POSITION_PCT}% pour acheter la peur. Le stop dynamique reste OBLIGATOIRE.` : `inactif (drawdown BTC 30j : ${context.marketRegime?.btc_drawdown_30d !== null && context.marketRegime?.btc_drawdown_30d !== undefined ? context.marketRegime.btc_drawdown_30d.toFixed(1) + '%' : 'N/A'}). Il ne s'active que sur crash objectif (drawdown ≤ -15% ou Fear&Greed ≤ 25).`}
- Cash sanctuarisé : même en dip, toujours ≥ ${MIN_CASH_RESERVE_PCT}% de cash (jamais tapis, garde des munitions pour les alts).

=== DIMENSIONNEMENT AU RISQUE RÉEL (OBLIGATOIRE) ===
Budget risque par trade: ${riskConfig.risk_per_trade_pct}% du total (≈ ${riskBudgetEur.toFixed(2)}€) — un stop-out ne coûte jamais plus.
Stop dynamique par actif: stop% = 1.5 × vol journalière, borné [${(0.5 * riskConfig.stop_loss_pct).toFixed(1)}%, ${(2 * riskConfig.stop_loss_pct).toFixed(1)}%].
- amount max "risque" = budget / stop% (ex: budget ${riskBudgetEur.toFixed(2)}€, stop 6% → ${(riskBudgetEur / 0.06).toFixed(0)}€ max)
- amount final = min(règles cash ci-dessous, max position ${maxPosEur.toFixed(0)}€, montant risque)
- stop_loss_eur = prix × (1 − stop%) — PAS un % fixe au hasard
- Sorties automatiques du bot : 50% au take-profit, solde à 2× l'objectif, stop-loss dynamique
  et TRAILING STOP (−stop% depuis le plus haut, position gagnante) : inutile de tout vendre au TP,
  le suiveur protège le reliquat. Dimensionne pour que le reliquat compte encore.

=== GESTION DU CASH (RÈGLE ABSOLUE) ===
Cash disponible: ${context.currentPortfolio.cash_eur.toFixed(2)}€${context.currentPortfolio.cash_kraken_eur !== undefined ? `
Cash PAR EXCHANGE (un achat est payé par UN SEUL exchange !):
- Kraken: ${context.currentPortfolio.cash_kraken_eur.toFixed(2)}€
- Coinbase: ${(context.currentPortfolio.cash_coinbase_eur ?? 0).toFixed(2)}€
- Cash utilisable pour UN ordre = max des deux = ${Math.max(context.currentPortfolio.cash_kraken_eur, context.currentPortfolio.cash_coinbase_eur ?? 0).toFixed(2)}€ (PAS le total ${context.currentPortfolio.cash_eur.toFixed(2)}€)
- Le routeur paie avec Kraken en priorité (frais faibles), sinon Coinbase si Kraken insuffisant` : ''}
Minimum exchange: 5€ par ordre

⚠️ RÈGLE STRICTE SUR LES MONTANTS:
- amount_eur NE DOIT JAMAIS dépasser ${context.currentPortfolio.cash_kraken_eur !== undefined ? `le cash d'UN SEUL exchange (max ${Math.max(context.currentPortfolio.cash_kraken_eur, context.currentPortfolio.cash_coinbase_eur ?? 0).toFixed(2)}€, PAS le total ${context.currentPortfolio.cash_eur.toFixed(2)}€)` : `le cash disponible (${context.currentPortfolio.cash_eur.toFixed(2)}€)`}
- amount_eur minimum pour un BUY: 5€ (en dessous = SKIP)
- Si cash < 5€ → tu PEUX proposer de VENDRE d'abord une position existante pour libérer du cash, PUIS acheter
- Si cash entre 5€ et 50€ → utilise 80% du cash max (soit max ${(Math.min(context.currentPortfolio.cash_eur, context.currentPortfolio.cash_kraken_eur !== undefined ? Math.max(context.currentPortfolio.cash_kraken_eur, context.currentPortfolio.cash_coinbase_eur ?? 0) : context.currentPortfolio.cash_eur) * 0.80).toFixed(2)}€)
- Si cash entre 50€ et 300€ → utilise max 85% du cash (soit max ${(Math.min(context.currentPortfolio.cash_eur, context.currentPortfolio.cash_kraken_eur !== undefined ? Math.max(context.currentPortfolio.cash_kraken_eur, context.currentPortfolio.cash_coinbase_eur ?? 0) : context.currentPortfolio.cash_eur) * 0.85).toFixed(2)}€)
- Si cash > 300€ → montant selon la règle de max position (${(context.currentPortfolio.total_value_eur * riskConfig.max_position_size_pct / 100).toFixed(0)}€ max)
- EXEMPLE: si cash = 8€ → amount_eur doit être entre 5€ et 6.4€, PAS 500€ ni 1000€${context.currentPortfolio.cash_kraken_eur !== undefined ? `
- EXEMPLE MULTI-EXCHANGE: Kraken 100€ + Coinbase 500€ → amount_eur max = 400€ (80% de 500€), JAMAIS 480€ (80% du total 600€)` : ''}${(context.currentPortfolio.unavailable_on_coinbase ?? []).length > 0 ? `
⚠️ SYMBOLES NON TRADABLES SUR COINBASE (compte/région) : ${context.currentPortfolio.unavailable_on_coinbase!.join(', ')}
→ Un achat de ces symboles ne peut être payé QUE par Kraken (${(context.currentPortfolio.cash_kraken_eur ?? 0).toFixed(2)}€ dispo).
→ Si le montant dépasse 80% du cash Kraken → SKIP (Coinbase rejettera l'ordre avec "Invalid product_id").` : ''}

=== RÉÉQUILIBRAGE DU PORTEFEUILLE ===
Si le portefeuille contient des crypto avec pnl_percent proche de 0 ou négatif et que tu veux acheter autre chose:
- Tu PEUX décider de vendre une position existante (SELL) pour libérer du cash
- Dans ce cas, mets la SELL en premier dans le tableau decisions[], puis le BUY ensuite
- La SELL libère du cash qui sera disponible pour le BUY suivant
- Pour les SELL: amount_eur = valeur actuelle de la position à vendre (current_value_eur)
${context.defiTVL && context.defiTVL.total_tvl_usd > 0 ? `
=== DONNÉES DEFI (DeFi Llama) ===
TVL DeFi Total: $${(context.defiTVL.total_tvl_usd / 1e9).toFixed(1)}B
Top protocoles: ${context.defiTVL.top_protocols.slice(0, 3).map(p => `${p.name}: $${(p.tvl / 1e9).toFixed(1)}B`).join(', ')}
→ Un TVL élevé et stable = confiance dans l'écosystème DeFi → favorable aux tokens DeFi (AAVE, UNI, CRV, MKR)
→ Un TVL en baisse = signal de méfiance sur les protocoles DeFi` : ''}

=== FRAIS DE PLATEFORME (CRITIQUE) ===
Frais par transaction: 0.26% (Kraken taker)
Coût aller-retour complet (achat + vente future): ~0.52%
→ Un trade de 750€ coûte ~3.90€ en frais aller-retour
→ NE JAMAIS prendre un trade si le potentiel de gain est < 1.5% (en dessous du seuil de rentabilité avec frais)
→ Objectif minimum de gain NET après frais: au moins 2% pour que le trade ait du sens

=== CANDIDATS ANALYSÉS (SIGNAUX PRÉ-BOOM) ===
Lecture : VolZ = z-score du volume vs 30j (> 2 = afflux inhabituel = smart money possible).
Squeeze BB = volatilité comprimée au plus bas (l'énergie avant l'expansion).
ROC30 = momentum 30j. Pente MACD > 0 = momentum qui accélère.
${candidateData.map(m => {
  const tech = technicals.find(t => t.symbol === m.symbol);
  const stopPct = dynamicStopPct(tech?.volatility_pct ?? null, riskConfig.stop_loss_pct);
  return `
${m.symbol} (${m.name}):
  Prix: ${m.price_eur.toFixed(6)}€ / ${m.price_usd.toFixed(6)}$
  Variation 24h: ${m.change_24h.toFixed(2)}%
  Variation 7j: ${m.change_7d.toFixed(2)}%
  Volume 24h: ${(m.volume_24h_usd / 1000000).toFixed(1)}M$
  Market Cap Rank: #${m.market_cap_rank}
  Distance ATH: ${m.ath_change_percentage.toFixed(1)}%
  ${tech ? `RSI(14): ${tech.rsi_14?.toFixed(1) ?? 'N/A'}
  MACD: ${tech.macd?.toFixed(6) ?? 'N/A'} | Signal: ${tech.macd_signal?.toFixed(6) ?? 'N/A'} | Pente histo: ${tech.macd_hist_slope !== null && tech.macd_hist_slope !== undefined ? (tech.macd_hist_slope >= 0 ? '+' : '') + tech.macd_hist_slope.toFixed(6) : 'N/A'}
  Tendance: ${tech.trend}
  SMA20: ${tech.sma_20?.toFixed(6) ?? 'N/A'} | SMA50: ${tech.sma_50?.toFixed(6) ?? 'N/A'}
  Volatilité j: ${tech.volatility_pct !== null && tech.volatility_pct !== undefined ? tech.volatility_pct.toFixed(2) + '%' : 'N/A'} → stop dynamique suggéré: ${stopPct.toFixed(1)}%
  Volume z-score: ${tech.volume_zscore !== null && tech.volume_zscore !== undefined ? tech.volume_zscore.toFixed(2) + (tech.volume_zscore >= 2 ? ' 🔥 BREAKOUT' : '') : 'N/A'}
  Squeeze Bollinger: ${tech.bb_squeeze ? 'OUI ⚡ (compression)' : 'non'} (largeur: ${tech.bb_width_pct !== null && tech.bb_width_pct !== undefined ? tech.bb_width_pct.toFixed(2) + '%' : 'N/A'})
  ROC 30j: ${tech.roc_30d !== null && tech.roc_30d !== undefined ? (tech.roc_30d >= 0 ? '+' : '') + tech.roc_30d.toFixed(1) + '%' : 'N/A'}` : ''}
`;
}).join('')}

=== ACTUALITÉS PERTINENTES ===
${relevantNews.slice(0, 8).map(n => `[${n.sentiment.toUpperCase()}] ${n.title} (${n.source})`).join('\n')}

=== PORTEFEUILLE ACTUEL ===
${portfolioDetail}

=== PARAMÈTRES DE RISQUE (${context.riskLevel.toUpperCase()}) ===
- Max position: ${riskConfig.max_position_size_pct}% du portefeuille total
- Stop-loss: ${riskConfig.stop_loss_pct}%
- Take-profit: ${riskConfig.take_profit_pct}%
- Trades restants aujourd'hui: ${riskConfig.max_trades_per_day - context.tradesExecutedToday}
- Max crypto en portefeuille: ${riskConfig.max_portfolio_crypto_pct}% de la valeur totale

=== RÈGLES IMPORTANTES ===
1. Ne jamais investir plus de ${riskConfig.max_position_size_pct}% du portefeuille total sur une seule position
2. Garder toujours au minimum 20% en cash (EUR)
3. Si RSI > 75: signal de surachat, prudence sur les BUY (sauf BTC/ETH en tendance bullish : voir RÈGLE MAJORS, RSI jusqu'à 80)
4. Si RSI < 25: signal de survendu, opportunité potentielle
5. Priorise qualité sur quantité (mieux vaut 1 bon trade que 5 moyens)
6. Pour les petites cryptos: réduction de position obligatoire (max 5% par position)
7. Si tu vends, précise pourquoi maintenant et pas plus tôt ou plus tard
8. FRAIS: chaque trade coûte ~0.26% à l'achat ET ~0.26% à la vente = 0.52% aller-retour. Ne recommande un achat que si tu estimes un potentiel de +2% minimum NET (pour couvrir les frais + générer un vrai gain)
9. ÉVITE les trades "timides" à faible conviction — si confiance < 65%, dis SKIP
10. MONTANT OBLIGATOIRE: amount_eur doit toujours être ≤ cash d'UN SEUL exchange (${context.currentPortfolio.cash_kraken_eur !== undefined ? `max ${Math.max(context.currentPortfolio.cash_kraken_eur, context.currentPortfolio.cash_coinbase_eur ?? 0).toFixed(2)}€, pas le total ${context.currentPortfolio.cash_eur.toFixed(2)}€` : `${context.currentPortfolio.cash_eur.toFixed(2)}€`}). Un amount_eur supérieur est INVALIDE.
11. POUSSIÈRES INTERDITES: ne propose JAMAIS un SELL si current_value_eur < 5€ (minimum exchange Kraken/Coinbase). En dessous de 5€ dis SKIP — l'ordre serait rejeté ("volume minimum not met").
12. VENTE INTERDITE SUR ACTIF NON DÉTENU: un SELL n'est valide QUE si le symbole figure dans PORTEFEUILLE ACTUEL avec current_value_eur ≥ 5€. Vendre un actif que tu ne détiens pas est IMPOSSIBLE (l'exchange rejette l'ordre). Si tu n'as pas la position → réponds HOLD ou SKIP, JAMAIS SELL. Pour un SELL: amount_eur = current_value_eur de la position (pas plus).

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
