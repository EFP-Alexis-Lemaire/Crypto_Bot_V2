'use client';

import { useState } from 'react';
import {
  Euro,
  ExternalLink,
  TrendingUp,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronUp,
  Landmark,
  Bot,
} from 'lucide-react';
import { PortfolioSummary } from '@/lib/types';

interface Trade {
  action: string;
  total_eur: number;
  price_eur: number;
  amount: number;
  fee_eur: number;
}

interface AICosts {
  total_usd: number;
  total_eur: number;
  total_tokens: number;
  calls_count: number;
  by_model: Array<{ model: string; calls: number; tokens: number; cost_usd: number; cost_eur: number }>;
  last_30_days_usd: number;
}

interface Props {
  portfolio: PortfolioSummary;
  trades: Trade[];
  initialInvestment?: number;
  aiCosts?: AICosts | null;
}

function TaxRow({ label, rate, gain, note, color }: {
  label: string;
  rate: number;
  gain: number;
  note: string;
  color: string;
}) {
  const tax = gain > 0 ? gain * rate : 0;
  const net = gain - tax;

  return (
    <div className={`p-3 rounded-xl border ${color}`}>
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <span className="text-white text-sm font-semibold">{label}</span>
        <span className="text-xs text-gray-400 font-mono">{(rate * 100).toFixed(0)}%</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-gray-500 mb-0.5">Impôt estimé</div>
          <div className="text-red-400 font-semibold">−{tax.toFixed(2)}€</div>
        </div>
        <div>
          <div className="text-gray-500 mb-0.5">Net après impôt</div>
          <div className="text-green-400 font-semibold">{net.toFixed(2)}€</div>
        </div>
        <div>
          <div className="text-gray-500 mb-0.5">Gain brut</div>
          <div className="text-white font-semibold">+{gain.toFixed(2)}€</div>
        </div>
      </div>
      <p className="text-gray-500 text-xs mt-2 leading-relaxed">{note}</p>
    </div>
  );
}

