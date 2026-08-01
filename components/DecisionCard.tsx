'use client';

import { TrendingUp, TrendingDown, Minus, Brain, Clock, AlertTriangle } from 'lucide-react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

interface Decision {
  id: number;
  symbol: string;
  action: string;
  reasoning: string;
  confidence: number;
  risk_score: number;
  model_used: string;
  decided_at: string;
  market_data?: {
    price_eur?: number;
    change_24h?: number;
    fear_greed?: number;
  };
}

interface Props {
  decision: Decision;
}

export default function DecisionCard({ decision }: Props) {
  const actionConfig = {
    BUY: {
      icon: TrendingUp,
      color: 'text-green-400',
      bg: 'bg-green-400/10 border-green-400/30',
      label: 'ACHAT',
    },
    SELL: {
      icon: TrendingDown,
      color: 'text-red-400',
      bg: 'bg-red-400/10 border-red-400/30',
      label: 'VENTE',
    },
    HOLD: {
      icon: Minus,
      color: 'text-yellow-400',
      bg: 'bg-yellow-400/10 border-yellow-400/30',
      label: 'HOLD',
    },
    SKIP: {
      icon: Minus,
      color: 'text-gray-400',
      bg: 'bg-gray-400/10 border-gray-400/30',
      label: 'SKIP',
    },
  };

  const config = actionConfig[decision.action as keyof typeof actionConfig] ?? actionConfig.HOLD;
  const Icon = config.icon;

  const confidenceColor =
    decision.confidence >= 75
      ? 'text-green-400'
      : decision.confidence >= 60
      ? 'text-yellow-400'
      : 'text-red-400';

  const riskColor =
    decision.risk_score <= 30
      ? 'text-green-400'
      : decision.risk_score <= 60
      ? 'text-yellow-400'
      : 'text-red-400';

  return (
    <div className={`border rounded-xl p-4 ${config.bg} hover:opacity-90`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={`p-1.5 rounded-lg bg-gray-900/50`}>
            <Icon className={`w-4 h-4 ${config.color}`} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-white font-bold text-sm">{decision.symbol}</span>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${config.bg} ${config.color}`}>
                {config.label}
              </span>
            </div>
            <div className="flex items-center gap-1 mt-0.5">
              <Clock className="w-3 h-3 text-gray-500" />
              <span className="text-gray-500 text-xs">
                {format(new Date(decision.decided_at), "d MMM 'à' HH:mm", { locale: fr })}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <div className="text-right">
            <div className={`font-semibold ${confidenceColor}`}>
              {decision.confidence}%
            </div>
            <div className="text-gray-500">confiance</div>
          </div>
          <div className="text-right">
            <div className={`font-semibold ${riskColor}`}>
              {decision.risk_score}/100
            </div>
            <div className="text-gray-500">risque</div>
          </div>
        </div>
      </div>

      {/* Market context */}
      {decision.market_data && (
        <div className="flex items-center gap-3 mb-2 text-xs text-gray-400">
          {decision.market_data.price_eur && (
            <span>Prix: <span className="text-gray-200">{decision.market_data.price_eur.toFixed(4)}€</span></span>
          )}
          {decision.market_data.change_24h !== undefined && (
            <span className={decision.market_data.change_24h >= 0 ? 'text-green-400' : 'text-red-400'}>
              {decision.market_data.change_24h >= 0 ? '+' : ''}{decision.market_data.change_24h.toFixed(2)}% (24h)
            </span>
          )}
          {decision.market_data.fear_greed !== undefined && (
            <span>F&G: <span className="text-gray-200">{decision.market_data.fear_greed}/100</span></span>
          )}
        </div>
      )}

      {/* Reasoning */}
      <div className="bg-gray-900/50 rounded-lg p-3 mt-2">
        <div className="flex items-center gap-1 mb-1">
          <Brain className="w-3 h-3 text-purple-400" />
          <span className="text-purple-400 text-xs font-medium">Raisonnement IA</span>
          <span className="text-gray-600 text-xs ml-auto">{decision.model_used}</span>
        </div>
        <p className="text-gray-300 text-xs leading-relaxed">{decision.reasoning}</p>
      </div>
    </div>
  );
}
