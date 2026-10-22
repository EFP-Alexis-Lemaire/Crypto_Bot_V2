import { NextResponse } from 'next/server';
import { getFearGreedIndex, getEurUsdRate, getCryptoNews, getBtcBenchmark, getCoinGeckoStatus, WATCHLIST_COINS } from '@/lib/market-data';
import { resolveMarketState } from '@/lib/market-service';
import { getDbContext } from '@/lib/db';

export const revalidate = 60; // Cache for 60 seconds

export async function GET(request: Request) {
  const ctx = getDbContext(request);
  try {
    const [market, fearGreed, eurUsdRate, news, btcBenchmark] = await Promise.all([
      resolveMarketState(ctx, WATCHLIST_COINS),
      getFearGreedIndex(),
      getEurUsdRate(),
      getCryptoNews(),
      getBtcBenchmark(),
    ]);

    return NextResponse.json({
      marketData: market.data.slice(0, 20),
      // 'live' = CoinGecko répond, 'snapshot' = dernier état connu (données périmées)
      source: market.source,
      fresh: market.fresh,
      fetchedAt: market.fetchedAt,
      ageMinutes: market.ageMinutes,
      error: market.error,
      coingecko: getCoinGeckoStatus(),
      fearGreed,
      eurUsdRate,
      news: news.slice(0, 10),
      btcBenchmark,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch market data', details: String(error) },
      { status: 500 }
    );
  }
}
