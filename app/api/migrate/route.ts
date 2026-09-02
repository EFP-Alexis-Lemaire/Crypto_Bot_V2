import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

/**
 * Safe migration — only adds missing config keys, never deletes data
 */
export async function GET() {
  try {
    const migrations: string[] = [];

    // Add trading_mode if missing
    const result = await sql`
      INSERT INTO bot_config (key, value)
      VALUES ('trading_mode', 'paper')
      ON CONFLICT (key) DO NOTHING
    `;
    migrations.push('trading_mode: paper (added if missing)');

    // Add any other new config keys that may be missing
    const newKeys = [
      { key: 'trading_mode', value: 'paper' },
    ];

    for (const { key, value } of newKeys) {
      await sql`
        INSERT INTO bot_config (key, value)
        VALUES (${key}, ${value})
        ON CONFLICT (key) DO NOTHING
      `;
    }

    // Return current config state
    const config = (await sql`SELECT key, value FROM bot_config ORDER BY key`) as Array<{ key: string; value: string }>;

    return NextResponse.json({
      success: true,
      migrations,
      current_config: Object.fromEntries(config.map(c => [c.key, c.value])),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
