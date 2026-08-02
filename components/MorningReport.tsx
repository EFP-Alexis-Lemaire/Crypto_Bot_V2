'use client';

import { useState } from 'react';
import {
  Sun, TrendingUp, TrendingDown, Minus, Zap,
  Target, AlertTriangle, Lightbulb, ChevronDown, ChevronUp,
  BarChart2, RefreshCw,
} from 'lucide-react';

interface MarketReport {
  date: string;
  market_score: number;
  market_score_label: string;
  market_score_color: string;
  outlook: string;
  summary: string;
  key_points: string[];
  opportunities: string[];
  risks: string[];
  advice: string;
  fear_greed: number;
  fear_greed_label: string;
  eur_usd: number;
  top_movers: { symbol: string; change: number }[];
  created_at: string;
}

interface Props {
  report: MarketReport | null;
  onRefresh: () => void;
}

const colorMap: Record<string, { bar: string; text: string; bg: string; border: string; dot: string }> = {
  green:  { bar: 'bg-green-500',  text: 'text-green-400',  bg: 'bg-green-500/10',  border: 'border-green-500/25', dot: 'bg-green-400' },
  blue:   { bar: 'bg-blue-500',   text: 'text-blue-400',   bg: 'bg-blue-500/10',   border: 'border-blue-500/25',  dot: 'bg-blue-400' },
  yellow: { bar: 'bg-yellow-500', text: 'text-yellow-400', bg: 'bg-yellow-500/10', border: 'border-yellow-500/25',dot: 'bg-yellow-400' },
  red:    { bar: 'bg-red-500',    text: 'text-red-400',    bg: 'bg-red-500/10',    border: 'border-red-500/25',   dot: 'bg-red-400' },
};

const outlookMap: Record<string, { icon: React.ElementType; label: string; color: string }> = {
  bullish:  { icon: TrendingUp,   label: 'Haussier',  color: 'text-green-400' },
  bearish:  { icon: TrendingDown, label: 'Baissier',  color: 'text-red-400' },
  neutral:  { icon: Minus,        label: 'Neutre',    color: 'text-blue-400' },
  volatile: { icon: Zap,          label: 'Volatile',  color: 'text-orange-400' },
};

