import axios from 'axios';
import Parser from 'rss-parser';
import { MarketData, TechnicalIndicators, NewsItem } from './types';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const COINGECKO_PRO_BASE = 'https://pro-api.coingecko.com/api/v3';
const rssParser = new Parser({ timeout: 8000 });

// ---------------------------------------------------------------------------
// Client CoinGecko : détection du type de clé, repli anonyme, cache mémoire
// ---------------------------------------------------------------------------
// Constat (21/10/2026) : la clé démo du projet avait atteint son quota
// mensuel (10 000 appels/mois). TOUTES les requêtes avec la clé répondaient
// 429 / error_code 10006 -> getMarketData() retournait [] SILENCIEUSEMENT ->
// marché vide, aucun indicateur technique, aucun candidat IA, DCA "symbole
// introuvable". D'où les règles ci-dessous :
//  1. type de clé détecté (demo => api.coingecko.com, pro => pro-api) avec
//     bascule automatique si CoinGecko signale la mauvaise racine ;
//  2. quota de clé épuisé (10006) -> repli sur l'API publique anonyme au lieu
//     de tout casser (et on n'insiste plus sur la clé pendant le process) ;
//  3. cache mémoire : les quotas se brûlent vite, chaque appel est compté.

type CgPlan = 'demo' | 'pro';

const cgState = {
  plan: (process.env.COINGECKO_PLAN === 'pro' ? 'pro' : 'demo') as CgPlan,
  keyExhausted: false,
  lastError: null as string | null,
  lastErrorAt: 0 as number,
};

export interface CoinGeckoStatus {
  plan: CgPlan;
  keyConfigured: boolean;
  keyExhausted: boolean;
  anonymous: boolean;
  lastError: string | null;
  lastErrorAt: number | null;
}

export function getCoinGeckoStatus(): CoinGeckoStatus {
  return {
    plan: cgState.plan,
    keyConfigured: Boolean(process.env.COINGECKO_API_KEY),
    keyExhausted: cgState.keyExhausted,
    anonymous: cgState.keyExhausted || !process.env.COINGECKO_API_KEY,
    lastError: cgState.lastError,
    lastErrorAt: cgState.lastErrorAt || null,
  };
}

function cgBase(): string {
  return cgState.plan === 'pro' ? COINGECKO_PRO_BASE : COINGECKO_BASE;
}

function cgKeyParam(): string {
  return cgState.plan === 'pro' ? 'x_cg_pro_api_key' : 'x_cg_demo_api_key';
}

// Quota mensuel de la clé épuisé (erreur CoinGecko 10006)
function isQuotaError(e: unknown): boolean {
  if (!axios.isAxiosError(e)) return false;
  const code = (e.response?.data as { status?: { error_code?: number } } | undefined)?.status?.error_code;
  return e.response?.status === 429 && code === 10006;
}

// Clé du mauvais type pour la racine utilisée (message "root URL")
function isRootUrlError(e: unknown): boolean {
  if (!axios.isAxiosError(e)) return false;
  const msg = (e.response?.data as { status?: { error_message?: string } } | undefined)?.status?.error_message ?? '';
  return e.response?.status === 400 && /root URL/i.test(msg);
}

function cgErrorMessage(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const body = e.response?.data as { status?: { error_code?: number; error_message?: string } } | undefined;
    const code = body?.status?.error_code;
    const msg = body?.status?.error_message;
    return `${e.response?.status ?? 'ERR'}${code ? `/${code}` : ''} ${msg ?? e.message}`.slice(0, 200);
  }
  return e instanceof Error ? e.message : String(e);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- Throttle : le quota CoinGecko se compte en appels/minute -----------------
// Clé démo : 30 appels/min. API publique anonyme : ~5-15 appels/min (429 vite
// atteint si on balance 15 appels d'historique en parallèle). On espace donc
// les appels au lieu de subir des 429 en série.
const CG_MIN_INTERVAL_KEYED = Number(process.env.COINGECKO_MIN_INTERVAL_MS ?? 300);
const CG_MIN_INTERVAL_ANON = Number(process.env.COINGECKO_MIN_INTERVAL_MS_ANON ?? 5000);
let cgLastCallAt = 0;
let cgChain: Promise<unknown> = Promise.resolve();

