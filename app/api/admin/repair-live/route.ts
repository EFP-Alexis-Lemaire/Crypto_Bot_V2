import { NextResponse } from 'next/server';
import { sqlForContext } from '@/lib/db';
import { getMarketData, WATCHLIST_COINS } from '@/lib/market-data';
import { getPortfolioSummary } from '@/lib/portfolio';
import {
  getConsolidatedBalance,
  syncPortfolioFromExchange,
} from '@/lib/exchanges/live-trader';

type Row = Record<string, unknown>;
const num = (v: unknown): number => parseFloat(String(v ?? 0)) || 0;

// DB cible : ?ctx=prod (défaut prod ici car outil de réparation prod),
// sinon header x-db-context.
function targetCtx(request: Request): 'prod' | 'uat' {
  const url = new URL(request.url);
  const q = url.searchParams.get('ctx') ?? url.searchParams.get('db');
  if (q === 'uat' || q === 'prod') return q;
  const h = request.headers.get('x-db-context');
  if (h === 'uat' || h === 'prod') return h;
  return 'prod';
}

function authorized(request: Request, bodySecret?: unknown, allowQuerySecret = false): boolean {
  const secret = process.env.CRON_SECRET;
  const isProd =
    process.env.VERCEL_ENV === 'production' ||
    process.env.APP_ENV === 'production';
  if (!secret) return !isProd; // dev local ouvert, prod fermée
  if (request.headers.get('authorization')?.trim() === `Bearer ${secret}`) return true;
  if (typeof bodySecret === 'string' && bodySecret === secret) return true;
  if (allowQuerySecret) {
    if (new URL(request.url).searchParams.get('secret') === secret) return true;
  }
  return false;
}

interface TradeRow {
  id: number;
  symbol: string;
  action: string;
  amount: number;
  total_eur: number;
}

// Reconstitue (quantité, avg) par symbole depuis l'historique des trades live :
// BUY -> qty += amount, cost += total_eur (montant réellement débité, frais inclus)
// SELL -> qty -= vendu, cost réduit au prorata de l'avg courant
function rebuildFromTrades(trades: TradeRow[]): Record<string, { qty: number; avg: number }> {
  const acc: Record<string, { qty: number; cost: number }> = {};
  for (const t of trades) {
    if (!acc[t.symbol]) acc[t.symbol] = { qty: 0, cost: 0 };
    const a = acc[t.symbol];
    if (t.action === 'BUY') {
      a.qty += t.amount;
      a.cost += t.total_eur;
    } else if (t.action === 'SELL' && a.qty > 0.000001) {
      const avg = a.cost / a.qty;
      const sold = Math.min(t.amount, a.qty);
      a.qty -= sold;
      a.cost = avg * a.qty;
      if (a.qty <= 0.000001) { a.qty = 0; a.cost = 0; }
    }
  }
  const out: Record<string, { qty: number; avg: number }> = {};
  for (const [sym, a] of Object.entries(acc)) {
    out[sym] = { qty: a.qty, avg: a.qty > 0.000001 ? a.cost / a.qty : 0 };
  }
  return out;
}

function parseFlag(v: string | null, def: boolean): boolean {
  if (v === null || v === undefined) return def;
  return v === '1' || v.toLowerCase() === 'true';
}

