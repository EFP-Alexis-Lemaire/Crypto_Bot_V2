import { sqlForContext, DbContext } from './db';
import { computeFifo } from './fifo';

/**
 * Bot Memory — gives the AI context about its own past decisions and performance.
 * This is injected into every analysis prompt so the AI learns from its history.
 */

interface TradeMemory {
  symbol: string;
  action: 'BUY' | 'SELL';
  price_eur: number;
  total_eur: number;
  executed_at: string;
  days_ago: number;
}

interface SymbolPerformance {
  symbol: string;
  total_trades: number;
  buy_count: number;
  sell_count: number;
  total_invested_eur: number;
  total_returned_eur: number;
  estimated_pnl_eur: number;
  win_rate: number; // % of profitable sell trades
  last_action: string;
  last_action_days_ago: number;
  avg_hold_days: number;
}

interface BotMemory {
  // Recent trades (last 30 days)
  recent_trades: TradeMemory[];

  // Per-symbol performance summary
  symbol_performance: SymbolPerformance[];

  // Portfolio evolution
  portfolio_trend: 'improving' | 'declining' | 'stable';
  best_performer: string;
  worst_performer: string;

  // Bot behavior patterns
  total_trades_30d: number;
  win_rate_overall: number;
  avg_trade_size_eur: number;

  // Lessons — derived insights
  lessons: string[];
}

