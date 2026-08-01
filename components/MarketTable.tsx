'use client';

import { TrendingUp, TrendingDown } from 'lucide-react';
import { MarketData } from '@/lib/types';

interface Props {
  marketData: MarketData[];
}

export default function MarketTable({ marketData }: Props) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-500 border-b border-gray-800">
            <th className="text-left py-2 px-3">#</th>
            <th className="text-left py-2 px-3">Crypto</th>
            <th className="text-right py-2 px-3">Prix (EUR)</th>
            <th className="text-right py-2 px-3">24h</th>
            <th className="text-right py-2 px-3">7j</th>
            <th className="text-right py-2 px-3 hidden md:table-cell">Volume 24h</th>
            <th className="text-right py-2 px-3 hidden lg:table-cell">Mkt Cap Rank</th>
          </tr>
        </thead>
        <tbody>
          {marketData.map((coin, idx) => (
            <tr
              key={coin.symbol}
              className="border-b border-gray-800/50 hover:bg-gray-800/30"
            >
              <td className="py-2.5 px-3 text-gray-500">{idx + 1}</td>
              <td className="py-2.5 px-3">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-gradient-to-br from-gray-700 to-gray-600 flex items-center justify-center text-xs font-bold">
                    {coin.symbol.slice(0, 2)}
                  </div>
                  <div>
                    <div className="text-white font-medium">{coin.symbol}</div>
                    <div className="text-gray-500 text-xs">{coin.name}</div>
                  </div>
                </div>
              </td>
              <td className="py-2.5 px-3 text-right font-medium text-white">
                {coin.price_eur < 0.01
                  ? coin.price_eur.toFixed(6)
                  : coin.price_eur < 1
                  ? coin.price_eur.toFixed(4)
                  : coin.price_eur.toFixed(2)}
                €
              </td>
              <td className="py-2.5 px-3 text-right">
                <span
                  className={`flex items-center justify-end gap-0.5 ${
                    coin.change_24h >= 0 ? 'text-green-400' : 'text-red-400'
                  }`}
                >
                  {coin.change_24h >= 0 ? (
                    <TrendingUp className="w-3 h-3" />
                  ) : (
                    <TrendingDown className="w-3 h-3" />
                  )}
                  {coin.change_24h >= 0 ? '+' : ''}
                  {coin.change_24h.toFixed(2)}%
                </span>
              </td>
              <td className="py-2.5 px-3 text-right">
                <span
                  className={`${
                    coin.change_7d >= 0 ? 'text-green-400' : 'text-red-400'
                  }`}
                >
                  {coin.change_7d >= 0 ? '+' : ''}
                  {coin.change_7d.toFixed(2)}%
                </span>
              </td>
              <td className="py-2.5 px-3 text-right text-gray-400 hidden md:table-cell">
                {coin.volume_24h_usd >= 1e9
                  ? `${(coin.volume_24h_usd / 1e9).toFixed(1)}B$`
                  : `${(coin.volume_24h_usd / 1e6).toFixed(0)}M$`}
              </td>
              <td className="py-2.5 px-3 text-right text-gray-400 hidden lg:table-cell">
                #{coin.market_cap_rank}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
