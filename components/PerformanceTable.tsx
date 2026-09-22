'use client';

import { Trophy, TrendingUp, TrendingDown } from 'lucide-react';

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

interface Props {
  rows: SymbolPerformance[];
  totals: { realized_eur: number; unrealized_eur: number; fees_eur: number } | null;
}

function eur(v: number, signed = true) {
  const sign = signed && v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}€`;
}

export default function PerformanceTable({ rows, totals }: Props) {
  // Poussières (< 1€, sans trades ni P&L) masquées par défaut pour garder le focus
  const significant = rows.filter(r => Math.abs(r.total_eur) >= 0.01 || r.buys > 0 || r.sells > 0 || r.holding_value_eur >= 5);
  const dustCount = rows.length - significant.length;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <h3 className="text-white font-semibold flex items-center gap-2 text-sm">
          <Trophy className="w-4 h-4 text-yellow-400" />
          Performances par crypto
        </h3>
        {totals && (
          <div className="flex items-center gap-3 text-xs">
            <span className="text-gray-500">
              Réalisé : <span className={totals.realized_eur >= 0 ? 'text-green-400' : 'text-red-400'}>{eur(totals.realized_eur)}</span>
            </span>
            <span className="text-gray-500">
              Latent : <span className={totals.unrealized_eur >= 0 ? 'text-green-400' : 'text-red-400'}>{eur(totals.unrealized_eur)}</span>
            </span>
            <span className="text-gray-600">Frais : {totals.fees_eur.toFixed(2)}€</span>
          </div>
        )}
      </div>

      {significant.length === 0 ? (
        <p className="text-center py-8 text-gray-500 text-sm">Aucun trade pour l'instant — les performances apparaîtront ici.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800 text-xs">
                <th className="text-left py-2.5 px-4">#</th>
                <th className="text-left py-2.5 px-4">Crypto</th>
                <th className="text-right py-2.5 px-4">Trades</th>
                <th className="text-right py-2.5 px-4">Réalisé</th>
                <th className="text-right py-2.5 px-4">Latent</th>
                <th className="text-right py-2.5 px-4">Total</th>
                <th className="text-right py-2.5 px-4 hidden md:table-cell">Position</th>
              </tr>
            </thead>
            <tbody>
              {significant.map((r, i) => {
                const isTop = i === 0 && r.total_eur > 0;
                const isFlop = i === significant.length - 1 && significant.length > 1 && r.total_eur < 0;
                return (
                  <tr key={r.symbol} className={`border-b border-gray-800/50 ${isTop ? 'bg-green-500/5' : isFlop ? 'bg-red-500/5' : ''}`}>
                    <td className="py-2.5 px-4 text-gray-500 text-xs w-8">
                      {isTop ? <TrendingUp className="w-4 h-4 text-green-400" /> : isFlop ? <TrendingDown className="w-4 h-4 text-red-400" /> : i + 1}
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="font-medium text-white">{r.symbol}</div>
                      <div className="text-gray-500 text-xs">{r.buys} achat{r.buys > 1 ? 's' : ''}{r.sells > 0 ? ` · ${r.sells} vente${r.sells > 1 ? 's' : ''}` : ''}</div>
                    </td>
                    <td className="py-2.5 px-4 text-right text-gray-300">{r.buys + r.sells}</td>
                    <td className={`py-2.5 px-4 text-right font-medium ${r.realized_eur >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {eur(r.realized_eur)}
                    </td>
                    <td className={`py-2.5 px-4 text-right font-medium ${r.unrealized_eur >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {eur(r.unrealized_eur)}
                    </td>
                    <td className={`py-2.5 px-4 text-right font-bold ${r.total_eur >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {eur(r.total_eur)}
                    </td>
                    <td className="py-2.5 px-4 text-right text-gray-300 hidden md:table-cell">
                      {r.holding_value_eur >= 0.01 ? `${r.holding_value_eur.toFixed(2)}€` : <span className="text-gray-600">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {dustCount > 0 && (
            <p className="text-gray-600 text-xs px-4 py-2.5">{dustCount} poussière{dustCount > 1 ? 's' : ''} (&lt; 1€) masquée{dustCount > 1 ? 's' : ''}</p>
          )}
        </div>
      )}
    </div>
  );
}
