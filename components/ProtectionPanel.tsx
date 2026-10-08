'use client';

import { ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react';

export interface ProtectionStatus {
  symbol: string;
  change_pct: number;
  stop_dyn_pct: number;
  dist_to_stop_pts: number;
  take_profit_pct: number;
  partial_taken: boolean;
  trailing_high_eur: number | null;
  trailing_dd_pts: number | null;
  status: 'stop-hit' | 'near-stop' | 'armed';
}

interface Props {
  positions: ProtectionStatus[];
}

const STATUS_META: Record<ProtectionStatus['status'], { label: string; cls: string; Icon: typeof ShieldCheck }> = {
  'stop-hit': { label: 'STOP TOUCHÉ', cls: 'bg-red-500/15 text-red-400 border-red-500/30', Icon: ShieldX },
  'near-stop': { label: 'PROCHE', cls: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30', Icon: ShieldAlert },
  armed: { label: 'ARMÉ', cls: 'bg-green-500/15 text-green-400 border-green-500/30', Icon: ShieldCheck },
};

export default function ProtectionPanel({ positions }: Props) {
  if (positions.length === 0) return null;
  const hits = positions.filter(p => p.status === 'stop-hit').length;
  const near = positions.filter(p => p.status === 'near-stop').length;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <h3 className="text-white font-semibold flex items-center gap-2 text-sm">
          <ShieldCheck className="w-4 h-4 text-green-400" />
          Protections (stops armés ?)
        </h3>
        <span className="text-xs text-gray-500">
          {hits > 0 ? (
            <span className="text-red-400 font-semibold">{hits} stop{hits > 1 ? 's' : ''} touché{hits > 1 ? 's' : ''} → vente au prochain passage</span>
          ) : near > 0 ? (
            <span className="text-yellow-400">{near} position{near > 1 ? 's' : ''} proche du stop</span>
          ) : (
            <span className="text-green-400">Tous les stops sont armés</span>
          )}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 border-b border-gray-800 text-xs">
              <th className="text-left py-2.5 px-4">Crypto</th>
              <th className="text-right py-2.5 px-4">P&L</th>
              <th className="text-right py-2.5 px-4">Stop dyn</th>
              <th className="text-right py-2.5 px-4">Marge</th>
              <th className="text-right py-2.5 px-4 hidden sm:table-cell">TP / Suivi</th>
              <th className="text-right py-2.5 px-4">État</th>
            </tr>
          </thead>
          <tbody>
            {positions.map(p => {
              const meta = STATUS_META[p.status];
              const Icon = meta.Icon;
              return (
                <tr key={p.symbol} className="border-b border-gray-800/50">
                  <td className="py-2.5 px-4 font-medium text-white">{p.symbol}</td>
                  <td className={`py-2.5 px-4 text-right font-medium ${p.change_pct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {p.change_pct >= 0 ? '+' : ''}{p.change_pct.toFixed(2)}%
                  </td>
                  <td className="py-2.5 px-4 text-right text-gray-300">−{p.stop_dyn_pct.toFixed(1)}%</td>
                  <td className={`py-2.5 px-4 text-right font-medium ${p.dist_to_stop_pts <= 0 ? 'text-red-400' : p.status === 'near-stop' ? 'text-yellow-400' : 'text-gray-300'}`}>
                    {p.dist_to_stop_pts <= 0 ? 'touché' : `+${p.dist_to_stop_pts.toFixed(1)}pts`}
                  </td>
                  <td className="py-2.5 px-4 text-right text-gray-400 text-xs hidden sm:table-cell">
                    TP +{p.take_profit_pct}%{p.partial_taken ? ' · 50% pris' : ''}
                    {p.trailing_dd_pts !== null && p.trailing_high_eur !== null ? ` · trail ${p.trailing_dd_pts.toFixed(1)}%` : ''}
                  </td>
                  <td className="py-2.5 px-4 text-right">
                    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${meta.cls}`}>
                      <Icon className="w-3 h-3" />
                      {meta.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-gray-600 text-xs px-4 py-2.5">
        Même moteur que l'exécution : un stop « touché » sera vendu au prochain cycle ou guardian.
      </p>
    </div>
  );
}