// Sérialisation réelle des appels (une file) : sans ça, 15 appels lancés en
// parallèle partent tous en même temps et se font tous refuser en 429.
function cgThrottle(keyed: boolean): Promise<unknown> {
  const run = cgChain.then(async () => {
    const minInterval = keyed ? CG_MIN_INTERVAL_KEYED : CG_MIN_INTERVAL_ANON;
    const gap = Date.now() - cgLastCallAt;
    if (gap < minInterval) await sleep(minInterval - gap);
    cgLastCallAt = Date.now();
  });
  cgChain = run.catch(() => undefined);
  return run;
}

// Nombre de coins dont on récupère l'historique par cycle.
// Avec une clé CoinGecko : 15 (30 appels/min, espacés de 300 ms).
// Sans clé (quota épuisé) : l'historique vient de DefiLlama (sans quota),
// on peut donc garder les 15 coins.
export function getHistoryFetchLimit(): number {
  return 15;
}

// Appel CoinGecko avec : détection de plan, repli anonyme si quota épuisé,
// et 2 tentatives sur rate-limit transitoire (limite par minute).
async function cgGet<T>(
  path: string,
  params: Record<string, string | number>,
  opts: { anonymous?: boolean; retries?: number } = {}
): Promise<T> {
  const key = process.env.COINGECKO_API_KEY;
  const maxAttempts = Math.max(1, opts.retries ?? 3);

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Recalculé à CHAQUE tentative : après un quota épuisé on doit repartir
    // sans la clé (sinon on re-échoue en boucle sur la même erreur).
    const useKey = Boolean(key) && !cgState.keyExhausted && !opts.anonymous;
    const requestParams: Record<string, string | number> = useKey
      ? { ...params, [cgKeyParam()]: key as string }
      : { ...params };

    try {
      await cgThrottle(useKey);
      const res = await axios.get(`${cgBase()}${path}`, { params: requestParams, timeout: 15000 });
      cgState.lastError = null;
      return res.data as T;
    } catch (e) {
      lastErr = e;

      // Mauvaise racine pour ce type de clé -> on bascule et on réessaie
      if (isRootUrlError(e) && useKey && attempt === 0) {
        cgState.plan = cgState.plan === 'demo' ? 'pro' : 'demo';
        cgState.lastError = `Type de clé détecté : ${cgState.plan} (racine ${cgBase()})`;
        console.warn(`[market-data] CoinGecko : bascule du plan -> ${cgState.plan}`);
        continue;
      }

      // Quota mensuel épuisé -> on bascule sur l'API publique anonyme
      if (isQuotaError(e) && useKey) {
        cgState.keyExhausted = true;
        cgState.lastError = null;
        cgState.lastErrorAt = Date.now();
        console.error('[market-data] Quota CoinGecko épuisé — repli sur l\'API publique anonyme');
        continue;
      }

      // Rate-limit transitoire (par minute) : on attend et on réessaie.
      // En mode anonyme le délai public est plus large (~1 min).
      if (axios.isAxiosError(e) && e.response?.status === 429 && attempt < maxAttempts - 1) {
        await sleep((useKey ? 1200 : 6000) * (attempt + 1));
        continue;
      }

      break;
    }
  }

  cgState.lastError = cgErrorMessage(lastErr);
  cgState.lastErrorAt = Date.now();
  throw lastErr;
}

// --- Cache mémoire (TTL) ----------------------------------------------------
const _cache = new Map<string, { data: unknown; at: number }>();

const TTL = {
  market: 60 * 1000,          // marché : 1 min
  history: 10 * 60 * 1000,    // historique : 10 min
  light: 10 * 60 * 1000,      // trending / global / TVL / taux : 10 min
  fng: 5 * 60 * 1000,         // Fear & Greed : 5 min
};

async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data as T;
  const data = await fn();
  // On ne cache pas les résultats vides (erreur transitoire) : sinon on
  // poisoned le cache pendant 10 min avec un faux "pas de données".
  if (Array.isArray(data) && data.length === 0) return data;
  if (data === null || data === undefined) return data;
  _cache.set(key, { data, at: Date.now() });
  return data;
}

