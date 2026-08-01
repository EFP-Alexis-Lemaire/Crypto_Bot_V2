import { NextResponse } from 'next/server';
import { getMarketData, getFearGreedIndex, getEurUsdRate, getCryptoNews } from '@/lib/market-data';
import { WATCHLIST_COINS } from '@/lib/market-data';

export const revalidate = 60; // Cache for 60 seconds

export async function GET() {
  try {
    const [marketData, fearGreed, eurUsdRate, news] = await Promise.all([
      getMarketData(WATCHLIST_COINS),
      getFearGreedIndex(),
      getEurUsdRate(),
      getCryptoNews(),
    ]);

    return NextResponse.json({
      marketData: marketData.slice(0, 20),
      fearGreed,
      eurUsdRate,
      news: news.slice(0, 10),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch market data', details: String(error) },
      { status: 500 }
    );
  }
}
