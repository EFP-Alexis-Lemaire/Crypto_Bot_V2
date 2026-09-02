'use client';

import { useState, useCallback, useRef } from 'react';
import { Play, Pause, Settings, RefreshCw, Send, Shield, TrendingUp, Zap } from 'lucide-react';

interface Config {
  risk_level: string;
  is_active: string;
  trading_mode: string;
  max_trades_per_day: string;
  stop_loss_pct: string;
  take_profit_pct: string;
  max_position_size_pct: string;
}

interface Props {
  config: Config;
  onConfigChange: () => void;
  dbContext: 'uat' | 'prod';
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
        <span className={`text-sm font-bold ${color}`}>{value}{unit}</span>
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

function EnvSwitch({ isLive, onSwitch }: { isLive: boolean; onSwitch: (mode: string) => Promise<void> }) {
  const borderCls = isLive ? 'bg-red-500/10 border-red-500/30' : 'bg-gray-800/50 border-gray-700/50';
  const titleCls = isLive ? 'text-red-400' : 'text-gray-300';
  const btnCls = isLive
    ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
    : 'bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/20';

  return (
    <div className={`flex items-center justify-between p-3 rounded-xl border ${borderCls}`}>
      <div>
        <div className={`text-sm font-semibold ${titleCls}`}>
          {isLive ? '🔴 MODE LIVE (Argent réel)' : '📝 Mode Paper (Fictif)'}
        </div>
        <div className="text-gray-500 text-xs mt-0.5">
          {isLive ? 'Trades sur Kraken/Coinbase' : 'Aucun argent réel'}
        </div>
      </div>
      <button
        onClick={async () => {
          const next = isLive ? 'paper' : 'live';
          if (next === 'live') {
            const ok = window.confirm(
              'ATTENTION\n\nPasser en LIVE va executer de vrais trades avec ton argent.\n\nConfirmer ?'
            );
            if (!ok) return;
          }
          await onSwitch(next);
        }}
        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${btnCls}`}
      >
        {isLive ? 'Paper' : 'Live'}
      </button>
    </div>
  );
}

export default function BotControls({ config, onConfigChange, dbContext }: Props) {
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');
  const [localConfig, setLocalConfig] = useState<Config>({
    risk_level: config.risk_level ?? 'moderate',
    is_active: config.is_active ?? 'true',
    trading_mode: config.trading_mode ?? 'paper',
    max_trades_per_day: config.max_trades_per_day ?? '5',
    stop_loss_pct: config.stop_loss_pct ?? '8',
    take_profit_pct: config.take_profit_pct ?? '15',
    max_position_size_pct: config.max_position_size_pct ?? '20',
  });
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const isActive = localConfig.is_active === 'true';

  const updateConfig = useCallback(async (key: string, value: string) => {
    try {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-db-context': dbContext },
        body: JSON.stringify({ key, value }),
      });
      onConfigChange();
    } catch (error) {
      console.error('Config update error:', error);
    }
  }, [onConfigChange, dbContext]);

  const updateConfigDebounced = useCallback((key: string, value: string) => {
    setLocalConfig(prev => ({ ...prev, [key]: value }));
    if (debounceTimers.current[key]) clearTimeout(debounceTimers.current[key]);
    debounceTimers.current[key] = setTimeout(() => updateConfig(key, value), 600);
  }, [updateConfig]);

  const toggleBot = async () => {
    const newVal = isActive ? 'false' : 'true';
    setLocalConfig(prev => ({ ...prev, is_active: newVal }));
    await updateConfig('is_active', newVal);
    setMessage(isActive ? 'Bot mis en pause' : 'Bot active');
    setTimeout(() => setMessage(''), 3000);
  };

  const triggerAnalysis = async () => {
    setRunning(true);
    setMessage('Analyse en cours...');
    try {
      const res = await fetch('/api/bot/trigger', {
        method: 'POST',
        headers: { 'x-db-context': dbContext },
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(`Erreur ${res.status}: ${data.error ?? 'inconnue'}`);
      } else {
        const trades = data.trades_executed ?? 0;
        const dec = (data.decisions ?? []).length;
        setMessage(`Termine — ${trades} trade(s), ${dec} decision(s)`);
        setTimeout(() => onConfigChange(), 500);
      }
    } catch (err) {
      setMessage(`Erreur reseau: ${err}`);
    } finally {
      setRunning(false);
      setTimeout(() => setMessage(''), 8000);
    }
  };

  const triggerReport = async () => {
    setLoading(true);
    setMessage('Envoi du rapport...');
    try {
      const res = await fetch('/api/bot/report', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json();
        setMessage(`Erreur: ${data.error ?? 'inconnue'}`);
      } else {
        setMessage('Rapport Telegram envoye');
      }
    } catch {
      setMessage('Erreur Telegram');
    } finally {
      setLoading(false);
      setTimeout(() => setMessage(''), 4000);
    }
  };

  const riskLevels = [
    { key: 'conservative', label: 'Conservateur', icon: Shield, activeClass: 'bg-green-500/15 text-green-400 border-green-500/40' },
    { key: 'moderate',     label: 'Modere',        icon: TrendingUp, activeClass: 'bg-blue-500/15 text-blue-400 border-blue-500/40' },
    { key: 'aggressive',   label: 'Agressif',      icon: Zap,        activeClass: 'bg-orange-500/15 text-orange-400 border-orange-500/40' },
  ];

  const sliders = [
    { label: 'Max trades/jour',  configKey: 'max_trades_per_day',    min: 1, max: 10, unit: '',  color: 'text-blue-400' },
    { label: 'Stop-loss',        configKey: 'stop_loss_pct',          min: 3, max: 20, unit: '%', color: 'text-red-400' },
    { label: 'Take-profit',      configKey: 'take_profit_pct',        min: 5, max: 50, unit: '%', color: 'text-green-400' },
    { label: 'Max position',     configKey: 'max_position_size_pct',  min: 5, max: 40, unit: '%', color: 'text-purple-400' },
  ];

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 bg-gray-800 rounded-lg">
            <Settings className="w-4 h-4 text-gray-400" />
          </div>
          <span className="text-white font-semibold text-sm">Controles du Bot</span>
        </div>
        <div className={`flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-full border ${isActive ? 'bg-green-500/10 text-green-400 border-green-500/30' : 'bg-gray-800 text-gray-500 border-gray-700'}`}>
          <div className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`} />
          {isActive ? 'Actif' : 'En pause'}
        </div>
      </div>

      <div className="p-5 space-y-5">
        {/* Action buttons */}
        <div className="grid grid-cols-3 gap-2.5">
          <button
            onClick={toggleBot}
            className={`flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-sm font-semibold border transition-all ${isActive ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border-red-500/20' : 'bg-green-500/10 text-green-400 hover:bg-green-500/20 border-green-500/20'}`}
          >
            {isActive ? <><Pause className="w-4 h-4" /> Pause</> : <><Play className="w-4 h-4" /> Activer</>}
          </button>

          <button
            onClick={triggerAnalysis}
            disabled={running}
            className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-sm font-semibold bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/20 disabled:opacity-40 transition-all"
          >
            <RefreshCw className={`w-4 h-4 ${running ? 'animate-spin' : ''}`} />
            Analyser
          </button>

          <button
            onClick={triggerReport}
            disabled={loading}
            className="flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-sm font-semibold bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 border border-purple-500/20 disabled:opacity-40 transition-all"
          >
            <Send className="w-4 h-4" />
            Rapport
          </button>
        </div>

        {/* Feedback */}
        {message && (
          <div className="text-sm text-center py-2.5 px-4 bg-gray-800/80 border border-gray-700/50 rounded-xl text-gray-300">
            {message}
          </div>
        )}

        {/* Environment switch */}
        <EnvSwitch
          isLive={localConfig.trading_mode === 'live'}
          onSwitch={async (nextMode) => {
            setLocalConfig(prev => ({ ...prev, trading_mode: nextMode }));
            await updateConfig('trading_mode', nextMode);
            setMessage(nextMode === 'live' ? 'Mode LIVE active' : 'Mode Paper');
            setTimeout(() => setMessage(''), 4000);
          }}
        />

        {/* Risk level */}
        <div>
          <p className="text-gray-500 text-xs font-medium mb-2.5 uppercase tracking-wider">Niveau de risque</p>
          <div className="grid grid-cols-3 gap-2">
            {riskLevels.map(level => {
              const Icon = level.icon;
              const isSelected = localConfig.risk_level === level.key;
              return (
                <button
                  key={level.key}
                  onClick={() => {
                    setLocalConfig(prev => ({ ...prev, risk_level: level.key }));
                    updateConfig('risk_level', level.key);
                  }}
                  className={`flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl text-xs font-semibold border transition-all ${isSelected ? level.activeClass : 'bg-gray-800/50 text-gray-500 border-gray-700/50 hover:border-gray-600'}`}
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
              value={parseInt(localConfig[slider.configKey as keyof Config] ?? String(slider.min))}
              min={slider.min}
              max={slider.max}
              unit={slider.unit}
              color={slider.color}
              onChange={updateConfigDebounced}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
