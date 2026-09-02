'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Wallet, AlertTriangle } from 'lucide-react';

interface Balance {
  symbol: string;
  amount: number;
  price_eur: number | null;
  value_eur: number | null;
  source: 'kraken' | 'coinbase' | 'both';
}

interface ExchangeData {
  balances: Balance[];
  total_eur: number;
  cash_eur: number;
  crypto_eur: number;
  kraken_available: boolean;
  coinbase_available: boolean;
  error?: string;
}

const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  kraken:   { label: 'Kraken',   cls: 'bg-purple-500/15 text-purple-400 border border-purple-500/20' },
  coinbase: { label: 'Coinbase', cls: 'bg-blue-500/15 text-blue-400 border border-blue-500/20' },
  both:     { label: 'K + CB',   cls: 'bg-gray-700 text-gray-300 border border-gray-600' },
};

export default function ExchangeBalances() {
  const [data, setData] = useState<ExchangeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetch_ = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await fetch('/api/exchange-balances');
      if (res.ok) setData(await res.json());
    } catch {
      // silent
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetch_();
    const interval = setInterval(() => fetch_(), 60000);
    return () => clearInterval(interval);
  }, [fetch_]);

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 animate-pulse">
        <div className="h-4 bg-gray-800 rounded w-40 mb-4" />
        <div className="space-y-2">
          {[1, 2, 3].map(i => <div key={i} className="h-10 bg-gray-800 rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (!data || data.error) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <div className="flex items-center gap-2.5 mb-4">
          <div className="p-1.5 bg-gray-800 rounded-lg">
            <Wallet className="w-4 h-4 text-gray-400" />
          </div>
          <span className="text-white font-semibold text-sm">Actifs sur exchanges</span>
        </div>
        <div className="flex items-start gap-2.5 p-3.5 bg-yellow-500/10 border border-yellow-500/20 rounded-xl">
          <AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-yellow-300 text-sm font-medium">Clés API non configurées</p>
            <p className="text-gray-400 text-xs mt-1 leading-relaxed">
              {data?.error ?? 'Ajoute KRAKEN_API_KEY et COINBASE_API_KEY dans les variables d\'environnement Vercel pour voir tes actifs réels.'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 bg-gray-800 rounded-lg">
            <Wallet className="w-4 h-4 text-gray-400" />
          </div>
          <div>
            <span className="text-white font-semibold text-sm">Actifs sur exchanges</span>
            <div className="flex items-center gap-2 mt-0.5">
              {data.kraken_available && (
                <span className="text-xs text-purple-400">● Kraken</span>
              )}
              {data.coinbase_available && (
                <span className="text-xs text-blue-400">● Coinbase</span>
              )}
              {!data.kraken_available && (
                <span className="text-xs text-gray-600">○ Kraken non connecté</span>
              )}
              {!data.coinbase_available && (
                <span className="text-xs text-gray-600">○ Coinbase non connecté</span>
              )}
            </div>
          </div>
        </div>
        <button
          onClick={() => fetch_(true)}
          disabled={refreshing}
          className="p-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-400 hover:text-white transition-all disabled:opacity-40"
          title="Rafraîchir"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="p-5 space-y-4">
        {/* Summary KPIs */}
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-gray-800/50 rounded-xl p-3 text-center">
            <div className="text-gray-500 text-xs mb-1">Total</div>
            <div className="text-white font-bold">{data.total_eur.toFixed(2)}€</div>
          </div>
          <div className="bg-gray-800/50 rounded-xl p-3 text-center">
            <div className="text-gray-500 text-xs mb-1">Cash</div>
            <div className="text-yellow-400 font-bold">{data.cash_eur.toFixed(2)}€</div>
          </div>
          <div className="bg-gray-800/50 rounded-xl p-3 text-center">
            <div className="text-gray-500 text-xs mb-1">Crypto</div>
            <div className="text-blue-400 font-bold">{data.crypto_eur.toFixed(2)}€</div>
          </div>
        </div>

        {/* Balances list */}
        {data.balances.length === 0 ? (
          <div className="text-center py-6 text-gray-500 text-sm">
            Aucun actif trouvé sur les exchanges
          </div>
        ) : (
          <div className="space-y-2">
            {data.balances.map(b => {
              const badge = SOURCE_BADGE[b.source];
              const isEur = b.symbol === 'EUR' || b.symbol === 'USDC' || b.symbol === 'USDT' || b.symbol === 'USD';
              return (
                <div
                  key={b.symbol}
                  className="flex items-center justify-between py-2.5 px-3 bg-gray-800/40 hover:bg-gray-800/70 rounded-xl transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {/* Symbol circle */}
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${isEur ? 'bg-yellow-500/20 text-yellow-400' : 'bg-blue-500/20 text-blue-400'}`}>
                      {b.symbol.slice(0, 3)}
                    </div>
                    <div>
                      <div className="text-white text-sm font-medium">{b.symbol}</div>
                      <div className="text-gray-500 text-xs">
                        {b.price_eur !== null && !isEur
                          ? `${b.price_eur.toLocaleString('fr-FR', { maximumFractionDigits: 2 })}€`
                          : isEur ? 'Monnaie fiat' : 'Prix indisponible'}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <div className="text-white text-sm font-medium">
                        {b.value_eur !== null
                          ? `${b.value_eur.toFixed(2)}€`
                          : '—'}
                      </div>
                      <div className="text-gray-500 text-xs">
                        {b.amount < 0.0001
                          ? b.amount.toFixed(8)
                          : b.amount < 1
                          ? b.amount.toFixed(6)
                          : b.amount.toFixed(4)}{' '}
                        {b.symbol}
                      </div>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${badge.cls}`}>
                      {badge.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
