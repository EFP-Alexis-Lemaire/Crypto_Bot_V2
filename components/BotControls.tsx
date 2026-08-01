'use client';

import { useState } from 'react';
import { Play, Pause, Settings, RefreshCw, Send, Shield, TrendingUp, Zap } from 'lucide-react';

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

interface SliderProps {
  label: string;
  configKey: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  color: string;
  onChange: (key: string, value: string) => void;
}

function ConfigSlider({ label, configKey, value, min, max, unit = '', color, onChange }: SliderProps) {
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-gray-400 text-xs font-medium">{label}</span>
        <span className={`text-sm font-bold ${color}`}>
          {value}{unit}
        </span>
      </div>
      <div className="relative h-1.5 bg-gray-800 rounded-full">
        <div
          className={`absolute left-0 top-0 h-full rounded-full transition-all ${
            color === 'text-green-400' ? 'bg-green-500' :
            color === 'text-red-400' ? 'bg-red-500' :
            color === 'text-blue-400' ? 'bg-blue-500' :
            color === 'text-yellow-400' ? 'bg-yellow-500' : 'bg-purple-500'
          }`}
          style={{ width: `${pct}%` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={e => onChange(configKey, e.target.value)}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
      </div>
      <div className="flex justify-between text-gray-700 text-xs">
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>
    </div>
  );
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
    setMessage(isActive ? '⏸ Bot mis en pause' : '▶ Bot activé');
    setTimeout(() => setMessage(''), 3000);
  };

  const triggerAnalysis = async () => {
    setRunning(true);
    setMessage('🔍 Analyse en cours...');
    try {
      const res = await fetch('/api/bot/trigger', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setMessage(`❌ Erreur ${res.status}: ${data.error ?? 'inconnue'}`);
      } else {
        const trades = data.trades_executed ?? 0;
        const decisions = (data.decisions ?? []).length;
        setMessage(`✅ Terminé — ${trades} trade(s), ${decisions} décision(s)`);
        setTimeout(() => onConfigChange(), 500);
      }
    } catch (err) {
      setMessage(`❌ Erreur réseau: ${err}`);
    } finally {
      setRunning(false);
      setTimeout(() => setMessage(''), 8000);
    }
  };

  const triggerReport = async () => {
    setLoading(true);
    setMessage('📤 Envoi du rapport...');
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

  const riskLevels = [
    { key: 'conservative', label: 'Conservateur', icon: Shield, activeClass: 'bg-green-500/15 text-green-400 border-green-500/40 shadow-green-500/10 shadow-lg' },
    { key: 'moderate', label: 'Modéré', icon: TrendingUp, activeClass: 'bg-blue-500/15 text-blue-400 border-blue-500/40 shadow-blue-500/10 shadow-lg' },
    { key: 'aggressive', label: 'Agressif', icon: Zap, activeClass: 'bg-orange-500/15 text-orange-400 border-orange-500/40 shadow-orange-500/10 shadow-lg' },
  ];

  const sliders = [
    { label: 'Max trades / jour', configKey: 'max_trades_per_day', min: 1, max: 10, unit: '', color: 'text-blue-400' },
    { label: 'Stop-loss', configKey: 'stop_loss_pct', min: 3, max: 20, unit: '%', color: 'text-red-400' },
    { label: 'Take-profit', configKey: 'take_profit_pct', min: 5, max: 50, unit: '%', color: 'text-green-400' },
    { label: 'Taille max position', configKey: 'max_position_size_pct', min: 5, max: 40, unit: '%', color: 'text-purple-400' },
  ];

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 bg-gray-800 rounded-lg">
            <Settings className="w-4 h-4 text-gray-400" />
          </div>
          <span className="text-white font-semibold text-sm">Contrôles du Bot</span>
        </div>
        <div className={`flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-full border transition-all ${
          isActive
            ? 'bg-green-500/10 text-green-400 border-green-500/30'
            : 'bg-gray-800 text-gray-500 border-gray-700'
        }`}>
          <div className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`} />
          {isActive ? 'Actif' : 'En pause'}
        </div>
      </div>

      <div className="p-5 space-y-5">
        {/* Action buttons */}
        <div className="grid grid-cols-3 gap-2.5">
          <button
            onClick={toggleBot}
            className={`group flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-sm font-semibold border transition-all ${
              isActive
                ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border-red-500/20 hover:border-red-500/40'
                : 'bg-green-500/10 text-green-400 hover:bg-green-500/20 border-green-500/20 hover:border-green-500/40'
            }`}
          >
            {isActive
              ? <><Pause className="w-4 h-4" /> Pause</>
              : <><Play className="w-4 h-4" /> Activer</>
            }
          </button>

          <button
            onClick={triggerAnalysis}
            disabled={running}
            className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-sm font-semibold bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/20 hover:border-blue-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <RefreshCw className={`w-4 h-4 ${running ? 'animate-spin' : ''}`} />
            Analyser
          </button>

          <button
            onClick={triggerReport}
            disabled={loading}
            className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-sm font-semibold bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 border border-purple-500/20 hover:border-purple-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <Send className="w-4 h-4" />
            Rapport
          </button>
        </div>

        {/* Feedback message */}
        {message && (
          <div className="text-sm text-center py-2.5 px-4 bg-gray-800/80 border border-gray-700/50 rounded-xl text-gray-300">
            {message}
          </div>
        )}

        {/* Risk level */}
        <div>
          <p className="text-gray-500 text-xs font-medium mb-2.5 uppercase tracking-wider">Niveau de risque</p>
          <div className="grid grid-cols-3 gap-2">
            {riskLevels.map(level => {
              const Icon = level.icon;
              const isSelected = config.risk_level === level.key;
              return (
                <button
                  key={level.key}
                  onClick={() => updateConfig('risk_level', level.key)}
                  className={`flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl text-xs font-semibold border transition-all ${
                    isSelected
                      ? level.activeClass
                      : 'bg-gray-800/50 text-gray-500 border-gray-700/50 hover:border-gray-600 hover:text-gray-400'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {level.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Sliders */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-5">
          {sliders.map(slider => (
            <ConfigSlider
              key={slider.configKey}
              label={slider.label}
              configKey={slider.configKey}
              value={parseInt(config[slider.configKey as keyof Config] ?? String(slider.min))}
              min={slider.min}
              max={slider.max}
              unit={slider.unit}
              color={slider.color}
              onChange={updateConfig}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