// Top cryptos + interesting smaller ones to watch
export const WATCHLIST_COINS = [
  // Major
  'bitcoin', 'ethereum', 'solana', 'cardano', 'polkadot',
  // Layer 1 — established
  'avalanche-2', 'near', 'algorand', 'the-open-network',
  // Layer 2 / Scaling
  'arbitrum', 'optimism', 'starknet',
  // DeFi bluechips
  'chainlink', 'uniswap', 'aave', 'curve-dao-token', 'maker',
  // AI tokens (trending sector)
  'fetch-ai', 'singularitynet', 'ocean-protocol', 'render',
  // Gaming / Metaverse
  'immutable-x', 'the-sandbox',
  // Mid-cap promising
  'sui', 'aptos', 'injective-protocol', 'sei-network', 'celestia',
  // ETF-like / stable growth
  'ethereum-classic', 'litecoin', 'ripple',
];

// Free RSS feeds from major crypto news sources
const RSS_FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
  { url: 'https://cointelegraph.com/rss', source: 'CoinTelegraph' },
  { url: 'https://decrypt.co/feed', source: 'Decrypt' },
  { url: 'https://bitcoinmagazine.com/.rss/full/', source: 'Bitcoin Magazine' },
  { url: 'https://www.theblock.co/rss.xml', source: 'The Block' },
  { url: 'https://cryptoslate.com/feed/', source: 'CryptoSlate' },
  // Reddit RSS (public, no key needed)
  { url: 'https://www.reddit.com/r/CryptoCurrency/hot.rss?limit=10', source: 'Reddit r/Crypto' },
  { url: 'https://www.reddit.com/r/Bitcoin/hot.rss?limit=5', source: 'Reddit r/Bitcoin' },
  { url: 'https://www.reddit.com/r/ethereum/hot.rss?limit=5', source: 'Reddit r/Ethereum' },
];

export async function getEurUsdRate(): Promise<number> {
  return cached('eurusd', TTL.light, async () => {
    // 1) Frankfurter (BCE, gratuit, sans clé) : source principale, elle ne
    //    consomme aucun quota CoinGecko et tombe rarement.
    try {
      const res = await axios.get('https://api.frankfurter.app/latest', {
        params: { from: 'EUR', to: 'USD' },
        timeout: 10000,
      });
      const rate = (res.data as { rates?: { USD?: number } })?.rates?.USD;
      if (rate && rate > 0.5 && rate < 2) return rate;
    } catch { /* on tente CoinGecko */ }

    // 2) CoinGecko (1 seule tentative : le taux n'est pas critique et on ne
    //    veut pas brûler le quota anonyme avec des retries).
    try {
      const res = await cgGet<Record<string, { eur?: number }>>(
        '/simple/price',
        { ids: 'usd-coin', vs_currencies: 'eur' },
        { retries: 1 }
      );
      const usdcInEur = res['usd-coin']?.eur;
      if (usdcInEur) return usdcInEur;
    } catch { /* valeur par défaut */ }

    return 0.92;
  });
}

export async function getMarketData(
  coinIds?: string[],
  opts: { retries?: number } = {}
): Promise<MarketData[]> {
  const ids = coinIds ?? WATCHLIST_COINS;
  return cached(`market:${ids.join(',')}`, TTL.market, async () => {
    try {
      const params: Record<string, string | number> = {
        ids: ids.join(','),
        vs_currency: 'eur',
        order: 'market_cap_desc',
        per_page: '50',
        page: '1',
        sparkline: 'false',
        price_change_percentage: '24h,7d',
      };

      // Un seul appel CoinGecko : le prix USD est déduit du taux EUR/USD
      // (2 appels pour le même marché = 2 fois plus de quota pour rien).
      const eurRes = await cgGet<Array<{
        id: string; symbol: string; name: string; current_price: number;
        price_change_percentage_24h: number; price_change_percentage_7d_in_currency: number;
        total_volume: number; market_cap: number; market_cap_rank: number;
        ath: number; ath_change_percentage: number;
      }>>('/coins/markets', params, { retries: opts.retries ?? 3 });

      const eurUsd = await getEurUsdRate();

      return eurRes.map((coin) => ({
        symbol: coin.symbol.toUpperCase(),
        name: coin.name,
        price_eur: coin.current_price,
        price_usd: coin.current_price * eurUsd,
        change_24h: coin.price_change_percentage_24h ?? 0,
        change_7d: coin.price_change_percentage_7d_in_currency ?? 0,
        volume_24h_usd: coin.total_volume,
        market_cap_usd: coin.market_cap,
        market_cap_rank: coin.market_cap_rank,
        ath_eur: coin.ath,
        ath_change_percentage: coin.ath_change_percentage,
      }));
    } catch (error) {
      console.error('[market-data] Error fetching market data:', cgErrorMessage(error));
      return [];
    }
  });
}

