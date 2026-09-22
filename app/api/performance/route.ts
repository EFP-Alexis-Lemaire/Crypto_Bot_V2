import { NextResponse } from 'next/server';
import { sqlForContext, getDbContext } from '@/lib/db';
import { getMarketData, WATCHLIST_COINS } from '@/lib/market-data';
import { getPortfolioSummary } from '@/lib/portfolio';

type Row = Record<string, unknown>;
const num = (v: unknown): number => parseFloat(String(v ?? 0)) || 0;

export interface SymbolPerformance {
  symbol: string;
  name: string;
  buys: number;
  sells: number;
  volume_eur: number;
  fees_eur: number;
  realized_eur: number;
  unrealized_eur: number;
  total_eur: number;
  holding_value_eur: number;
  avg_buy_price_eur: number;
  current_price_eur: number;
}

interface Lot { qty: number; unitCost: number }

// GET : performance par crypto — réalisé (FIFO sur l'historique des trades)
// + latent (positions actuelles) = total. Trié du meilleur au pire.
export async function GET(request: Request) {
  try {
    const ctx = getDbContext(request);
    const db = sqlForContext(ctx);
    const modeRows = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
    const env = modeRows[0]?.value === 'live' ? 'live' : 'paper';

    const trades = (await db`
      SELECT symbol, action, amount, total_eur, fee_eur
      FROM trades
      WHERE env = ${env} AND action IN ('BUY', 'SELL')
      ORDER BY executed_at ASC, id ASC
      LIMIT 5000
    `) as Row[];

    // FIFO : file de lots d'achat (quantité, coût unitaire frais inclus)
    const lots: Record<string, Lot[]> = {};
    const stats: Record<string, { buys: number; sells: number; volume: number; fees: number; realized: number }> = {};
    const touch = (s: string) => (stats[s] ??= { buys: 0, sells: 0, volume: 0, fees: 0, realized: 0 });

    for (const t of trades) {
      const sym = String(t.symbol);
      const qty = num(t.amount);
      const total = num(t.total_eur);
      const fee = num(t.fee_eur);
      if (qty <= 0) continue;
      const st = touch(sym);
      st.fees += fee;
      if (String(t.action) === 'BUY') {
        st.buys += 1;
        st.volume += total;
        (lots[sym] ??= []).push({ qty, unitCost: total / qty });
      } else {
        st.sells += 1;
        const netPerUnit = total / qty; // total_eur = net reçu (frais déduits)
        let remaining = qty;
        const queue = lots[sym] ?? [];
        while (remaining > 1e-12 && queue.length > 0) {
          const lot = queue[0];
          const matched = Math.min(lot.qty, remaining);
          st.realized += matched * (netPerUnit - lot.unitCost);
          lot.qty -= matched;
          remaining -= matched;
          if (lot.qty <= 1e-12) queue.shift();
        }
        // Vente sans lot connu (ex: position pré-existante) : gain non attribuable -> ignoré
      }
    }

    // Latent : positions actuelles valorisées au prix marché
    const marketData = await getMarketData(WATCHLIST_COINS);
    const portfolio = await getPortfolioSummary(marketData, env as 'paper' | 'live', ctx);
    const priceMap: Record<string, { price: number; name: string }> = {};
    marketData.forEach(m => { priceMap[m.symbol] = { price: m.price_eur, name: m.name }; });
    const held: Record<string, { value: number; pnl: number; avg: number; price: number }> = {};
    for (const h of portfolio.holdings) {
      held[h.symbol] = {
        value: h.current_value_eur,
        pnl: h.pnl_eur,
        avg: h.avg_buy_price_eur,
        price: h.current_price_eur,
      };
      touch(h.symbol);
    }

    const rows: SymbolPerformance[] = Object.entries(stats).map(([symbol, st]) => {
      const h = held[symbol];
      const unrealized = h ? h.pnl : 0;
      return {
        symbol,
        name: priceMap[symbol]?.name ?? symbol,
        buys: st.buys,
        sells: st.sells,
        volume_eur: Number(st.volume.toFixed(2)),
        fees_eur: Number(st.fees.toFixed(2)),
        realized_eur: Number(st.realized.toFixed(2)),
        unrealized_eur: Number(unrealized.toFixed(2)),
        total_eur: Number((st.realized + unrealized).toFixed(2)),
        holding_value_eur: Number((h?.value ?? 0).toFixed(2)),
        avg_buy_price_eur: Number((h?.avg ?? 0).toFixed(6)),
        current_price_eur: Number(((h?.price ?? priceMap[symbol]?.price) ?? 0).toFixed(6)),
      };
    });

    // Meilleurs en premier, pires en dernier (les poussières sans P&L restent visibles en bas)
    rows.sort((a, b) => b.total_eur - a.total_eur);

    const totals = {
      realized_eur: Number(rows.reduce((s, r) => s + r.realized_eur, 0).toFixed(2)),
      unrealized_eur: Number(rows.reduce((s, r) => s + r.unrealized_eur, 0).toFixed(2)),
      fees_eur: Number(rows.reduce((s, r) => s + r.fees_eur, 0).toFixed(2)),
    };

    return NextResponse.json({ performance: rows, totals, env, ctx });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to compute performance', details: String(error) }, { status: 500 });
  }
}
