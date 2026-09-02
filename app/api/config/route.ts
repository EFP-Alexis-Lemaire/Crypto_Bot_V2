import { NextResponse } from 'next/server';
import { sqlForContext, getDbContext } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const ctx = getDbContext(request);
    const db = sqlForContext(ctx);
    const config = await db`SELECT * FROM bot_config ORDER BY key`;
    const configMap: Record<string, string> = {};
    (config as Array<{ key: string; value: string }>).forEach((c) => {
      configMap[c.key] = c.value;
    });
    return NextResponse.json({ config: configMap, ctx });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch config', details: String(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const ctx = getDbContext(request);
    const db = sqlForContext(ctx);
    const body = await request.json();
    const { key, value } = body;

    const allowedKeys = [
      'risk_level',
      'trading_mode',
      'max_trades_per_day',
      'max_position_size_pct',
      'stop_loss_pct',
      'take_profit_pct',
      'is_active',
      'initial_portfolio_eur',
    ];

    if (!allowedKeys.includes(key)) {
      return NextResponse.json({ error: 'Invalid config key' }, { status: 400 });
    }

    await db`
      INSERT INTO bot_config (key, value, updated_at)
      VALUES (${key}, ${value}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
    `;

    return NextResponse.json({ success: true, key, value, ctx });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to update config', details: String(error) },
      { status: 500 }
    );
  }
}