// --- Source de secours pour l'historique : DefiLlama -------------------------
// Quand le quota CoinGecko est épuisé, l'API anonyme est limitée à ~8-10
// appels/min : impossible de charger l'historique de 15 coins dans un cycle.
// DefiLlama (coins.llama.fi) n'a ni clé ni quota, accepte les IDs CoinGecko
// ("coingecko:bitcoin") et renvoie l'historique quotidien en USD.
// 20 appels/tests en 4 s -> largement assez pour un cycle complet.
const LLAMA_CHART_BASE = 'https://coins.llama.fi/chart';

interface HistoryPoint {
  timestamp: number;
  price: number;
  volume: number;
}

async function getCoinHistoryLlama(coinId: string, days: number): Promise<HistoryPoint[]> {
  const res = await axios.get(`${LLAMA_CHART_BASE}/coingecko:${coinId}`, {
    params: { span: days },
    timeout: 15000,
  });
  const coins = (res.data as { coins?: Record<string, { prices?: Array<{ timestamp: number; price: number }> }> })?.coins;
  const points = coins?.[`coingecko:${coinId}`]?.prices ?? [];
  if (points.length === 0) return [];
  // DefiLlama donne des prix USD -> conversion en EUR (même base que le marché)
  const eurUsd = await getEurUsdRate();
  return points.map(p => ({
    timestamp: p.timestamp * 1000,
    price: p.price / eurUsd,
    volume: 0,
  }));
}

export async function getCoinHistory(
  coinId: string,
  days: number = 30
): Promise<{ timestamp: number; price: number; volume: number }[]> {
  return cached(`history:${coinId}:${days}`, TTL.history, async () => {
    // Quota CoinGecko épuisé : on va chercher l'historique chez DefiLlama
    // (aucun quota) au lieu de brûler le quota anonyme (~8 appels/min).
    if (cgState.keyExhausted) {
      try {
        const fallback = await getCoinHistoryLlama(coinId, days);
        if (fallback.length >= 26) return fallback;
      } catch { /* on tente CoinGecko ci-dessous */ }
      // DefiLlama n'a rien (coin délisté, ex: trending "gram") : inutile de
      // repartir sur CoinGecko, on sait qu'il répondra 429.
      return [];
    }

    try {
      const params: Record<string, string | number> = {
        vs_currency: 'eur',
        days: String(days),
        interval: days <= 7 ? 'hourly' : 'daily',
      };

      const res = await cgGet<{
        prices: Array<[number, number]>;
        total_volumes?: Array<[number, number]>;
      }>(`/coins/${coinId}/market_chart`, params);

      const volumes: Array<[number, number]> = res.total_volumes ?? [];
      return res.prices.map(([timestamp, price], i) => ({
        timestamp,
        price,
        volume: volumes[i]?.[1] ?? 0,
      }));
    } catch (error) {
      // 404 = coin inconnu/délisté (ex: trending "gram") : normal, on skip sans spammer les logs.
      // IMPORTANT : ne jamais logger l'objet d'erreur complet (il contient la clé API dans config.params).
      const notFound = axios.isAxiosError(error) && error.response?.status === 404;
      if (!notFound) {
        console.warn(`[market-data] history: échec pour ${coinId}:`, cgErrorMessage(error));
        // Secours DefiLlama (historique quotidien, sans quota)
        try {
          const fallback = await getCoinHistoryLlama(coinId, days);
          if (fallback.length >= 26) return fallback;
        } catch { /* rien de plus à faire */ }
      }
      return [];
    }
  });
}

