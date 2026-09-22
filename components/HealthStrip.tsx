'use client';

interface Check {
  ok: boolean;
  ms: number;
  detail?: string;
}

interface Props {
  health: {
    kraken?: Check;
    coinbase?: Check;
    coingecko?: Check;
    db?: Check;
    openai_configured?: boolean;
    trading_mode?: string;
    last_cycle_at?: string | null;
    last_trade_at?: string | null;
  } | null;
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'jamais';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `il y a ${s}s`;
  if (s < 3600) return `il y a ${Math.floor(s / 60)}min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)}h`;
  return `il y a ${Math.floor(s / 86400)}j`;
}

export default function HealthStrip({ health }: Props) {
  if (!health) return null;
  const dots: Array<{ label: string; ok: boolean; title?: string }> = [
    { label: 'Kraken', ok: health.kraken?.ok ?? false, title: health.kraken?.detail },
    { label: 'Coinbase', ok: health.coinbase?.ok ?? false, title: health.coinbase?.detail },
    { label: 'CoinGecko', ok: health.coingecko?.ok ?? false, title: health.coingecko?.detail },
    { label: 'DB', ok: health.db?.ok ?? false },
    { label: 'OpenAI', ok: health.openai_configured ?? false },
  ];
  return (
    <div className="flex items-center gap-3 flex-wrap bg-gray-900 border border-gray-800 rounded-xl px-4 py-2.5 text-xs">
      {dots.map(d => (
        <span key={d.label} title={d.title ?? (d.ok ? 'OK' : 'HS')} className="flex items-center gap-1.5 text-gray-400">
          <span className={`w-2 h-2 rounded-full ${d.ok ? 'bg-green-400' : 'bg-red-400'}`} />
          {d.label}
        </span>
      ))}
      <span className="text-gray-600 ml-auto">
        Dernier cycle {timeAgo(health.last_cycle_at)}
        {health.last_trade_at ? ` · dernier trade ${timeAgo(health.last_trade_at)}` : ''}
      </span>
    </div>
  );
}