// Mémoire scopée par CONTEXTE (DB UAT vs PROD), pas par env (paper/live) :
// tout l'historique de la base compte, sans mélange entre UAT et prod.
export async function getBotMemory(ctx: DbContext = 'uat'): Promise<BotMemory> {
  const sql = sqlForContext(ctx);
  try {
    // Recent trades last 30 days
    const recentTradesRaw = (await sql`
      SELECT symbol, action, price_eur, total_eur, executed_at,
             EXTRACT(DAY FROM NOW() - executed_at)::int as days_ago
      FROM trades
      WHERE executed_at > NOW() - INTERVAL '30 days'
      ORDER BY executed_at DESC
      LIMIT 50
    `) as Array<Record<string, unknown>>;

    const recentTrades: TradeMemory[] = recentTradesRaw.map(t => ({
      symbol: String(t.symbol),
      action: String(t.action) as 'BUY' | 'SELL',
      price_eur: parseFloat(String(t.price_eur)),
      total_eur: parseFloat(String(t.total_eur)),
      executed_at: String(t.executed_at),
      days_ago: parseInt(String(t.days_ago ?? 0)),
    }));

    // Per-symbol performance
    const symbolStatsRaw = (await sql`
      SELECT
        symbol,
        COUNT(*) as total_trades,
        COUNT(CASE WHEN action = 'BUY' THEN 1 END) as buy_count,
        COUNT(CASE WHEN action = 'SELL' THEN 1 END) as sell_count,
        SUM(CASE WHEN action = 'BUY' THEN total_eur ELSE 0 END) as total_invested,
        SUM(CASE WHEN action = 'SELL' THEN total_eur ELSE 0 END) as total_returned,
        MAX(executed_at) as last_trade_at,
        MAX(action) as last_action,
        EXTRACT(DAY FROM NOW() - MAX(executed_at))::int as last_action_days_ago
      FROM trades
      WHERE executed_at > NOW() - INTERVAL '30 days'
      GROUP BY symbol
      ORDER BY total_trades DESC
    `) as Array<Record<string, unknown>>;

    const symbolPerformance: SymbolPerformance[] = symbolStatsRaw.map(s => {
      const invested = parseFloat(String(s.total_invested ?? 0));
      const returned = parseFloat(String(s.total_returned ?? 0));
      const buys = parseInt(String(s.buy_count ?? 0));
      const sells = parseInt(String(s.sell_count ?? 0));
      const pnl = returned - invested;
      const winRate = sells > 0 ? (pnl > 0 ? 100 : 0) : 0;

      return {
        symbol: String(s.symbol),
        total_trades: parseInt(String(s.total_trades ?? 0)),
        buy_count: buys,
        sell_count: sells,
        total_invested_eur: invested,
        total_returned_eur: returned,
        estimated_pnl_eur: pnl,
        win_rate: winRate,
        last_action: String(s.last_action ?? ''),
        last_action_days_ago: parseInt(String(s.last_action_days_ago ?? 0)),
        avg_hold_days: buys > 0 && sells > 0 ? Math.round(30 / Math.max(buys, 1)) : 0,
      };
    });

    // Portfolio snapshots trend (last 7 days)
    const snapshotsRaw = (await sql`
      SELECT total_value_eur, snapshotted_at
      FROM portfolio_snapshots
      WHERE snapshotted_at > NOW() - INTERVAL '7 days'
      ORDER BY snapshotted_at ASC
      LIMIT 20
    `) as Array<{ total_value_eur: string }>;

    let portfolioTrend: 'improving' | 'declining' | 'stable' = 'stable';
    if (snapshotsRaw.length >= 2) {
      const first = parseFloat(snapshotsRaw[0].total_value_eur);
      const last = parseFloat(snapshotsRaw[snapshotsRaw.length - 1].total_value_eur);
      const change = ((last - first) / first) * 100;
      if (change > 1) portfolioTrend = 'improving';
      else if (change < -1) portfolioTrend = 'declining';
    }

    // Overall win rate — based on sell trades vs their buy price
    const sellTradesRaw = (await sql`
      SELECT t_sell.symbol, t_sell.price_eur as sell_price, t_buy.price_eur as buy_price
      FROM trades t_sell
      JOIN LATERAL (
        SELECT price_eur FROM trades
        WHERE symbol = t_sell.symbol AND action = 'BUY'
        AND executed_at < t_sell.executed_at
        ORDER BY executed_at DESC LIMIT 1
      ) t_buy ON true
      WHERE t_sell.action = 'SELL'
      AND t_sell.executed_at > NOW() - INTERVAL '30 days'
    `) as Array<{ symbol: string; sell_price: string; buy_price: string }>;

    const winCount = sellTradesRaw.filter(t =>
      parseFloat(t.sell_price) > parseFloat(t.buy_price)
    ).length;
    const winRateOverall = sellTradesRaw.length > 0
      ? Math.round((winCount / sellTradesRaw.length) * 100)
      : 0;

    // Best/worst performers
    const sorted = [...symbolPerformance].sort((a, b) => b.estimated_pnl_eur - a.estimated_pnl_eur);
    const bestPerformer = sorted[0]?.symbol ?? 'N/A';
    const worstPerformer = sorted[sorted.length - 1]?.symbol ?? 'N/A';

    // Overall stats
    const totalTrades30d = recentTrades.length;
    const sellTrades = recentTrades.filter(t => t.action === 'SELL');
    const avgTradeSize = totalTrades30d > 0
      ? recentTrades.reduce((acc, t) => acc + t.total_eur, 0) / totalTrades30d
      : 0;

    // Generate lessons from patterns
    const lessons: string[] = [];

    // Lesson: recently sold symbols
    const recentSells = recentTrades.filter(t => t.action === 'SELL' && t.days_ago <= 3);
    if (recentSells.length > 0) {
      lessons.push(`Vendus récemment (< 3 jours): ${recentSells.map(s => s.symbol).join(', ')} — évite de les racheter immédiatement sauf signal très fort`);
    }

    // Lesson: over-trading a symbol
    const overtraded = symbolPerformance.filter(s => s.total_trades >= 4);
    if (overtraded.length > 0) {
      lessons.push(`Tendance à sur-trader: ${overtraded.map(s => `${s.symbol} (${s.total_trades} trades)`).join(', ')} — sois plus sélectif`);
    }

    // Lesson: portfolio trend
    if (portfolioTrend === 'improving') {
      lessons.push('Le portefeuille est en progression sur 7 jours — la stratégie actuelle fonctionne, maintiens le cap');
    } else if (portfolioTrend === 'declining') {
      lessons.push('Le portefeuille décline sur 7 jours — sois plus conservateur, réduis la taille des positions');
    }

    // Lesson: best/worst
    if (sorted.length > 1 && sorted[0].estimated_pnl_eur > 0) {
      lessons.push(`${bestPerformer} est ton meilleur actif du moment (+${sorted[0].estimated_pnl_eur.toFixed(2)}€) — surveille les opportunités de renforcement`);
    }
    if (sorted.length > 1 && sorted[sorted.length - 1].estimated_pnl_eur < -5) {
      lessons.push(`${worstPerformer} performe mal (${sorted[sorted.length - 1].estimated_pnl_eur.toFixed(2)}€) — évite d'augmenter cette position`);
    }

    // Lesson: inactive holds
    const longHolds = symbolPerformance.filter(s => s.buy_count > s.sell_count && s.last_action_days_ago > 7);
    if (longHolds.length > 0) {
      lessons.push(`Positions ouvertes depuis > 7 jours sans vente: ${longHolds.map(s => s.symbol).join(', ')} — réévalue si elles correspondent encore à ta thèse`);
    }

    return {
      recent_trades: recentTrades.slice(0, 20),
      symbol_performance: symbolPerformance,
      portfolio_trend: portfolioTrend,
      best_performer: bestPerformer,
      worst_performer: worstPerformer,
      total_trades_30d: totalTrades30d,
      win_rate_overall: winRateOverall,
      avg_trade_size_eur: avgTradeSize,
      lessons,
    };
  } catch (error) {
    console.error('Memory error:', error);
    return {
      recent_trades: [],
      symbol_performance: [],
      portfolio_trend: 'stable',
      best_performer: 'N/A',
      worst_performer: 'N/A',
      total_trades_30d: 0,
      win_rate_overall: 0,
      avg_trade_size_eur: 0,
      lessons: [],
    };
  }
}

