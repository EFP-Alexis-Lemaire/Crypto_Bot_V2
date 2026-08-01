'use client';

import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  TrendingUp,
  TrendingDown,
  Minus,
  Brain,
  Clock,
  CheckCircle,
  Activity,
} from 'lucide-react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

interface Decision {
  symbol: string;
  action: string;
  reasoning: string;
  confidence: number;
  risk_score: number;
  model_used: string;
  market_data?: { price_eur?: number; change_24h?: number; fear_greed?: number };
  news_summary?: string;
  decided_at: string;
}

interface Cycle {
  cycle_id: string;
  started_at: string;
  total_decisions: number;
  buys: number;
  sells: number;
  holds: number;
  skips: number;
  model_used: string;
  decisions: Decision[];
}

interface Props {
  cycles: Cycle[];
}

function ActionBadge({ action }: { action: string }) {
  const config: Record<string, { label: string; className: string; icon: React.ElementType }> = {
    BUY:  { label: 'ACHAT',  className: 'bg-green-500/20 text-green-400 border-green-500/30',  icon: TrendingUp },
    SELL: { label: 'VENTE',  className: 'bg-red-500/20 text-red-400 border-red-500/30',        icon: TrendingDown },
    HOLD: { label: 'HOLD',   className: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30', icon: Minus },
    SKIP: { label: 'SKIP',   className: 'bg-gray-500/20 text-gray-400 border-gray-500/30',     icon: Minus },
  };
  const c = config[action] ?? config.HOLD;
  const Icon = c.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${c.className}`}>
      <Icon className="w-3 h-3" />
      {c.label}
    </span>
  );
}

function CycleRow({ cycle }: { cycle: Cycle }) {
  const [expanded, setExpanded] = useState(false);
  const hasActions = Number(cycle.buys) + Number(cycle.sells) > 0;

  return (
    <div className="border border-gray-800 rounded-xl overflow-hidden">
      {/* Cycle header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-4 hover:bg-gray-800/40 transition-colors text-left"
      >
        <div className="text-gray-500">
          {expanded
            ? <ChevronDown className="w-4 h-4" />
            : <ChevronRight className="w-4 h-4" />
          }
        </div>

        {/* Status dot */}
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${hasActions ? 'bg-green-400' : 'bg-gray-600'}`} />

        {/* Date */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-white font-medium text-sm">
              {format(new Date(cycle.started_at), "d MMM yyyy 'à' HH:mm", { locale: fr })}
            </span>
            {hasActions
              ? <CheckCircle className="w-3.5 h-3.5 text-green-400" />
              : <span className="text-gray-600 text-xs">Aucun trade</span>
            }
          </div>
          <div className="text-gray-500 text-xs mt-0.5 font-mono truncate">
            Cycle {cycle.cycle_id.slice(0, 8)}...
          </div>
        </div>

        {/* Stats */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {Number(cycle.buys) > 0 && (
            <span className="flex items-center gap-1 text-xs text-green-400 bg-green-500/10 px-2 py-1 rounded-lg">
              <TrendingUp className="w-3 h-3" />
              {cycle.buys} achat{Number(cycle.buys) > 1 ? 's' : ''}
            </span>
          )}
          {Number(cycle.sells) > 0 && (
            <span className="flex items-center gap-1 text-xs text-red-400 bg-red-500/10 px-2 py-1 rounded-lg">
              <TrendingDown className="w-3 h-3" />
              {cycle.sells} vente{Number(cycle.sells) > 1 ? 's' : ''}
            </span>
          )}
          {Number(cycle.holds) + Number(cycle.skips) > 0 && (
            <span className="flex items-center gap-1 text-xs text-gray-500 bg-gray-800 px-2 py-1 rounded-lg">
              <Minus className="w-3 h-3" />
              {Number(cycle.holds) + Number(cycle.skips)} hold
            </span>
          )}
        </div>
      </button>

      {/* Decisions detail */}
      {expanded && (
        <div className="border-t border-gray-800 bg-gray-900/30 divide-y divide-gray-800/50">
          {cycle.decisions.length === 0 ? (
            <div className="p-4 text-center text-gray-500 text-sm">
              Aucune décision enregistrée pour ce cycle
            </div>
          ) : (
            cycle.decisions.map((decision, idx) => (
              <div key={idx} className="p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-white font-bold">{decision.symbol || '—'}</span>
                    <ActionBadge action={decision.action} />
                    {decision.market_data?.price_eur && (
                      <span className="text-gray-400 text-xs">
                        {decision.market_data.price_eur.toFixed(4)}€
                        {decision.market_data.change_24h !== undefined && (
                          <span className={decision.market_data.change_24h >= 0 ? 'text-green-400 ml-1' : 'text-red-400 ml-1'}>
                            ({decision.market_data.change_24h >= 0 ? '+' : ''}{decision.market_data.change_24h.toFixed(1)}%)
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs flex-shrink-0">
                    <span className={`font-medium ${
                      decision.confidence >= 75 ? 'text-green-400' :
                      decision.confidence >= 60 ? 'text-yellow-400' : 'text-red-400'
                    }`}>
                      {decision.confidence}% confiance
                    </span>
                    <span className="text-gray-500">
                      risque {decision.risk_score}/100
                    </span>
                  </div>
                </div>

                {/* Reasoning */}
                <div className="bg-gray-900 rounded-lg p-3">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Brain className="w-3 h-3 text-purple-400" />
                    <span className="text-purple-400 text-xs font-medium">Raisonnement</span>
                    <span className="text-gray-600 text-xs ml-auto">{decision.model_used}</span>
                  </div>
                  <p className="text-gray-300 text-xs leading-relaxed">
                    {decision.reasoning}
                  </p>
                </div>

                {/* News context */}
                {decision.news_summary && (
                  <div className="mt-2 text-gray-500 text-xs">
                    📰 {decision.news_summary.slice(0, 200)}
                    {decision.news_summary.length > 200 ? '...' : ''}
                  </div>
                )}

                {/* Time */}
                <div className="flex items-center gap-1 mt-2 text-gray-600 text-xs">
                  <Clock className="w-3 h-3" />
                  {format(new Date(decision.decided_at), "HH:mm:ss", { locale: fr })}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function CycleHistory({ cycles }: Props) {
  if (cycles.length === 0) {
    return (
      <div className="text-center py-16 text-gray-500">
        <Activity className="w-10 h-10 mx-auto mb-3 opacity-30" />
        <p>Aucun cycle d&apos;analyse encore. Lance une analyse pour commencer.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {cycles.map((cycle) => (
        <CycleRow key={cycle.cycle_id} cycle={cycle} />
      ))}
    </div>
  );
}