export async function getTrendingCoins(): Promise<string[]> {
  return cached('trending', TTL.light, async () => {
    try {
      const res = await cgGet<{ coins: Array<{ item: { id: string } }> }>('/search/trending', {}, { retries: 1 });
      return res.coins
        .slice(0, 7)
        .map((item) => item.item.id);
    } catch {
      return [];
    }
  });
}

// DeFi Llama — free, no API key, no rate limit
export async function getDefiTVL(): Promise<{
  total_tvl_usd: number;
  change_1d: number;
  change_7d: number;
  top_protocols: Array<{ name: string; tvl: number; change_1d: number }>;
}> {
  try {
    const [globalRes, protocolsRes] = await Promise.all([
      axios.get('https://api.llama.fi/v2/chains', { timeout: 10000 }),
      axios.get('https://api.llama.fi/protocols', { timeout: 10000 }),
    ]);

    // Total TVL across all chains
    const chains = globalRes.data as Array<{ tvl: number; tokenSymbol: string }>;
    const total_tvl_usd = chains.reduce((acc: number, c) => acc + (c.tvl ?? 0), 0);

    // Top 5 protocols by TVL
    const protocols = (protocolsRes.data as Array<{
      name: string; tvl: number; change_1d: number; change_7d: number
    }>)
      .filter(p => p.tvl > 0)
      .sort((a, b) => b.tvl - a.tvl)
      .slice(0, 5);

    return {
      total_tvl_usd,
      change_1d: 0,
      change_7d: 0,
      top_protocols: protocols.map(p => ({
        name: p.name,
        tvl: p.tvl,
        change_1d: p.change_1d ?? 0,
      })),
    };
  } catch {
    return { total_tvl_usd: 0, change_1d: 0, change_7d: 0, top_protocols: [] };
  }
}

export async function getFearGreedIndex(): Promise<{
  value: number;
  label: string;
}> {
  return cached('fng', TTL.fng, async () => {
    try {
      const res = await axios.get('https://api.alternative.me/fng/', {
        timeout: 10000,
      });
      const data = res.data.data[0];
      return {
        value: parseInt(data.value),
        label: data.value_classification,
      };
    } catch {
      return { value: 50, label: 'Neutral' };
    }
  });
}

// Detect basic sentiment from headline text
function detectSentiment(title: string): 'positive' | 'negative' | 'neutral' {
  const lower = title.toLowerCase();

  const positiveWords = [
    'surge', 'soar', 'rally', 'gain', 'rise', 'bull', 'breakthrough',
    'record', 'high', 'adopt', 'launch', 'approve', 'partnership',
    'hausse', 'monte', 'approuve', 'croissance', 'bond', 'rebond',
    'all-time', 'ath', 'pump', 'green', 'recovery', 'recover',
  ];
  const negativeWords = [
    'crash', 'drop', 'fall', 'plunge', 'bear', 'hack', 'ban', 'scam',
    'fraud', 'loss', 'baisse', 'chute', 'interdit', 'pirate', 'arnaque',
    'sell', 'dump', 'fear', 'panic', 'warning', 'risk', 'concern',
    'suspend', 'delist', 'fine', 'lawsuit', 'sec', 'regulate',
  ];

  const posScore = positiveWords.filter(w => lower.includes(w)).length;
  const negScore = negativeWords.filter(w => lower.includes(w)).length;

  if (posScore > negScore) return 'positive';
  if (negScore > posScore) return 'negative';
  return 'neutral';
}

// Detect which crypto symbols are mentioned in a headline
function detectCurrencies(title: string): string[] {
  const symbolMap: Record<string, string> = {
    bitcoin: 'BTC', btc: 'BTC',
    ethereum: 'ETH', eth: 'ETH',
    solana: 'SOL', sol: 'SOL',
    cardano: 'ADA', ada: 'ADA',
    ripple: 'XRP', xrp: 'XRP',
    chainlink: 'LINK', link: 'LINK',
    avalanche: 'AVAX', avax: 'AVAX',
    polkadot: 'DOT', dot: 'DOT',
    uniswap: 'UNI', uni: 'UNI',
    aave: 'AAVE',
    arbitrum: 'ARB', arb: 'ARB',
    optimism: 'OP',
    litecoin: 'LTC', ltc: 'LTC',
  };

  const lower = title.toLowerCase();
  const found = new Set<string>();

  for (const [keyword, symbol] of Object.entries(symbolMap)) {
    if (lower.includes(keyword)) {
      found.add(symbol);
    }
  }

  return Array.from(found);
}