export default function MorningReport({ report, onRefresh }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [generating, setGenerating] = useState(false);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      await fetch('/api/cron/morning-report', { method: 'POST' });
      setTimeout(() => { onRefresh(); setGenerating(false); }, 1500);
    } catch {
      setGenerating(false);
    }
  };

  // — État vide —
  if (!report) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5 text-gray-500 text-sm">
          <Sun className="w-4 h-4 text-yellow-400/50" />
          <span>Rapport matinal non disponible</span>
        </div>
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-500/10 hover:bg-yellow-500/20 border border-yellow-500/20 rounded-lg text-yellow-400 text-xs font-medium transition-all disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${generating ? 'animate-spin' : ''}`} />
          {generating ? 'Génération...' : 'Générer'}
        </button>
      </div>
    );
  }

  const c = colorMap[report.market_score_color] ?? colorMap.blue;
  const o = outlookMap[report.outlook] ?? outlookMap.neutral;
  const OutlookIcon = o.icon;

  return (
    <div className={`border rounded-xl overflow-hidden transition-all ${c.bg} ${c.border}`}>

      {/* ── BARRE COMPACTE (toujours visible) ── */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:brightness-110 transition-all text-left"
      >
        {/* Icône soleil */}
        <Sun className="w-4 h-4 text-yellow-400 flex-shrink-0" />

        {/* Score pill */}
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-900/60 border ${c.border} flex-shrink-0`}>
          <div className={`w-2 h-2 rounded-full ${c.dot}`} />
          <span className={`text-xs font-bold ${c.text}`}>{report.market_score}/100</span>
          <span className="text-gray-500 text-xs">{report.market_score_label}</span>
        </div>

        {/* Outlook */}
        <div className={`flex items-center gap-1 text-xs font-medium ${o.color} flex-shrink-0`}>
          <OutlookIcon className="w-3.5 h-3.5" />
          {o.label}
        </div>

        {/* Mini barre de progression */}
        <div className="flex-1 h-1.5 bg-gray-800/80 rounded-full overflow-hidden hidden sm:block">
          <div
            className={`h-full rounded-full ${c.bar}`}
            style={{ width: `${report.market_score}%`, transition: 'width 0.6s ease' }}
          />
        </div>

        {/* Date + expand */}
        <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
          <span className="text-gray-600 text-xs hidden md:block">{report.date}</span>
          <button
            onClick={e => { e.stopPropagation(); handleGenerate(); }}
            disabled={generating}
            className="p-1 rounded text-gray-600 hover:text-gray-400 transition-colors"
            title="Régénérer"
          >
            <RefreshCw className={`w-3 h-3 ${generating ? 'animate-spin' : ''}`} />
          </button>
          {expanded
            ? <ChevronUp className="w-4 h-4 text-gray-500" />
            : <ChevronDown className="w-4 h-4 text-gray-500" />
          }
        </div>
      </button>

      {/* ── CONTENU EXPANDÉ ── */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-gray-800/60">

          {/* Stats rapides */}
          <div className="grid grid-cols-3 gap-2 pt-3">
            <div className="bg-gray-900/60 rounded-lg p-2.5 text-center">
              <div className="text-gray-500 text-xs mb-0.5">Fear & Greed</div>
              <div className="text-white font-bold text-sm">{report.fear_greed}/100</div>
              <div className="text-gray-600 text-xs truncate">{report.fear_greed_label}</div>
            </div>
            <div className="bg-gray-900/60 rounded-lg p-2.5 text-center">
              <div className="text-gray-500 text-xs mb-0.5">EUR/USD</div>
              <div className="text-white font-bold text-sm">{report.eur_usd.toFixed(4)}</div>
            </div>
            <div className="bg-gray-900/60 rounded-lg p-2.5 text-center">
              <div className="text-gray-500 text-xs mb-0.5">Top mover</div>
              {report.top_movers[0] && (
                <>
                  <div className="text-white font-bold text-sm">{report.top_movers[0].symbol}</div>
                  <div className={`text-xs ${report.top_movers[0].change >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {report.top_movers[0].change >= 0 ? '+' : ''}{report.top_movers[0].change.toFixed(1)}%
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Résumé */}
          <p className="text-gray-300 text-sm leading-relaxed">{report.summary}</p>

          {/* Conseil */}
          <div className="flex items-start gap-2.5 p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl">
            <Lightbulb className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
            <div>
              <div className="text-blue-400 text-xs font-semibold mb-0.5">Conseil du jour</div>
              <p className="text-gray-300 text-xs leading-relaxed">{report.advice}</p>
            </div>
          </div>

          {/* Points clés */}
          {report.key_points.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <BarChart2 className="w-3.5 h-3.5 text-gray-500" />
                <span className="text-gray-500 text-xs font-semibold uppercase tracking-wider">Points clés</span>
              </div>
              <ul className="space-y-1">
                {report.key_points.map((point, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-gray-300">
                    <span className="text-gray-600 mt-0.5 flex-shrink-0">•</span>{point}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Opps + Risques côte à côte */}
          <div className="grid grid-cols-2 gap-3">
            {report.opportunities.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Target className="w-3.5 h-3.5 text-green-400" />
                  <span className="text-green-400 text-xs font-semibold uppercase tracking-wider">Opportunités</span>
                </div>
                <ul className="space-y-1">
                  {report.opportunities.slice(0, 3).map((opp, i) => (
                    <li key={i} className="text-xs text-gray-300 flex items-start gap-1.5">
                      <span className="text-green-700 flex-shrink-0">+</span>{opp}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {report.risks.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-orange-400" />
                  <span className="text-orange-400 text-xs font-semibold uppercase tracking-wider">Risques</span>
                </div>
                <ul className="space-y-1">
                  {report.risks.slice(0, 3).map((risk, i) => (
                    <li key={i} className="text-xs text-gray-300 flex items-start gap-1.5">
                      <span className="text-orange-700 flex-shrink-0">⚠</span>{risk}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Top movers chips */}
          {report.top_movers.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {report.top_movers.map((m, i) => (
                <span key={i} className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  m.change >= 0 ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
                }`}>
                  {m.symbol} {m.change >= 0 ? '+' : ''}{m.change.toFixed(1)}%
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