export default function CashoutPanel({ portfolio, trades, initialInvestment = 5000, aiCosts }: Props) {
  const [showTaxDetails, setShowTaxDetails] = useState(false);

  // Calculate realized PnL from closed trades
  let realizedPnl = 0;
  let totalFees = 0;

  const sellTrades = trades.filter(t => t.action === 'SELL');
  const buyTrades = trades.filter(t => t.action === 'BUY');

  sellTrades.forEach(sell => {
    realizedPnl += parseFloat(String(sell.total_eur));
    totalFees += parseFloat(String(sell.fee_eur ?? 0));
  });
  buyTrades.forEach(buy => {
    realizedPnl -= parseFloat(String(buy.total_eur));
    totalFees += parseFloat(String(buy.fee_eur ?? 0));
  });

  // Unrealized PnL = open positions
  const unrealizedPnl = portfolio.crypto_value_eur > 0
    ? portfolio.holdings.reduce((acc, h) => acc + h.pnl_eur, 0)
    : 0;

  const totalPnl = portfolio.pnl_eur;
  const totalPortfolioValue = portfolio.total_value_eur;
  const profitPct = ((totalPortfolioValue - initialInvestment) / initialInvestment) * 100;

  // Withdrawal recommendations
  const getRecommendation = () => {
    if (profitPct < 5) return null;
    if (profitPct >= 5 && profitPct < 15) return {
      label: 'Objectif intermédiaire atteint',
      text: 'Tu es en profit. Pas encore nécessaire de retirer, mais tu peux sécuriser ta mise initiale si tu veux être "risque zéro".',
      color: 'text-yellow-400',
      bg: 'bg-yellow-500/10 border-yellow-500/20',
    };
    if (profitPct >= 15 && profitPct < 30) return {
      label: '+15% atteint — Envisage un retrait partiel',
      text: `Tu pourrais retirer ~${(initialInvestment * 0.3).toFixed(0)}€ (30% de la mise) et laisser le reste travailler. Tu sécurises des gains réels tout en restant exposé.`,
      color: 'text-green-400',
      bg: 'bg-green-500/10 border-green-500/20',
    };
    if (profitPct >= 30) return {
      label: '+30% — Sécurise ta mise initiale',
      text: `Excellent résultat. Recommandation: retire au moins ${initialInvestment.toFixed(0)}€ (ta mise de départ) pour être à risque zéro. Le reste est du profit pur.`,
      color: 'text-emerald-400',
      bg: 'bg-emerald-500/10 border-emerald-500/20',
    };
    return null;
  };

  const recommendation = getRecommendation();

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-5 py-4 border-b border-gray-800">
        <div className="p-1.5 bg-gray-800 rounded-lg">
          <Landmark className="w-4 h-4 text-gray-400" />
        </div>
        <span className="text-white font-semibold text-sm">Cashout & Fiscalité 🇧🇪</span>
      </div>

      <div className="p-5 space-y-5">

        {/* Portfolio summary for cashout */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-gray-800/50 rounded-xl p-3">
            <div className="text-gray-500 text-xs mb-1">Valeur totale</div>
            <div className="text-white text-xl font-bold">{totalPortfolioValue.toFixed(2)}€</div>
            <div className={`text-xs mt-0.5 font-medium ${profitPct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {profitPct >= 0 ? '+' : ''}{profitPct.toFixed(2)}% depuis le départ
            </div>
          </div>

          <div className="bg-gray-800/50 rounded-xl p-3">
            <div className="text-gray-500 text-xs mb-1">Profit total</div>
            <div className={`text-xl font-bold ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}€
            </div>
            <div className="text-gray-600 text-xs mt-0.5">
              Frais payés: {totalFees.toFixed(2)}€
            </div>
          </div>

          <div className="bg-gray-800/50 rounded-xl p-3">
            <div className="text-gray-500 text-xs mb-1 flex items-center gap-1">
              <TrendingUp className="w-3 h-3" /> P&L réalisé
            </div>
            <div className={`text-lg font-bold ${realizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {realizedPnl >= 0 ? '+' : ''}{realizedPnl.toFixed(2)}€
            </div>
            <div className="text-gray-600 text-xs mt-0.5">Trades fermés</div>
          </div>

          <div className="bg-gray-800/50 rounded-xl p-3">
            <div className="text-gray-500 text-xs mb-1 flex items-center gap-1">
              <TrendingUp className="w-3 h-3" /> P&L latent
            </div>
            <div className={`text-lg font-bold ${unrealizedPnl >= 0 ? 'text-blue-400' : 'text-orange-400'}`}>
              {unrealizedPnl >= 0 ? '+' : ''}{unrealizedPnl.toFixed(2)}€
            </div>
            <div className="text-gray-600 text-xs mt-0.5">Positions ouvertes</div>
          </div>
        </div>

        {/* AI Costs */}
        {aiCosts && (
          <div className="bg-gray-800/40 border border-gray-700/50 rounded-xl p-3.5">
            <div className="flex items-center gap-2 mb-2.5">
              <Bot className="w-4 h-4 text-purple-400" />
              <span className="text-gray-300 text-sm font-semibold">Frais IA (OpenAI)</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs mb-2.5">
              <div>
                <div className="text-gray-500 mb-0.5">Total dépensé</div>
                <div className="text-white font-bold">${aiCosts.total_usd.toFixed(4)}</div>
                <div className="text-gray-600">{aiCosts.total_eur.toFixed(4)}€</div>
              </div>
              <div>
                <div className="text-gray-500 mb-0.5">30 derniers jours</div>
                <div className="text-purple-400 font-bold">${aiCosts.last_30_days_usd.toFixed(4)}</div>
              </div>
              <div>
                <div className="text-gray-500 mb-0.5">Nb appels</div>
                <div className="text-white font-bold">{aiCosts.calls_count}</div>
                <div className="text-gray-600">{(aiCosts.total_tokens / 1000).toFixed(0)}k tokens</div>
              </div>
            </div>
            {aiCosts.by_model.length > 0 && (
              <div className="space-y-1">
                {aiCosts.by_model.map(m => (
                  <div key={m.model} className="flex items-center justify-between text-xs">
                    <span className="text-gray-500 font-mono">{m.model}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-gray-600">{m.calls} appels</span>
                      <span className="text-gray-400 font-medium">${m.cost_usd.toFixed(4)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Recommendation */}        {recommendation && (
          <div className={`p-3.5 rounded-xl border ${recommendation.bg}`}>
            <div className={`text-sm font-semibold mb-1 ${recommendation.color}`}>
              💡 {recommendation.label}
            </div>
            <p className="text-gray-300 text-xs leading-relaxed">{recommendation.text}</p>
          </div>
        )}

        {/* Tax section */}
        <div>
          <button
            onClick={() => setShowTaxDetails(!showTaxDetails)}
            className="w-full flex items-center justify-between text-sm font-semibold text-gray-300 hover:text-white transition-colors"
          >
            <span className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-yellow-400" />
              Estimation fiscale Belgique
            </span>
            {showTaxDetails ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {showTaxDetails && totalPnl > 0 && (
            <div className="mt-3 space-y-2.5">
              <TaxRow
                label="Gestion spéculative (trading bot)"
                rate={0.33}
                gain={totalPnl}
                note="Probable si tu utilises un bot actif. 33% sur les plus-values + cotisations sociales possibles. Consulte un comptable."
                color="bg-orange-500/10 border-orange-500/20"
              />
              <TaxRow
                label="Bon père de famille (investissement passif)"
                rate={0}
                gain={totalPnl}
                note="0% si tu peux prouver une gestion prudente et long terme. Difficile à justifier avec un bot de trading actif."
                color="bg-green-500/10 border-green-500/20"
              />

              <div className="flex items-start gap-2 p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl">
                <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
                <p className="text-gray-400 text-xs leading-relaxed">
                  La fiscalité crypto en Belgique est complexe et dépend de ta situation personnelle.
                  Ces estimations sont indicatives. Consulte un comptable spécialisé avant tout retrait important.
                  <a href="https://finances.belgium.be" target="_blank" rel="noopener noreferrer"
                    className="text-blue-400 ml-1 hover:underline">finances.belgium.be</a>
                </p>
              </div>
            </div>
          )}

          {showTaxDetails && totalPnl <= 0 && (
            <div className="mt-3 p-3 bg-gray-800/50 rounded-xl border border-gray-700">
              <p className="text-gray-500 text-xs">Pas de plus-value à déclarer pour l&apos;instant.</p>
            </div>
          )}
        </div>

        {/* Withdrawal links */}
        <div>
          <p className="text-gray-500 text-xs font-medium uppercase tracking-wider mb-2.5">
            Retirer vers ta banque
          </p>
          <div className="grid grid-cols-2 gap-2">
            <a
              href="https://www.kraken.com/u/funding/withdraw"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 py-2.5 px-3 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 hover:border-purple-500/40 rounded-xl text-purple-400 text-sm font-medium transition-all"
            >
              <Euro className="w-4 h-4" />
              Retirer Kraken
              <ExternalLink className="w-3 h-3 opacity-60" />
            </a>
            <a
              href="https://www.coinbase.com/assets"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 py-2.5 px-3 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 hover:border-blue-500/40 rounded-xl text-blue-400 text-sm font-medium transition-all"
            >
              <Euro className="w-4 h-4" />
              Retirer Coinbase
              <ExternalLink className="w-3 h-3 opacity-60" />
            </a>
          </div>
          <p className="text-gray-600 text-xs mt-2 text-center">
            Délai SEPA : 1-3 jours ouvrés · Frais Kraken ~0.09€ · Coinbase ~0.15€
          </p>
        </div>

      </div>
    </div>
  );
}