// --- Revue des pertes (journal de trading) ---
// Quand le portefeuille perd plus de `thresholdPct` sur 3 jours, on remonte à
// l'IA ce qui a coûté cher (dossiers, sur-trading, concentration) + des règles
// anti-récidive. Sinon null (pas de bruit quand tout va bien).
export interface DrawdownReview {
  dd_eur: number;
  dd_pct: number;
  start_total: number;
  end_total: number;
  trades_count: number;
  buys_count: number;
  sells_count: number;
  realized_total_eur: number;
  worst: Array<{ symbol: string; realized_eur: number; trades: number }>;
  lessons: string[];
}

export async function getDrawdownReview(
  ctx: DbContext = 'uat',
  env = 'live',
  thresholdPct = -2,
): Promise<DrawdownReview | null> {
  const db = sqlForContext(ctx);
  try {
    const snaps = (await db`
      SELECT total_value_eur, snapshotted_at FROM portfolio_snapshots
      WHERE env = ${env} AND snapshotted_at > NOW() - INTERVAL '4 days'
      ORDER BY snapshotted_at ASC
    `) as Array<Record<string, unknown>>;
    if (snaps.length < 2) return null;
    const start = parseFloat(String(snaps[0].total_value_eur));
    const end = parseFloat(String(snaps[snaps.length - 1].total_value_eur));
    if (!(start > 0)) return null;
    const ddEur = end - start;
    const ddPct = (ddEur / start) * 100;
    if (ddPct > thresholdPct) return null; // pas de pertes significatives

    const trades = (await db`
      SELECT symbol, action, amount, total_eur, fee_eur FROM trades
      WHERE env = ${env} AND action IN ('BUY', 'SELL')
      AND executed_at > NOW() - INTERVAL '3 days'
      ORDER BY executed_at ASC
    `) as Array<Record<string, unknown>>;
    const { perSymbol } = computeFifo(
      trades.map(t => ({
        symbol: String(t.symbol),
        action: String(t.action),
        amount: parseFloat(String(t.amount ?? 0)) || 0,
        total_eur: parseFloat(String(t.total_eur ?? 0)) || 0,
        fee_eur: parseFloat(String(t.fee_eur ?? 0)) || 0,
      }))
    );

    let buys = 0;
    let sells = 0;
    let realizedTotal = 0;
    let buyVolume = 0;
    const worst: DrawdownReview['worst'] = [];
    for (const [symbol, st] of Object.entries(perSymbol)) {
      buys += st.buys;
      sells += st.sells;
      buyVolume += st.volume_eur;
      realizedTotal += st.realized_eur;
      if (st.realized_eur < -1) {
        worst.push({ symbol, realized_eur: st.realized_eur, trades: st.buys + st.sells });
      }
    }
    worst.sort((a, b) => a.realized_eur - b.realized_eur);

    const lessons: string[] = [];
    for (const w of worst.slice(0, 3)) {
      lessons.push(
        `${w.symbol} a coûté ${w.realized_eur.toFixed(2)}€ en ${w.trades} trade(s) sur 3j — avant d'y revenir : breakout volume (VolZ ≥ 2) ou squeeze + confiance ≥ 80, sinon SKIP.`
      );
    }
    if (buys >= 6) {
      lessons.push(
        `${buys} achats en 3 jours de pertes : sur-trading — réduis les montants de 25% et exige une confirmation volume sur chaque entrée.`
      );
    }
    if (sells >= buys + 2 && realizedTotal < 0) {
      lessons.push(
        `Ventes en cascade dans la baisse (${sells} ventes) : ne solde pas sur peur — laisse le stop-loss et le trailing travailler.`
      );
    }
    const topVol = Object.entries(perSymbol).sort((a, b) => b[1].volume_eur - a[1].volume_eur)[0];
    if (topVol && buyVolume > 0 && topVol[1].volume_eur / buyVolume > 0.5) {
      lessons.push(
        `Concentration excessive sur ${topVol[0]} (${((topVol[1].volume_eur / buyVolume) * 100).toFixed(0)}% des achats 3j) — diversifie, max 2 paris corrélés.`
      );
    }
    if (lessons.length === 0) {
      lessons.push(
        `Baisse subie (${ddEur.toFixed(2)}€) sans erreur de trading identifiée : marché adverse — reste sélectif, pas de rattrapage forcé.`
      );
    }

    return {
      dd_eur: Number(ddEur.toFixed(2)),
      dd_pct: Number(ddPct.toFixed(2)),
      start_total: Number(start.toFixed(2)),
      end_total: Number(end.toFixed(2)),
      trades_count: buys + sells,
      buys_count: buys,
      sells_count: sells,
      realized_total_eur: Number(realizedTotal.toFixed(2)),
      worst: worst.slice(0, 3).map(w => ({ ...w, realized_eur: Number(w.realized_eur.toFixed(2)) })),
      lessons,
    };
  } catch {
    return null; // non-bloquant : jamais d'échec de cycle pour la revue
  }
}

