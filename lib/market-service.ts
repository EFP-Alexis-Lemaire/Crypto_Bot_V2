import { DbContext } from './db';
import { MarketData } from './types';
import { getMarketData, getCoinGeckoStatus } from './market-data';
import { saveMarketSnapshot, readMarketSnapshot } from './market-snapshot';

// Résolution unifiée des données marché :
//  - live      : CoinGecko répond (données fraîches)
//  - snapshot  : CoinGecko est HS/quota épuisé -> dernier état connu en DB
//  - none      : aucune donnée disponible du tout
//
// `fresh` est le signal utilisé par les cycles de trading : on ne trade
// JAMAIS sur des prix périmés (un stop calculé sur un prix vieux de 2h est
// un stop faux). Le dashboard, lui, affiche le snapshot avec un bandeau
// "données de X min" pour que l'utilisateur comprenne ce qu'il voit.
export interface MarketState {
  data: MarketData[];
  source: 'live' | 'snapshot';
  fresh: boolean;
  fetchedAt: string | null;
  ageMinutes: number | null;
  error: string | null;
}

export async function resolveMarketState(
  ctx: DbContext,
  coinIds?: string[]
): Promise<MarketState> {
  const live = await getMarketData(coinIds);

  if (live.length > 0) {
    await saveMarketSnapshot(ctx, live);
    return {
      data: live,
      source: 'live',
      fresh: true,
      fetchedAt: new Date().toISOString(),
      ageMinutes: 0,
      error: null,
    };
  }

  const error = getCoinGeckoStatus().lastError
    ?? 'CoinGecko injoignable (quota épuisé ou API indisponible)';
  const snapshot = await readMarketSnapshot(ctx);

  if (snapshot) {
    const ageMinutes = Math.max(
      0,
      Math.round((Date.now() - new Date(snapshot.at).getTime()) / 60000)
    );
    return {
      data: snapshot.data,
      source: 'snapshot',
      fresh: false,
      fetchedAt: snapshot.at,
      ageMinutes,
      error,
    };
  }

  return {
    data: [],
    source: 'live',
    fresh: false,
    fetchedAt: null,
    ageMinutes: null,
    error,
  };
}
