import { NextResponse } from 'next/server';
import { sqlForContext, getDbContext } from '@/lib/db';
import { computeFifo } from '@/lib/fifo';

type Row = Record<string, unknown>;
const num = (v: unknown): number => parseFloat(String(v ?? 0)) || 0;
const frNum = (v: number, decimals = 2): string =>
  v.toFixed(decimals).replace('.', ',');

// GET : export CSV des trades (compatible Excel FR : séparateur ";" + BOM).
// Colonne plus_value_realisee_eur (FIFO) pour les VENTE — base de déclaration.
// Contexte UAT/PROD via header x-db-context, env courant (paper/live).
export async function GET(request: Request) {
  try {
    const ctx = getDbContext(request);
    const db = sqlForContext(ctx);
    const modeRows = (await db`SELECT value FROM bot_config WHERE key = 'trading_mode'`) as Array<{ value: string }>;
    const env = modeRows[0]?.value === 'live' ? 'live' : 'paper';

    const trades = (await db`
      SELECT id, symbol, action, amount, price_eur, total_eur, fee_eur, executed_at
      FROM trades
      WHERE env = ${env} AND action IN ('BUY', 'SELL')
      ORDER BY executed_at ASC, id ASC
      LIMIT 5000
    `) as Row[];

    // P&L réalisé FIFO par trade (ordre chronologique = même ordre que l'export)
    const { perTradeRealized } = computeFifo(
      trades.map(t => ({
        symbol: String(t.symbol),
        action: String(t.action),
        amount: num(t.amount),
        total_eur: num(t.total_eur),
        fee_eur: num(t.fee_eur),
      }))
    );

    const header = 'date;symbole;action;quantite;prix_eur;total_eur;frais_eur;plus_value_realisee_eur;env';
    const lines = trades.map((t, i) => {
      const realized = perTradeRealized[i];
      return [
        new Date(String(t.executed_at)).toISOString(),
        String(t.symbol),
        String(t.action),
        frNum(num(t.amount), 8),
        frNum(num(t.price_eur), 4),
        frNum(num(t.total_eur)),
        frNum(num(t.fee_eur)),
        String(t.action) === 'SELL' ? frNum(realized ?? 0) : '',
        env,
      ].join(';');
    });

    const csv = '﻿' + [header, ...lines].join('\n');
    const stamp = new Date().toISOString().slice(0, 10);

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="trades-${ctx}-${env}-${stamp}.csv"`,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: 'Export failed', details: String(error) }, { status: 500 });
  }
}
