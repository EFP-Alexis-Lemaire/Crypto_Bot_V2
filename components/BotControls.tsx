'use client';

import { useState } from 'react';
import { Play, Pause, Settings, RefreshCw, Send } from 'lucide-react';

interface Config {
  risk_level: string;
  is_active: string;
  max_trades_per_day: string;
  stop_loss_pct: string;
  take_profit_pct: string;
  max_position_size_pct: string;
}

interface Props {
  config: Config;
  onConfigChange: () => void;
}

export default function BotControls({ config, onConfigChange }: Props) {
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');

  const isActive = config.is_active === 'true';

  const updateConfig = async (key: string, value: string) => {
    try {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      onConfigChange();
    } catch (error) {
      console.error('Config update error:', error);
    }
  };

  const toggleBot = async () => {
    await updateConfig('is_active', isActive ? 'false' : 'true');
    setMessage(isActive ? 'Bot mis en pause' : 'Bot activé');
    setTimeout(() => setMessage(''), 3000);
  };

  const triggerAnalysis = async () => {
    setRunning(true);
    setMessage('Analyse en cours...');
    try {
      const res = await fetch('/api/cron/analyze');
      const data = await res.json();
      setMessage(
        `✅ Analyse terminée: ${data.trades_executed ?? 0} trade(s) exécuté(s)`
      );
    } catch {
      setMessage('❌ Erreur lors de l\'analyse');
    } finally {
      setRunning(false);
      setTimeout(() => setMessage(''), 5000);
    }
  };

  const triggerReport = async () => {
    setLoading(true);
    setMessage('Envoi du rapport...');
    try {
      await fetch('/api/cron/daily-report');
      setMessage('✅ Rapport Telegram envoyé');
    } catch {
      setMessage('❌ Erreur Telegram');
    } finally {
      setLoading(false);
      setTimeout(() => setMessage(''), 4000);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Settings className="w-4 h-4 text-gray-400" />
        <h3 className="text-white font-semibold">Contrôles du Bot</h3>
        <div className={`ml-auto flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full ${
          isActive
            ? 'bg-green-400/10 text-green-400 border border-green-400/20'
            : 'bg-gray-700 text-gray-400 border border-gray-600'
        }`}>
          <div className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-green-400 animate-pulse' : 'bg-gray-500'}`} />
          {isActive ? 'Actif' : 'En pause'}
        </div>
      </div>

      {/* Action buttons */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        <button
          onClick={toggleBot}
          className={`flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors ${
            isActive
              ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/20'
              : 'bg-green-500/20 text-green-400 hover:bg-green-500/30 border border-green-500/20'
          }`}
        >
          {isActive ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          {isActive ? 'Pause' : 'Activer'}
        </button>

        <button
          onClick={triggerAnalysis}
          disabled={running}
          className="flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/20 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${running ? 'animate-spin' : ''}`} />
          Analyser
        </button>

        <button
          onClick={triggerReport}
          disabled={loading}
          className="flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 border border-purple-500/20 disabled:opacity-50"
        >
          <Send className="w-4 h-4" />
          Rapport
        </button>
      </div>

      {/* Message feedback */}
      {message && (
        <div className="text-sm text-center py-2 px-3 bg-gray-800 rounded-lg text-gray-300 mb-4">
          {message}
        </div>
      )}

      {/* Risk Level */}
      <div className="mb-3">
        <label className="text-gray-400 text-xs mb-1.5 block">Niveau de risque</label>
        <div className="grid grid-cols-3 gap-1.5">
          {(['conservative', 'moderate', 'aggressive'] as const).map(level => {
            const labels = {
              conservative: { fr: 'Conservateur', color: 'green' },
              moderate: { fr: 'Modéré', color: 'yellow' },
              aggressive: { fr: 'Agressif', color: 'red' },
            };
            const isSelected = config.risk_level === level;
            const colors = {
              green: isSelected ? 'bg-green-500/20 text-green-400 border-green-400/40' : 'bg-gray-800 text-gray-500 border-gray-700',
              yellow: isSelected ? 'bg-yellow-500/20 text-yellow-400 border-yellow-400/40' : 'bg-gray-800 text-gray-500 border-gray-700',
              red: isSelected ? 'bg-red-500/20 text-red-400 border-red-400/40' : 'bg-gray-800 text-gray-500 border-gray-700',
            };
            return (
              <button
                key={level}
                onClick={() => updateConfig('risk_level', level)}
                className={`text-xs py-2 rounded-lg border font-medium transition-all ${colors[labels[level].color as keyof typeof colors]}`}
              >
                {labels[level].fr}
              </button>
            );
          })}
        </div>
      </div>

      {/* Config params */}
      <div className="grid grid-cols-2 gap-2">
        {[
          { key: 'max_trades_per_day', label: 'Max trades/jour', min: 1, max: 10 },
          { key: 'stop_loss_pct', label: 'Stop-loss %', min: 3, max: 20 },
          { key: 'take_profit_pct', label: 'Take-profit %', min: 5, max: 50 },
          { key: 'max_position_size_pct', label: 'Max position %', min: 5, max: 40 },
        ].map(param => (
          <div key={param.key}>
            <label className="text-gray-500 text-xs mb-1 block">{param.label}</label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={param.min}
                max={param.max}
                value={parseInt(config[param.key as keyof Config] ?? '0')}
                onChange={e => updateConfig(param.key, e.target.value)}
                className="flex-1 accent-blue-500"
              />
              <span className="text-white text-xs w-8 text-right font-medium">
                {config[param.key as keyof Config]}
                {param.key !== 'max_trades_per_day' ? '%' : ''}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
