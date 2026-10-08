import { NextResponse } from 'next/server';
import { sqlForContext, getDbContext } from '@/lib/db';
import {
  getMarketData,
  getCoinHistory,
  calculateVolatilityPct,
  WATCHLIST_COINS,
  SYMBOL_TO_COINGECKO_ID,
} from '@/lib/market-data';
import { getPortfolioSummary } from '@/lib/portfolio';
import { dynamicStopPct } from '@/lib/types';

type Row = Record<string, unknown>;
const num = (v: unknown): number => parseFloat(String(v ?? 0)) || 0;

export interface ProtectionStatus {
  symbol: string;
  change_pct: number;
  stop_dyn_pct: number;
  // Marge restante avant le stop (points) : <= 0 = le stop se déclenche au prochain cycle/guardian
  dist_to_stop_pts: number;
  take_profit_pct: number;
  partial_taken: boolean;
  trailing_high_eur: number | null;
  // Retracement depuis le plus haut (points, <= 0). null si pas de suivi.
  trailing_dd_pts: number | null;
  status: 'stop-hit' | 'near-stop' | 'armed';
}

// GET : état des protections par position — pour VOIR si les stops sont armés,
// à quelle distance, et si un TP partiel a déjà été pris.
// Même moteur que l'exécution (stop dynamique 1.5× vol), donc ce qui s'affiche
// est exactement ce que le bot appliquera au prochain cycle/guardian.
export async function GET(request: Request) {
  try {
    const ctx = getDbContext(request);
    const db = sqlForContext(ctx);
    const modeRows = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
    const env = modeRows[0]?.value === 'live' ? 'live' : 'paper';
    const cfgRows = (await db`SELECT key, value FROM bot_config`) as Row[];
    const cfg: Record<string, string> = {};
    cfgRows.forEach(c => { cfg[String(c.key)] = String(c.value); });
    const stopCfg = parseFloat(cfg.stop_loss_pct ?? '8') || 8;
    const tpCfg = parseFloat(cfg.take_profit_pct ?? '15') || 15;

    const marketData = await getMarketData(WATCHLIST_COINS);
    const priceMap: Record<string, number> = {};
    marketData.forEach(m => { priceMap[m.symbol] = m.price_eur; });
    const portfolio = await getPortfolioSummary(marketData, env as 'paper' | 'live', ctx);

    // Flags + plus hauts (colonnes post-migration ; absentes = valeurs neutres)
    const flags: Record<string, { partial: boolean; highest: number }> = {};
    try {
      const rows = (await db`
        SELECT symbol, partial_tp_taken, highest_price_eur FROM portfolio
        WHERE symbol != 'EUR' AND env = ${env}
      `) as Row[];
      for (const r of rows) {
        flags[String(r.symbol)] = {
          partial: String(r.partial_tp_taken).toLowerCase() === 'true',
          highest: num(r.highest_price_eur),
        };
      }
    } catch { /* pré-migration : pas de suivi TP/trailing */ }

    // Volatilité par position significative (historique 60j, cache non partagé
    // avec les cycles — quelques appels seulement, positions >= 5€)
    const significant = portfolio.holdings.filter(h => h.current_value_eur >= 5).slice(0, 10);
    const volMap: Record<string, number> = {};
    await Promise.all(
      significant.map(async h => {
        try {
          const coinId = SYMBOL_TO_COINGECKO_ID[h.symbol] ?? h.symbol.toLowerCase();
          const history = await getCoinHistory(coinId, 60);
          const vol = calculateVolatilityPct(history.map(p => p.price));
          if (vol !== null && vol > 0) volMap[h.symbol] = vol;
        } catch { /* une position sans vol = stop config */ }
      })
    );

    const positions: ProtectionStatus[] = significant.map(h => {
      const avg = h.avg_buy_price_eur;
      const change = avg > 0 ? ((h.current_price_eur - avg) / avg) * 100 : 0;
      const dynStop = dynamicStopPct(volMap[h.symbol] ?? null, stopCfg);
      const distToStop = change + dynStop;
      const partial = flags[h.symbol]?.partial ?? false;
      const highest = flags[h.symbol]?.highest ?? 0;
      const trailingDd = highest > 0 ? ((h.current_price_eur - highest) / highest) * 100 : null;
      const status: ProtectionStatus['status'] =
        change <= -dynStop ? 'stop-hit'
        : distToStop < dynStop * 0.25 ? 'near-stop'
        : 'armed';
      return {
        symbol: h.symbol,
        change_pct: Number(change.toFixed(2)),
        stop_dyn_pct: Number(dynStop.toFixed(1)),
        dist_to_stop_pts: Number(distToStop.toFixed(2)),
        take_profit_pct: tpCfg,
        partial_taken: partial,
        trailing_high_eur: highest > 0 ? Number(highest.toFixed(6)) : null,
        trailing_dd_pts: trailingDd !== null ? Number(trailingDd.toFixed(2)) : null,
        status,
      };
    });

    // Les plus en danger d'abord
    positions.sort((a, b) => a.dist_to_stop_pts - b.dist_to_stop_pts);

    return NextResponse.json({ positions, env, ctx });
  } catch (error) {
    return NextResponse.json({ error: 'Protection status failed', details: String(error) }, { status: 500 });
  }
}
