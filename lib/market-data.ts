import axios from 'axios';
import Parser from 'rss-parser';
import { MarketData, TechnicalIndicators, NewsItem } from './types';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const rssParser = new Parser({ timeout: 8000 });

// Top cryptos + interesting smaller ones to watch
export const WATCHLIST_COINS = [
  // Major
  'bitcoin', 'ethereum', 'solana', 'cardano', 'polkadot',
  // Mid-cap promising
  'avalanche-2', 'chainlink', 'uniswap', 'aave', 'sui',
  'arbitrum', 'optimism', 'injective-protocol', 'render',
  // Small/Emerging
  'celestia', 'starknet', 'worldcoin-wld', 'sei-network', 'aptos',
  // Stable growth
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
];

export async function getEurUsdRate(): Promise<number> {
  try {
    const res = await axios.get(
      `${COINGECKO_BASE}/simple/price?ids=usd-coin&vs_currencies=eur`,
      { timeout: 10000 }
    );
    const usdcInEur = res.data['usd-coin']?.eur;
    if (usdcInEur) return usdcInEur;
    return 0.92;
  } catch {
    return 0.92;
  }
}

export async function getMarketData(coinIds?: string[]): Promise<MarketData[]> {
  const ids = coinIds ?? WATCHLIST_COINS;
  try {
    const params: Record<string, string> = {
      ids: ids.join(','),
      vs_currency: 'eur',
      order: 'market_cap_desc',
      per_page: '50',
      page: '1',
      sparkline: 'false',
      price_change_percentage: '24h,7d',
    };

    if (process.env.COINGECKO_API_KEY) {
      params['x_cg_demo_api_key'] = process.env.COINGECKO_API_KEY;
    }

    const [eurRes, usdRes] = await Promise.all([
      axios.get(`${COINGECKO_BASE}/coins/markets`, { params, timeout: 15000 }),
      axios.get(`${COINGECKO_BASE}/coins/markets`, {
        params: { ...params, vs_currency: 'usd' },
        timeout: 15000,
      }),
    ]);

    const usdMap: Record<string, number> = {};
    usdRes.data.forEach((coin: { id: string; current_price: number }) => {
      usdMap[coin.id] = coin.current_price;
    });

    return eurRes.data.map((coin: {
      id: string;
      symbol: string;
      name: string;
      current_price: number;
      price_change_percentage_24h: number;
      price_change_percentage_7d_in_currency: number;
      total_volume: number;
      market_cap: number;
      market_cap_rank: number;
      ath: number;
      ath_change_percentage: number;
    }) => ({
      symbol: coin.symbol.toUpperCase(),
      name: coin.name,
      price_eur: coin.current_price,
      price_usd: usdMap[coin.id] ?? coin.current_price / 0.92,
      change_24h: coin.price_change_percentage_24h ?? 0,
      change_7d: coin.price_change_percentage_7d_in_currency ?? 0,
      volume_24h_usd: coin.total_volume,
      market_cap_usd: coin.market_cap,
      market_cap_rank: coin.market_cap_rank,
      ath_eur: coin.ath,
      ath_change_percentage: coin.ath_change_percentage,
    }));
  } catch (error) {
    console.error('Error fetching market data:', error);
    return [];
  }
}

export async function getCoinHistory(
  coinId: string,
  days: number = 30
): Promise<{ timestamp: number; price: number }[]> {
  try {
    const params: Record<string, string> = {
      vs_currency: 'eur',
      days: String(days),
      interval: days <= 7 ? 'hourly' : 'daily',
    };

    if (process.env.COINGECKO_API_KEY) {
      params['x_cg_demo_api_key'] = process.env.COINGECKO_API_KEY;
    }

    const res = await axios.get(
      `${COINGECKO_BASE}/coins/${coinId}/market_chart`,
      { params, timeout: 15000 }
    );

    return res.data.prices.map(([timestamp, price]: [number, number]) => ({
      timestamp,
      price,
    }));
  } catch (error) {
    console.error(`Error fetching history for ${coinId}:`, error);
    return [];
  }
}

export async function getTrendingCoins(): Promise<string[]> {
  try {
    const res = await axios.get(`${COINGECKO_BASE}/search/trending`, {
      timeout: 10000,
    });
    return res.data.coins
      .slice(0, 7)
      .map((item: { item: { id: string } }) => item.item.id);
  } catch {
    return [];
  }
}

export async function getFearGreedIndex(): Promise<{
  value: number;
  label: string;
}> {
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
      const cgParams: Record<string, string | number> = { per_page: 20 };
      if (process.env.COINGECKO_API_KEY) {
        cgParams['x_cg_demo_api_key'] = process.env.COINGECKO_API_KEY;
      }
      const res = await axios.get(`${COINGECKO_BASE}/news`, {
        params: cgParams,
        timeout: 10000,
      });
      res.data.data?.slice(0, 15).forEach((item: {
        title: string;
        author: string;
        url: string;
        updated_at: number;
      }) => {
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
      console.error('CoinGecko news fallback error:', error);
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

export function calculateTechnicalIndicators(
  prices: number[]
): Omit<TechnicalIndicators, 'symbol'> {
  if (prices.length < 26) {
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
    };
  }

  const rsi_14 = calculateRSI(prices, 14);
  const ema_12 = calculateEMA(prices, 12);
  const ema_26 = calculateEMA(prices, 26);
  const macdLine = ema_12 - ema_26;

  const macdPrices = prices.map((_, i) => {
    if (i < 25) return 0;
    return calculateEMA(prices.slice(0, i + 1), 12) - calculateEMA(prices.slice(0, i + 1), 26);
  });
  const macd_signal = calculateEMA(macdPrices.slice(-9), 9);
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
  };
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
  LINK: 'chainlink',
  UNI: 'uniswap',
  AAVE: 'aave',
  SUI: 'sui',
  ARB: 'arbitrum',
  OP: 'optimism',
  INJ: 'injective-protocol',
  RNDR: 'render',          // ancien: render-token
  TIA: 'celestia',
  STRK: 'starknet',
  WLD: 'worldcoin-wld',   // ancien: worldcoin
  SEI: 'sei-network',
  APT: 'aptos',
  ETC: 'ethereum-classic',
  LTC: 'litecoin',
  XRP: 'ripple',
};