// GET = diagnostic read-only, SAUF si ?run=repair (réparation exécutable
// directement depuis le navigateur, protégée par le même secret)
export async function GET(request: Request) {
  if (!authorized(request, undefined, true)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const ctx = targetCtx(request);
  const db = sqlForContext(ctx);

  const q = new URL(request.url).searchParams;
  if (q.get('run') === 'repair') {
    const report = await runRepair(db, ctx, {
      doResync: parseFlag(q.get('resync'), true),
      doFixAvg: parseFlag(q.get('fix_avg'), true),
      doDeleteSnaps: parseFlag(q.get('delete_snapshots'), false),
      initialEur: q.get('initial_eur') !== null ? Number(q.get('initial_eur')) : null,
    });
    return NextResponse.json({ ctx, via: 'GET', ...report });
  }

  const configRows = (await db`SELECT key, value FROM bot_config`) as Row[];
  const config: Record<string, string> = {};
  configRows.forEach(c => { config[String(c.key)] = String(c.value); });

  const marketData = await getMarketData(WATCHLIST_COINS);
  const portfolio = await getPortfolioSummary(marketData, 'live', ctx);
  const balances = await getConsolidatedBalance();

  const trades = (await db`
    SELECT id, symbol, action, amount, total_eur, price_eur, executed_at
    FROM trades WHERE env = 'live' ORDER BY executed_at ASC, id ASC
  `) as Array<Row & { executed_at: string; price_eur: unknown }>;
  const rebuilt = rebuildFromTrades(
    trades.map(t => ({ id: Number(t.id), symbol: String(t.symbol), action: String(t.action), amount: num(t.amount), total_eur: num(t.total_eur) }))
  );

  const snapStats = (await db`
    SELECT COUNT(*) AS n, MIN(total_value_eur) AS min_total, MAX(total_value_eur) AS max_total
    FROM portfolio_snapshots WHERE env = 'live'
  `) as Row[];
  const lastSnaps = (await db`
    SELECT total_value_eur, cash_eur, crypto_value_eur, pnl_eur, snapshotted_at
    FROM portfolio_snapshots WHERE env = 'live'
    ORDER BY snapshotted_at DESC LIMIT 5
  `) as Row[];

  const initial = parseFloat(config.initial_portfolio_eur ?? 'NaN');

  const holdings = portfolio.holdings.map(h => {
    const rb = rebuilt[h.symbol];
    return {
      symbol: h.symbol,
      amount_db: h.amount,
      avg_db: h.avg_buy_price_eur,
      current_price: h.current_price_eur,
      value_eur: h.current_value_eur,
      pnl_db: { eur: h.pnl_eur, pct: h.pnl_percent },
      avg_rebuilt_from_trades: rb ? Number(rb.avg.toFixed(6)) : null,
      qty_rebuilt_from_trades: rb ? Number(rb.qty.toFixed(8)) : null,
      problem: h.avg_buy_price_eur <= 0 && h.current_value_eur >= 5
        ? 'AVG_MANQUANT: prix moyen à 0 -> P&L faux + stop-loss/take-profit inopérants'
        : Math.abs(h.amount - (rb?.qty ?? h.amount)) > Math.max(h.amount * 0.05, 0.0001) && (rb?.qty ?? 0) > 0.000001
          ? 'ECART_QUANTITE: la DB ne correspond pas à l\'historique des trades (dépôt/retrait hors bot probable)'
          : null,
    };
  });

  return NextResponse.json({
    ctx,
    readonly: true,
    config_probe: {
      initial_portfolio_eur: config.initial_portfolio_eur ?? null,
      initial_ok: initial === 1000,
      initial_hint: 'Devrait être 1000 (= 500 Kraken + 500 Coinbase réellement déposés)',
      trading_mode: config.trading_mode ?? null,
    },
    live_summary: {
      total_value_eur: Number(portfolio.total_value_eur.toFixed(2)),
      cash_eur: Number(portfolio.cash_eur.toFixed(2)),
      cash_by_exchange: portfolio.cash_by_exchange ?? null,
      crypto_value_eur: Number(portfolio.crypto_value_eur.toFixed(2)),
      pnl_eur: Number(portfolio.pnl_eur.toFixed(2)),
    },
    exchange_balances: {
      kraken: balances.kraken,
      coinbase: balances.coinbase,
    },
    trades_live_count: trades.length,
    holdings,
    snapshots_live: {
      count: Number((snapStats[0]?.n as string | number) ?? 0),
      min_total: snapStats[0]?.min_total,
      max_total: snapStats[0]?.max_total,
      last_5: lastSnaps,
      hint: 'Le graphique utilise total_value_eur + initial_portfolio_eur. Des snapshots pris avec un cash incomplet (ex: Coinbase non compté) faussent tout l\'historique.',
    },
    plan: 'POST même URL avec {"initial_eur":1000,"fix_avg":true,"resync":true,"delete_snapshots":true} (+ auth) pour réparer.',
  });
}

async function runRepair(
  db: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>,
  ctx: 'prod' | 'uat',
  opts: { doResync: boolean; doFixAvg: boolean; doDeleteSnaps: boolean; initialEur: number | null }
): Promise<Record<string, unknown>> {
  const { doResync, doFixAvg, doDeleteSnaps, initialEur } = opts;
  const report: Record<string, unknown> = {};

  // 1. Resync montants depuis les exchanges (source de vérité)
  if (doResync) {
    await syncPortfolioFromExchange('both');
    report.resync = 'OK: montants resynchronisés depuis Kraken + Coinbase';
  }

  // 2. Recalcule les prix moyens depuis l'historique des trades
  if (doFixAvg) {
    const trades = (await db`
      SELECT id, symbol, action, amount, total_eur
      FROM trades WHERE env = 'live' ORDER BY executed_at ASC, id ASC
    `) as Row[];
    const rebuilt = rebuildFromTrades(
      trades.map(t => ({ id: Number(t.id), symbol: String(t.symbol), action: String(t.action), amount: num(t.amount), total_eur: num(t.total_eur) }))
    );
    const avgReport: Record<string, unknown> = {};
    for (const [symbol, rb] of Object.entries(rebuilt)) {
      if (rb.qty <= 0.000001 || rb.avg <= 0) {
        avgReport[symbol] = 'SKIP: plus de quantité dans l\'historique des trades';
        continue;
      }
      const existing = (await db`SELECT amount FROM portfolio WHERE symbol = ${symbol} AND env = 'live'`) as Row[];
      if (existing.length === 0 || num(existing[0].amount) <= 0.000001) {
        avgReport[symbol] = 'SKIP: position absente de la DB (vendue)';
        continue;
      }
      await db`UPDATE portfolio SET avg_buy_price_eur = ${rb.avg}, updated_at = NOW() WHERE symbol = ${symbol} AND env = 'live'`;
      avgReport[symbol] = { new_avg_eur: Number(rb.avg.toFixed(6)), qty_trades: Number(rb.qty.toFixed(8)), qty_db: num(existing[0].amount) };
    }
    report.avg_fix = avgReport;
  }

  // 3. Mise initiale réelle (500 Kraken + 500 Coinbase = 1000)
  if (initialEur !== null && Number.isFinite(initialEur) && initialEur > 0) {
    await db`
      INSERT INTO bot_config (key, value, updated_at)
      VALUES ('initial_portfolio_eur', ${String(initialEur)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = ${String(initialEur)}, updated_at = NOW()
    `;
    report.initial = `OK: initial_portfolio_eur = ${initialEur}`;
  }

  // 4. Snapshots corrompus (optionnel) : le graphique repart propre
  if (doDeleteSnaps) {
    const del = (await db`DELETE FROM portfolio_snapshots WHERE env = 'live'`) as Row[];
    report.snapshots = `OK: snapshots live supprimés (${JSON.stringify(del)}) — le graphique repart de "Départ"`;
  }

  // 5. État final
  const marketData = await getMarketData(WATCHLIST_COINS);
  const portfolio = await getPortfolioSummary(marketData, 'live', ctx);
  report.final = {
    total_value_eur: Number(portfolio.total_value_eur.toFixed(2)),
    cash_eur: Number(portfolio.cash_eur.toFixed(2)),
    cash_by_exchange: portfolio.cash_by_exchange ?? null,
    crypto_value_eur: Number(portfolio.crypto_value_eur.toFixed(2)),
    pnl_eur: Number(portfolio.pnl_eur.toFixed(2)),
    holdings: portfolio.holdings.map(h => ({
      symbol: h.symbol,
      amount: h.amount,
      avg_buy_price_eur: Number(h.avg_buy_price_eur.toFixed(6)),
      current_price_eur: Number(h.current_price_eur.toFixed(4)),
      value_eur: Number(h.current_value_eur.toFixed(2)),
      pnl_eur: Number(h.pnl_eur.toFixed(2)),
      pnl_pct: Number(h.pnl_percent.toFixed(2)),
    })),
  };

  return report;
}

// POST = réparation (écritures). Auth via header Bearer ou body.secret.
export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { /* body vide */ }
  if (!authorized(request, body.secret, false)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const ctx = targetCtx(request);
  const db = sqlForContext(ctx);
  const report = await runRepair(db, ctx, {
    doResync: body.resync !== false,
    doFixAvg: body.fix_avg !== false,
    doDeleteSnaps: body.delete_snapshots === true,
    initialEur: body.initial_eur !== undefined ? Number(body.initial_eur) : null,
  });
  return NextResponse.json({ ctx, via: 'POST', ...report });
}
