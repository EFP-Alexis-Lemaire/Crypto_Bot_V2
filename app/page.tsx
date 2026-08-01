'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  TrendingUp,
  TrendingDown,
  Wallet,
  Activity,
  RefreshCw,
  Bot,
  Newspaper,
  BarChart2,
} from 'lucide-react';
import PortfolioChart from '@/components/PortfolioChart';
import HoldingsPieChart from '@/components/HoldingsPieChart';
import DecisionCard from '@/components/DecisionCard';
import MarketTable from '@/components/MarketTable';
import BotControls from '@/components/BotControls';
import CycleHistory from '@/components/CycleHistory';
import { PortfolioSummary, MarketData } from '@/lib/types';

interface Snapshot {
  total_value_eur: number;
  cash_eur: number;
  crypto_value_eur: number;
  pnl_eur: number;
  pnl_percent: number;
  snapshotted_at: string;
}

interface Decision {
  id: number;
  symbol: string;
  action: string;
  reasoning: string;
  confidence: number;
  risk_score: number;
  model_used: string;
  decided_at: string;
  market_data?: { price_eur?: number; change_24h?: number; fear_greed?: number };
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

interface Trade {
  id: number;
  symbol: string;
  action: string;
  amount: number;
  price_eur: number;
  total_eur: number;
  executed_at: string;
  confidence: number;
}

interface NewsItem {
  title: string;
  source: string;
  url: string;
  published_at: string;
  sentiment: string;
}

type TabKey = 'overview' | 'cycles' | 'decisions' | 'trades' | 'market' | 'news';

export default function Dashboard() {
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [marketData, setMarketData] = useState<MarketData[]>([]);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [fearGreed, setFearGreed] = useState<{ value: number; label: string }>({
    value: 50,
    label: 'Neutral',
  });
  const [config, setConfig] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const isMounted = useRef(false);

  const fetchAll = useCallback(async () => {
    try {
      const [portfolioRes, decisionsRes, tradesRes, marketRes, configRes, cyclesRes] =
        await Promise.all([
          fetch('/api/portfolio'),
          fetch('/api/decisions?limit=20'),
          fetch('/api/trades?limit=30'),
          fetch('/api/market'),
          fetch('/api/config'),
          fetch('/api/cycles?limit=30'),
        ]);

      if (portfolioRes.ok) {
        const data = await portfolioRes.json();
        setPortfolio(data.portfolio);
        setSnapshots(data.snapshots ?? []);
      }

      if (decisionsRes.ok) {
        const data = await decisionsRes.json();
        setDecisions(data.decisions ?? []);
      }

      if (tradesRes.ok) {
        const data = await tradesRes.json();
        setTrades(data.trades ?? []);
      }

      if (marketRes.ok) {
        const data = await marketRes.json();
        setMarketData(data.marketData ?? []);
        setFearGreed(data.fearGreed ?? { value: 50, label: 'Neutral' });
        setNews(data.news ?? []);
      }

      if (configRes.ok) {
        const data = await configRes.json();
        setConfig(data.config ?? {});
      }

      if (cyclesRes.ok) {
        const data = await cyclesRes.json();
        setCycles(data.cycles ?? []);
      }

      setLastUpdated(new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
    } catch (error) {
      console.error('Fetch error:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    fetchAll();
    const interval = setInterval(fetchAll, 120000);
    return () => {
      isMounted.current = false;
      clearInterval(interval);
    };
  }, [fetchAll]);

  const fearEmoji =
    fearGreed.value < 25
      ? '😱'
      : fearGreed.value < 45
      ? '😟'
      : fearGreed.value < 55
      ? '😐'
      : fearGreed.value < 75
      ? '😊'
      : '🤑';

  const fearColor =
    fearGreed.value < 25
      ? 'text-red-500'
      : fearGreed.value < 45
      ? 'text-orange-400'
      : fearGreed.value < 55
      ? 'text-yellow-400'
      : fearGreed.value < 75
      ? 'text-green-400'
      : 'text-emerald-400';

  const tabs: { key: TabKey; label: string; icon: React.ElementType }[] = [
    { key: 'overview', label: 'Vue d\'ensemble', icon: BarChart2 },
    { key: 'cycles', label: 'Historique cycles', icon: Activity },
    { key: 'decisions', label: 'Décisions IA', icon: Bot },
    { key: 'trades', label: 'Trades', icon: Activity },
    { key: 'market', label: 'Marché', icon: TrendingUp },
    { key: 'news', label: 'Actualités', icon: Newspaper },
  ];

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <Bot className="w-12 h-12 text-blue-400 animate-pulse mx-auto mb-3" />
          <p className="text-gray-400">Chargement du dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-1.5 bg-blue-500/20 rounded-lg">
              <Bot className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h1 className="text-white font-bold text-sm">CryptoBot AI</h1>
              <p className="text-gray-500 text-xs">
                Mode: <span className="text-yellow-400 font-medium">PAPER TRADING</span>
                {' · '}
                <span className={config.is_active === 'true' ? 'text-green-400' : 'text-gray-500'}>
                  {config.is_active === 'true' ? '● Actif' : '○ En pause'}
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Fear & Greed */}
            <div className="hidden sm:flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-1.5">
              <span className="text-base">{fearEmoji}</span>
              <div>
                <div className={`text-xs font-semibold ${fearColor}`}>{fearGreed.label}</div>
                <div className="text-gray-500 text-xs">{fearGreed.value}/100</div>
              </div>
            </div>

            {lastUpdated && (
              <div className="hidden sm:flex items-center gap-1 text-gray-500 text-xs">
                <RefreshCw className="w-3 h-3" />
                {lastUpdated}
              </div>
            )}

            <button
              onClick={fetchAll}
              className="p-2 bg-gray-800 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white"
              title="Rafraîchir"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="max-w-7xl mx-auto px-4 flex gap-0 overflow-x-auto">
          {tabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm border-b-2 whitespace-nowrap transition-colors ${
                  activeTab === tab.key
                    ? 'border-blue-400 text-blue-400'
                    : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        {/* OVERVIEW TAB */}
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* KPI Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Wallet className="w-4 h-4 text-blue-400" />
                  <span className="text-gray-400 text-xs">Valeur Totale</span>
                </div>
                <div className="text-2xl font-bold text-white">
                  {portfolio?.total_value_eur.toFixed(2) ?? '—'}€
                </div>
                <div className="text-gray-500 text-xs mt-1">
                  Cash: {portfolio?.cash_eur.toFixed(2) ?? '—'}€
                </div>
              </div>

              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  {(portfolio?.pnl_eur ?? 0) >= 0 ? (
                    <TrendingUp className="w-4 h-4 text-green-400" />
                  ) : (
                    <TrendingDown className="w-4 h-4 text-red-400" />
                  )}
                  <span className="text-gray-400 text-xs">P&L Total</span>
                </div>
                <div
                  className={`text-2xl font-bold ${
                    (portfolio?.pnl_eur ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                  }`}
                >
                  {portfolio?.pnl_eur !== undefined
                    ? `${portfolio.pnl_eur >= 0 ? '+' : ''}${portfolio.pnl_eur.toFixed(2)}€`
                    : '—'}
                </div>
                <div
                  className={`text-xs mt-1 ${
                    (portfolio?.pnl_percent ?? 0) >= 0 ? 'text-green-400/70' : 'text-red-400/70'
                  }`}
                >
                  {portfolio?.pnl_percent !== undefined
                    ? `${portfolio.pnl_percent >= 0 ? '+' : ''}${portfolio.pnl_percent.toFixed(2)}%`
                    : '—'}
                </div>
              </div>

              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Activity className="w-4 h-4 text-purple-400" />
                  <span className="text-gray-400 text-xs">Positions Crypto</span>
                </div>
                <div className="text-2xl font-bold text-white">
                  {portfolio?.holdings.length ?? 0}
                </div>
                <div className="text-gray-500 text-xs mt-1">
                  Valeur: {portfolio?.crypto_value_eur.toFixed(2) ?? '0'}€
                </div>
              </div>

              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Bot className="w-4 h-4 text-yellow-400" />
                  <span className="text-gray-400 text-xs">Trades Total</span>
                </div>
                <div className="text-2xl font-bold text-white">{trades.length}</div>
                <div className="text-gray-500 text-xs mt-1">
                  Décisions IA: {decisions.length}
                </div>
              </div>
            </div>

            {/* Chart + Pie */}
            <div className="grid lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 bg-gray-900 border border-gray-800 rounded-xl p-4">
                <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
                  <BarChart2 className="w-4 h-4 text-blue-400" />
                  Évolution du portefeuille
                </h3>
                <PortfolioChart snapshots={snapshots} initialValue={5000} />
              </div>

              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <h3 className="text-white font-semibold mb-4 flex items-center gap-2">
                  <Wallet className="w-4 h-4 text-purple-400" />
                  Répartition
                </h3>
                <HoldingsPieChart
                  holdings={portfolio?.holdings ?? []}
                  cashEur={portfolio?.cash_eur ?? 5000}
                />
              </div>
            </div>

            {/* Holdings Table */}
            {portfolio && portfolio.holdings.length > 0 && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <h3 className="text-white font-semibold mb-4">Positions ouvertes</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-gray-500 border-b border-gray-800">
                        <th className="text-left py-2 px-3">Crypto</th>
                        <th className="text-right py-2 px-3">Quantité</th>
                        <th className="text-right py-2 px-3">Prix moyen</th>
                        <th className="text-right py-2 px-3">Prix actuel</th>
                        <th className="text-right py-2 px-3">Valeur</th>
                        <th className="text-right py-2 px-3">P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {portfolio.holdings.map(h => (
                        <tr key={h.symbol} className="border-b border-gray-800/50">
                          <td className="py-2.5 px-3">
                            <div className="font-medium text-white">{h.symbol}</div>
                            <div className="text-gray-500 text-xs">{h.name}</div>
                          </td>
                          <td className="py-2.5 px-3 text-right text-gray-300">
                            {h.amount < 0.001
                              ? h.amount.toFixed(6)
                              : h.amount.toFixed(4)}
                          </td>
                          <td className="py-2.5 px-3 text-right text-gray-400">
                            {h.avg_buy_price_eur.toFixed(4)}€
                          </td>
                          <td className="py-2.5 px-3 text-right text-white">
                            {h.current_price_eur.toFixed(4)}€
                          </td>
                          <td className="py-2.5 px-3 text-right text-white font-medium">
                            {h.current_value_eur.toFixed(2)}€
                          </td>
                          <td className="py-2.5 px-3 text-right">
                            <div
                              className={`font-medium ${
                                h.pnl_eur >= 0 ? 'text-green-400' : 'text-red-400'
                              }`}
                            >
                              {h.pnl_eur >= 0 ? '+' : ''}{h.pnl_eur.toFixed(2)}€
                            </div>
                            <div
                              className={`text-xs ${
                                h.pnl_percent >= 0 ? 'text-green-400/70' : 'text-red-400/70'
                              }`}
                            >
                              {h.pnl_percent >= 0 ? '+' : ''}{h.pnl_percent.toFixed(2)}%
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Bot Controls */}
            <BotControls
              config={config as unknown as { risk_level: string; is_active: string; max_trades_per_day: string; stop_loss_pct: string; take_profit_pct: string; max_position_size_pct: string }}
              onConfigChange={fetchAll}
            />
          </div>
        )}

        {/* CYCLES TAB */}
        {activeTab === 'cycles' && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-white font-bold text-lg flex items-center gap-2">
                <Activity className="w-5 h-5 text-blue-400" />
                Historique des cycles d&apos;analyse
              </h2>
              <span className="text-gray-500 text-sm">{cycles.length} cycle{cycles.length > 1 ? 's' : ''}</span>
            </div>
            <CycleHistory cycles={cycles} />
          </div>
        )}

        {/* DECISIONS TAB */}
        {activeTab === 'decisions' && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-white font-bold text-lg flex items-center gap-2">
                <Bot className="w-5 h-5 text-blue-400" />
                Journal des décisions IA
              </h2>
              <span className="text-gray-500 text-sm">{decisions.length} décisions</span>
            </div>

            {decisions.length === 0 ? (
              <div className="text-center py-16 text-gray-500">
                <Bot className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>Aucune décision encore. Lance une analyse pour commencer.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {decisions.map(d => (
                  <DecisionCard key={d.id} decision={d} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* TRADES TAB */}
        {activeTab === 'trades' && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-white font-bold text-lg flex items-center gap-2">
                <Activity className="w-5 h-5 text-purple-400" />
                Historique des trades
              </h2>
              <span className="text-gray-500 text-sm">{trades.length} trades</span>
            </div>

            {trades.length === 0 ? (
              <div className="text-center py-16 text-gray-500">
                <Activity className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>Aucun trade exécuté pour l'instant.</p>
              </div>
            ) : (
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800 bg-gray-900/80">
                      <th className="text-left py-3 px-4">Date</th>
                      <th className="text-left py-3 px-4">Crypto</th>
                      <th className="text-left py-3 px-4">Action</th>
                      <th className="text-right py-3 px-4">Quantité</th>
                      <th className="text-right py-3 px-4">Prix EUR</th>
                      <th className="text-right py-3 px-4">Total EUR</th>
                      <th className="text-right py-3 px-4 hidden md:table-cell">Confiance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map(t => (
                      <tr key={t.id} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                        <td className="py-3 px-4 text-gray-400 text-xs">
                          {new Date(t.executed_at).toLocaleString('fr-FR', {
                            day: '2-digit',
                            month: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </td>
                        <td className="py-3 px-4 font-medium text-white">{t.symbol}</td>
                        <td className="py-3 px-4">
                          <span
                            className={`px-2 py-0.5 rounded text-xs font-semibold ${
                              t.action === 'BUY'
                                ? 'bg-green-500/20 text-green-400'
                                : 'bg-red-500/20 text-red-400'
                            }`}
                          >
                            {t.action === 'BUY' ? 'ACHAT' : 'VENTE'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right text-gray-300">
                          {parseFloat(String(t.amount)).toFixed(6)}
                        </td>
                        <td className="py-3 px-4 text-right text-white">
                          {parseFloat(String(t.price_eur)).toFixed(4)}€
                        </td>
                        <td className="py-3 px-4 text-right font-medium text-white">
                          {parseFloat(String(t.total_eur)).toFixed(2)}€
                        </td>
                        <td className="py-3 px-4 text-right hidden md:table-cell">
                          <span
                            className={`text-xs font-medium ${
                              t.confidence >= 75
                                ? 'text-green-400'
                                : t.confidence >= 60
                                ? 'text-yellow-400'
                                : 'text-red-400'
                            }`}
                          >
                            {t.confidence}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* MARKET TAB */}
        {activeTab === 'market' && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-white font-bold text-lg flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-green-400" />
                Données Marché
              </h2>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-base">{fearEmoji}</span>
                <span className={fearColor}>{fearGreed.label}</span>
                <span className="text-gray-500">{fearGreed.value}/100</span>
              </div>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <MarketTable marketData={marketData} />
            </div>
          </div>
        )}

        {/* NEWS TAB */}
        {activeTab === 'news' && (
          <div>
            <h2 className="text-white font-bold text-lg mb-4 flex items-center gap-2">
              <Newspaper className="w-5 h-5 text-yellow-400" />
              Actualités Crypto
            </h2>

            {news.length === 0 ? (
              <div className="text-center py-16 text-gray-500">
                <Newspaper className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>Aucune actualité disponible.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {news.map((item, idx) => (
                  <a
                    key={idx}
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-gray-600 transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${
                          item.sentiment === 'positive'
                            ? 'bg-green-400'
                            : item.sentiment === 'negative'
                            ? 'bg-red-400'
                            : 'bg-gray-500'
                        }`}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-sm font-medium leading-snug">
                          {item.title}
                        </p>
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className="text-gray-500 text-xs">{item.source}</span>
                          <span className="text-gray-700">·</span>
                          <span className="text-gray-500 text-xs">
                            {new Date(item.published_at).toLocaleDateString('fr-FR')}
                          </span>
                          <span
                            className={`ml-auto text-xs px-1.5 py-0.5 rounded ${
                              item.sentiment === 'positive'
                                ? 'bg-green-500/10 text-green-400'
                                : item.sentiment === 'negative'
                                ? 'bg-red-500/10 text-red-400'
                                : 'bg-gray-700 text-gray-400'
                            }`}
                          >
                            {item.sentiment === 'positive'
                              ? '+ Positif'
                              : item.sentiment === 'negative'
                              ? '- Négatif'
                              : '○ Neutre'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