export async function getCryptoNews(): Promise<NewsItem[]> {
  const allNews: NewsItem[] = [];

  // 1. Try RSS feeds (completely free, no API key needed)
  const feedPromises = RSS_FEEDS.map(async (feed) => {
    try {
      const parsed = await rssParser.parseURL(feed.url);
      return (parsed.items ?? []).slice(0, 8).map(item => ({
        title: item.title ?? '',
        source: feed.source,
        url: item.link ?? item.guid ?? '',
        published_at: item.pubDate
          ? new Date(item.pubDate).toISOString()
          : new Date().toISOString(),
        sentiment: detectSentiment(item.title ?? ''),
        currencies: detectCurrencies(item.title ?? ''),
      }));
    } catch {
      return [];
    }
  });

  const feedResults = await Promise.allSettled(feedPromises);
  feedResults.forEach(result => {
    if (result.status === 'fulfilled') {
      allNews.push(...result.value);
    }
  });

  // 2. NewsAPI as optional supplement (free plan: 100 req/day, no key = skip)
  if (process.env.NEWSAPI_KEY && allNews.length < 10) {
    try {
      const res = await axios.get('https://newsapi.org/v2/everything', {
        params: {
          q: 'crypto OR bitcoin OR ethereum OR blockchain',
          language: 'en',
          sortBy: 'publishedAt',
          pageSize: 15,
          apiKey: process.env.NEWSAPI_KEY,
        },
        timeout: 10000,
      });

      const articles = res.data.articles ?? [];
      articles.forEach((article: {
        title: string;
        source: { name: string };
        url: string;
        publishedAt: string;
      }) => {
        allNews.push({
          title: article.title,
          source: article.source?.name ?? 'NewsAPI',
          url: article.url,
          published_at: article.publishedAt,
          sentiment: detectSentiment(article.title),
          currencies: detectCurrencies(article.title),
        });
      });
    } catch (error) {
      console.error('NewsAPI error:', error);
    }
  }

  // 3. CoinGecko news as final fallback
  if (allNews.length < 5) {
    try {
      const res = await cgGet<{ data?: Array<{
        title: string;
        author: string;
        url: string;
        updated_at: number;
      }> }>('/news', { per_page: 20 });

      res.data?.slice(0, 15).forEach((item) => {
        allNews.push({
          title: item.title,
          source: item.author ?? 'CoinGecko',
          url: item.url,
          published_at: new Date(item.updated_at * 1000).toISOString(),
          sentiment: detectSentiment(item.title),
          currencies: detectCurrencies(item.title),
        });
      });
    } catch (error) {
      console.error('[market-data] CoinGecko news fallback error:', cgErrorMessage(error));
    }
  }

  // Sort by date, deduplicate by title, cap at 25
  const seen = new Set<string>();
  return allNews
    .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime())
    .filter(item => {
      if (!item.title || seen.has(item.title)) return false;
      seen.add(item.title);
      return true;
    })
    .slice(0, 25);
}

function emptyIndicators(): Omit<TechnicalIndicators, 'symbol'> {
  return {
    rsi_14: null,
    macd: null,
    macd_signal: null,
    macd_histogram: null,
    sma_20: null,
    sma_50: null,
    ema_12: null,
    ema_26: null,
    bb_upper: null,
    bb_middle: null,
    bb_lower: null,
    trend: 'neutral',
    volatility_pct: null,
    volume_zscore: null,
    bb_width_pct: null,
    bb_squeeze: false,
    roc_30d: null,
    macd_hist_slope: null,
  };
}

