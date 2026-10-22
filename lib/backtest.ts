// Backtest rapide : "ce setup a-t-il déjà gagné ?"
// Méthode : matching par fenêtre glissante — on retrouve dans l'historique
// récent des configurations proches (RSI, tendance, momentum, volatilité,
// largeur BB, Fear&Greed) et on mesure la performance forward 7 jours.
// Léger : ne retient que les setups >= 3 occurrences, winrate + gain médian.
import { getCoinHistory } from './market-data';

export interface SetupFeatures {
  rsi: number;
  roc30: number;
  vol: number;
  bbWidth: number;
  fearGreed: number;
  trend: 'bullish' | 'bearish' | 'neutral';
}

export interface BacktestResult {
  wins: number;
  losses: number;
  winrate: number;
  medianGain7d: number;
  avgGain7d: number;
  count: number;
  // Score composite : proba de gain × amplitude espérée (0-100, > 50 = favorable)
  score: number;
}

// Bornes du matching : un setup est "proche" si chaque dimension est dans ±tolérance
const TOL = { rsi: 8, roc30: 6, vol: 1.2, bbWidth: 0.5, fg: 12 };

function similar(a: SetupFeatures, b: SetupFeatures): boolean {
  if (a.trend !== b.trend) return false;
  return (
    Math.abs(a.rsi - b.rsi) <= TOL.rsi &&
    Math.abs(a.roc30 - b.roc30) <= TOL.roc30 &&
    Math.abs(a.vol - b.vol) <= TOL.vol &&
    Math.abs(a.bbWidth - b.bbWidth) <= TOL.bbWidth &&
    Math.abs(a.fearGreed - b.fearGreed) <= TOL.fg
  );
}

function roc(prices: number[], days: number): number {
  if (prices.length < days + 1) return 0;
  const ref = prices[prices.length - days - 1];
  return ref > 0 ? ((prices[prices.length - 1] - ref) / ref) * 100 : 0;
}

function bbWidth(prices: number[]): number {
  const w = prices.slice(-20);
  const m = w.reduce((a, b) => a + b, 0) / w.length;
  const v = w.reduce((a, p) => a + Math.pow(p - m, 2), 0) / w.length;
  return m > 0 ? (4 * Math.sqrt(v) / m) * 100 : 0;
}

function rsi14(prices: number[]): number {
  const changes = prices.slice(-15).map((p, i, a) => (i === 0 ? 0 : p - a[i - 1])).slice(1);
  const gains = changes.filter(c => c > 0);
  const losses = changes.filter(c => c < 0).map(c => -c);
  const avgG = gains.length ? gains.reduce((a, b) => a + b, 0) / changes.length : 0;
  const avgL = losses.length ? losses.reduce((a, b) => a + b, 0) / changes.length : 0;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

function volDaily(prices: number[]): number {
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && prices[i] > 0) rets.push(Math.abs(Math.log(prices[i] / prices[i - 1])));
  }
  return rets.length ? (rets.reduce((a, b) => a + b, 0) / rets.length) * 100 : 0;
}

// Backtest : interroge l'historique 60j d'un coin, trouve les setups similaires
// à celui d'aujourd'hui et mesure la perf forward 7j. Appelé par cycle (1 coin).
// `prices` : si fourni (historique déjà chargé par le cycle pour les
// indicateurs), on ne refait PAS d'appel CoinGecko — chaque appel compte
// dans le quota mensuel, on ne gaspille rien.
export async function quickBacktest(
  coinId: string,
  target: SetupFeatures,
  fearGreedValue: number,
  prices?: number[]
): Promise<BacktestResult | null> {
  try {
    let series = prices;
    if (!series || series.length < 40) {
      const history = await getCoinHistory(coinId, 60);
      series = history.map(h => h.price);
    }
    const priceSeries = series;
    if (priceSeries.length < 40) return null;

    // Fenêtres glissantes : chaque point t du passé avec données suffisantes
    const gains: number[] = [];
    const feats: SetupFeatures[] = [];
    for (let t = 30; t < priceSeries.length - 7; t++) {
      const window = priceSeries.slice(0, t + 1);
      const r = rsi14(window);
      if (r === null || !(r > 0)) continue;
      const feat: SetupFeatures = {
        rsi: r,
        roc30: roc(window, 30),
        vol: volDaily(window),
        bbWidth: bbWidth(window),
        fearGreed: fearGreedValue,
        trend: r > 50 ? 'bullish' : r < 50 ? 'bearish' : 'neutral',
      };
      feats.push(feat);
      const ref = window[window.length - 1];
      const future = priceSeries[t + 7] ?? priceSeries[priceSeries.length - 1];
      gains.push(ref > 0 ? ((future - ref) / ref) * 100 : 0);
    }

    // Match + agrégation
    const matched: number[] = [];
    for (let i = 0; i < feats.length; i++) {
      if (similar(feats[i], target)) matched.push(gains[i]);
    }

    if (matched.length < 3) return null; // pas assez de données
    const wins = matched.filter(g => g > 0).length;
    const winrate = (wins / matched.length) * 100;
    const sorted = [...matched].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const avg = matched.reduce((a, b) => a + b, 0) / matched.length;
    // Score : winrate pondérée par le gain médian (borné 0-100)
    const score = Math.max(0, Math.min(100, winrate * 0.7 + 50 + median * 2));

    return {
      wins,
      losses: matched.length - wins,
      winrate: Number(winrate.toFixed(1)),
      medianGain7d: Number(median.toFixed(2)),
      avgGain7d: Number(avg.toFixed(2)),
      count: matched.length,
      score: Number(score.toFixed(1)),
    };
  } catch {
    return null;
  }
}