export function formatMemoryForPrompt(memory: BotMemory): string {
  if (memory.total_trades_30d === 0) {
    return '=== MÉMOIRE DU BOT ===\nAucun historique de trading disponible — premier cycle d\'analyse.';
  }

  const recentTradesSummary = memory.recent_trades
    .slice(0, 10)
    .map(t => `  ${t.action} ${t.symbol} à ${t.price_eur.toFixed(4)}€ (${t.total_eur.toFixed(0)}€ total) il y a ${t.days_ago}j`)
    .join('\n');

  const perfSummary = memory.symbol_performance
    .filter(s => s.total_trades > 0)
    .slice(0, 8)
    .map(s => {
      const pnlStr = s.estimated_pnl_eur >= 0
        ? `+${s.estimated_pnl_eur.toFixed(2)}€`
        : `${s.estimated_pnl_eur.toFixed(2)}€`;
      return `  ${s.symbol}: ${s.total_trades} trades, P&L estimé ${pnlStr}, dernier acte: ${s.last_action} il y a ${s.last_action_days_ago}j`;
    })
    .join('\n');

  const lessonsSummary = memory.lessons.length > 0
    ? memory.lessons.map(l => `  • ${l}`).join('\n')
    : '  • Pas encore assez de données pour générer des leçons';

  return `=== MÉMOIRE DU BOT (30 derniers jours) ===
Tendance portefeuille: ${memory.portfolio_trend.toUpperCase()}
Meilleur actif: ${memory.best_performer} | Moins bon: ${memory.worst_performer}
Total trades 30j: ${memory.total_trades_30d} | Taille moyenne: ${memory.avg_trade_size_eur.toFixed(0)}€

DERNIERS TRADES:
${recentTradesSummary || '  Aucun trade récent'}

PERFORMANCES PAR ACTIF:
${perfSummary || '  Aucune donnée'}

LEÇONS APPRISES:
${lessonsSummary}`;
}