// Volatilité journalière (%) : écart-type des rendements log (proxy ATR pour le sizing)
export function calculateVolatilityPct(prices: number[], lookback = 30): number | null {
  if (prices.length < 5) return null;
  const slice = prices.slice(-(lookback + 1));
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1] > 0 && slice[i] > 0) rets.push(Math.log(slice[i] / slice[i - 1]));
  }
  if (rets.length < 4) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + Math.pow(r - mean, 2), 0) / rets.length;
  return Math.sqrt(variance) * 100;
}

export function calculateTechnicalIndicators(
  prices: number[],
  volumes?: number[]
): Omit<TechnicalIndicators, 'symbol'> {
  if (prices.length < 26) {
    return emptyIndicators();
  }

  const rsi_14 = calculateRSI(prices, 14);
  const ema_12 = calculateEMA(prices, 12);
  const ema_26 = calculateEMA(prices, 26);
  const macdLine = ema_12 - ema_26;

  // MACD: EMA12 - EMA26, signal = EMA9 of MACD line (filter out zeros)
  const macdPrices = prices
    .map((_, i) => {
      if (i < 25) return null;
      return calculateEMA(prices.slice(0, i + 1), 12) - calculateEMA(prices.slice(0, i + 1), 26);
    })
    .filter((v): v is number => v !== null);
  const macd_signal = macdPrices.length >= 9 ? calculateEMA(macdPrices.slice(-9), 9) : 0;
  const macd_histogram = macdLine - macd_signal;

  const sma_20 = prices.length >= 20
    ? prices.slice(-20).reduce((a, b) => a + b, 0) / 20
    : null;
  const sma_50 = prices.length >= 50
    ? prices.slice(-50).reduce((a, b) => a + b, 0) / 50
    : null;

  let bb_upper = null, bb_middle = null, bb_lower = null;
  if (sma_20 !== null) {
    const slice20 = prices.slice(-20);
    const variance = slice20.reduce((acc, p) => acc + Math.pow(p - sma_20, 2), 0) / 20;
    const std = Math.sqrt(variance);
    bb_upper = sma_20 + 2 * std;
    bb_middle = sma_20;
    bb_lower = sma_20 - 2 * std;
  }

  const currentPrice = prices[prices.length - 1];
  let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (ema_12 > ema_26 && macdLine > 0 && (rsi_14 ?? 50) > 50) {
    trend = 'bullish';
  } else if (ema_12 < ema_26 && macdLine < 0 && (rsi_14 ?? 50) < 50) {
    trend = 'bearish';
  } else if (sma_20 && currentPrice > sma_20) {
    trend = 'bullish';
  } else if (sma_20 && currentPrice < sma_20) {
    trend = 'bearish';
  }

  // --- Signaux pré-boom / volatilité ---
  const volatility_pct = calculateVolatilityPct(prices);

  // Z-score du dernier volume vs 30 précédents (> 2 = breakout d'intérêt)
  let volume_zscore: number | null = null;
  if (volumes && volumes.length >= 10) {
    const prev = volumes.slice(-31, -1);
    const last = volumes[volumes.length - 1];
    if (prev.length >= 5 && last > 0) {
      const mean = prev.reduce((a, b) => a + b, 0) / prev.length;
      const variance = prev.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / prev.length;
      const std = Math.sqrt(variance);
      volume_zscore = std > 0 ? (last - mean) / std : 0;
    }
  }

  // Largeur des bandes + squeeze (compression = énergie avant expansion)
  let bb_width_pct: number | null = null;
  let bb_squeeze = false;
  if (bb_upper !== null && bb_lower !== null && bb_middle) {
    bb_width_pct = ((bb_upper - bb_lower) / bb_middle) * 100;
    // Percentile de la largeur actuelle vs fenêtres 20j glissantes sur 60 points
    const widths: number[] = [];
    for (let start = Math.max(0, prices.length - 60); start + 20 <= prices.length; start++) {
      const w = prices.slice(start, start + 20);
      const m = w.reduce((a, b) => a + b, 0) / 20;
      if (!(m > 0)) continue;
      const v = w.reduce((acc, p) => acc + Math.pow(p - m, 2), 0) / 20;
      widths.push((2 * Math.sqrt(v) * 2 / m) * 100); // (upper-lower)/middle en %
    }
    if (widths.length >= 5 && bb_width_pct !== null) {
      const below = widths.filter(w => w < (bb_width_pct as number)).length;
      bb_squeeze = below / widths.length <= 0.2;
    }
  }

  // Momentum 30 jours
  let roc_30d: number | null = null;
  if (prices.length >= 31) {
    const ref = prices[prices.length - 31];
    if (ref > 0) roc_30d = ((currentPrice - ref) / ref) * 100;
  }

  // Pente de l'histogramme MACD (accélération du momentum)
  let macd_hist_slope: number | null = null;
  if (macdPrices.length >= 2) {
    const prevMacd = macdPrices[macdPrices.length - 2];
    const prevHist = prevMacd - macd_signal;
    macd_hist_slope = macd_histogram - prevHist;
  }

  return {
    rsi_14,
    macd: macdLine,
    macd_signal,
    macd_histogram,
    sma_20,
    sma_50,
    ema_12,
    ema_26,
    bb_upper,
    bb_middle,
    bb_lower,
    trend,
    volatility_pct,
    volume_zscore,
    bb_width_pct,
    bb_squeeze,
    roc_30d,
    macd_hist_slope,
  };
}

// Benchmark BTC normalisé (base 100) pour comparer le bot au simple "hold BTC".
// Historique 31j, cache 30 min, null si inaccessible (non-bloquant).
let _benchCache: { points: Array<{ t: number; v: number }>; at: number } | null = null;
export async function getBtcBenchmark(): Promise<Array<{ t: number; v: number }> | null> {
  if (_benchCache && Date.now() - _benchCache.at < 30 * 60 * 1000) return _benchCache.points;
  try {
    const history = await getCoinHistory('bitcoin', 31);
    if (history.length < 5) return null;
    const base = history[0].price;
    if (!(base > 0)) return null;
    const points = history.map(h => ({ t: h.timestamp, v: (h.price / base) * 100 }));
    _benchCache = { points, at: Date.now() };
    return points;
  } catch {
    return null;
  }
}

// Dominance BTC (%) — régime de marché (altseason vs fuite vers BTC).
// CoinGecko /global, cache 10 min, null si inaccessible (non-bloquant).
let _globalCache: { btc: number; at: number } | null = null;
export async function getBtcDominance(): Promise<number | null> {
  if (_globalCache && Date.now() - _globalCache.at < 10 * 60 * 1000) return _globalCache.btc;
  try {
    const res = await cgGet<{ data?: { market_cap_percentage?: { btc?: number } } }>('/global', {}, { retries: 1 });
    const btc = Number(res?.data?.market_cap_percentage?.btc);
    if (Number.isFinite(btc) && btc > 0) {
      _globalCache = { btc, at: Date.now() };
      return btc;
    }
    return null;
  } catch {
    return null;
  }
}

function calculateRSI(prices: number[], period: number): number {
  if (prices.length < period + 1) return 50;

  const changes = prices.slice(-period - 1).map((p, i, arr) =>
    i === 0 ? 0 : p - arr[i - 1]
  ).slice(1);

  const gains = changes.map(c => (c > 0 ? c : 0));
  const losses = changes.map(c => (c < 0 ? -c : 0));

  const avgGain = gains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateEMA(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

export const SYMBOL_TO_COINGECKO_ID: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  ADA: 'cardano',
  DOT: 'polkadot',
  AVAX: 'avalanche-2',
  NEAR: 'near',
  ALGO: 'algorand',
  TON: 'the-open-network',
  ARB: 'arbitrum',
  OP: 'optimism',
  STRK: 'starknet',
  LINK: 'chainlink',
  UNI: 'uniswap',
  AAVE: 'aave',
  CRV: 'curve-dao-token',
  MKR: 'maker',
  FET: 'fetch-ai',
  AGIX: 'singularitynet',
  OCEAN: 'ocean-protocol',
  RNDR: 'render',
  IMX: 'immutable-x',
  SAND: 'the-sandbox',
  SUI: 'sui',
  APT: 'aptos',
  INJ: 'injective-protocol',
  SEI: 'sei-network',
  TIA: 'celestia',
  ETC: 'ethereum-classic',
  LTC: 'litecoin',
  XRP: 'ripple',
};
