export type RiskLevel = 'conservative' | 'moderate' | 'aggressive';
export type TradingMode = 'paper' | 'live';
export type TradeAction = 'BUY' | 'SELL' | 'HOLD' | 'SKIP';

export interface MarketData {
  symbol: string;
  name: string;
  price_eur: number;
  price_usd: number;
  change_24h: number;
  change_7d: number;
  volume_24h_usd: number;
  market_cap_usd: number;
  market_cap_rank: number;
  ath_eur: number;
  ath_change_percentage: number;
}

export interface TechnicalIndicators {
  symbol: string;
  rsi_14: number | null;
  macd: number | null;
  macd_signal: number | null;
  macd_histogram: number | null;
  sma_20: number | null;
  sma_50: number | null;
  ema_12: number | null;
  ema_26: number | null;
  bb_upper: number | null;
  bb_middle: number | null;
  bb_lower: number | null;
  trend: 'bullish' | 'bearish' | 'neutral';
  // --- Signaux pré-boom / volatilité ---
  volatility_pct: number | null;   // écart-type des rendements journaliers (%) — proxy ATR
  volume_zscore: number | null;    // dernier volume vs moyenne 30j (> 2 = breakout)
  bb_width_pct: number | null;     // largeur des bandes de Bollinger (%)
  bb_squeeze: boolean;             // largeur au plus bas 20% (compression avant expansion)
  roc_30d: number | null;          // momentum 30 jours (%)
  macd_hist_slope: number | null;  // pente de l'histogramme MACD (signe = accélération)
}

export interface NewsItem {
  title: string;
  source: string;
  url: string;
  published_at: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  currencies?: string[];
}

export interface BotDecision {
  symbol: string;
  action: TradeAction;
  amount_eur: number;
  reasoning: string;
  confidence: number;
  risk_score: number;
  target_price_eur?: number;
  stop_loss_eur?: number;
  take_profit_eur?: number;
  timeframe: string;
  // Vente partielle (take-profit 50%) : l'avg est conservée, le flag DB est levé
  partial?: boolean;
}

export interface PortfolioHolding {
  symbol: string;
  name: string;
  amount: number;
  avg_buy_price_eur: number;
  current_price_eur: number;
  current_value_eur: number;
  pnl_eur: number;
  pnl_percent: number;
  // Exchange(s) détenant l'actif (mode live uniquement)
  source?: 'kraken' | 'coinbase' | 'both';
}

export interface PortfolioSummary {
  total_value_eur: number;
  cash_eur: number;
  crypto_value_eur: number;
  pnl_eur: number;
  pnl_percent: number;
  holdings: PortfolioHolding[];
  // Cash disponible PAR exchange (mode live uniquement).
  // cash_eur reste le total (= kraken + coinbase) pour compatibilité.
  cash_by_exchange?: {
    kraken: number;
    coinbase: number;
  };
}

export interface RiskConfig {
  max_trades_per_day: number;
  max_position_size_pct: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  min_confidence: number;
  max_portfolio_crypto_pct: number;
  // Budget risque par trade (% du total) : un stop-out ne coûte jamais plus.
  // Taille = min(règles cash, max position, budget_risque / stop_dynamique)
  risk_per_trade_pct: number;
}

export const RISK_CONFIGS: Record<RiskLevel, RiskConfig> = {
  conservative: {
    max_trades_per_day: 2,
    max_position_size_pct: 10,
    stop_loss_pct: 5,
    take_profit_pct: 10,
    min_confidence: 75,
    max_portfolio_crypto_pct: 50,
    risk_per_trade_pct: 1,
  },
  moderate: {
    max_trades_per_day: 5,
    max_position_size_pct: 20,
    stop_loss_pct: 8,
    take_profit_pct: 15,
    min_confidence: 65,
    max_portfolio_crypto_pct: 70,
    risk_per_trade_pct: 1.5,
  },
  aggressive: {
    max_trades_per_day: 8,
    max_position_size_pct: 30,
    stop_loss_pct: 12,
    take_profit_pct: 25,
    min_confidence: 55,
    max_portfolio_crypto_pct: 90,
    risk_per_trade_pct: 2.5,
  },
};

// Secteurs pour la limite de corrélation (max N BUYs du même secteur par cycle)
export const SECTOR_MAP: Record<string, string> = {
  UNI: 'DEFI', AAVE: 'DEFI', LINK: 'DEFI', CRV: 'DEFI', MKR: 'DEFI',
  SOL: 'L1', ADA: 'L1', DOT: 'L1', AVAX: 'L1', NEAR: 'L1', ALGO: 'L1',
  SUI: 'L1', APT: 'L1', SEI: 'L1', TIA: 'L1', TON: 'L1', INJ: 'L1',
  ARB: 'L2', OP: 'L2', MATIC: 'L2', STRK: 'L2',
  BTC: 'MAJOR', ETH: 'MAJOR', XRP: 'MAJOR', LTC: 'MAJOR', ETC: 'MAJOR',
};
export const MAX_BUYS_PER_SECTOR_PER_CYCLE = 2;
export const sectorOf = (symbol: string): string => SECTOR_MAP[symbol] ?? 'OTHER';

// --- Règle majors (BTC/ETH) : participer aux tendances + acheter la peur ---
// Jamais de plafond "trop cher" au feeling : cher + fort = autorisé (20%).
export const MAJOR_SYMBOLS = ['BTC', 'ETH'];
// RSI accepté jusqu'ici pour les majors en tendance bullish (exemption à la règle RSI>75)
export const MAJORS_RSI_MAX = 80;
// En mode dip (crash objectif), plafond relevé pour acheter la peur
export const DIP_MAX_POSITION_PCT = 50;
// Déclencheurs objectifs du mode dip (OU logique)
export const DIP_DRAWDOWN_PCT = -15; // drawdown BTC 30j <= -15%
export const DIP_FEAR_GREED_MAX = 25; // Fear & Greed <= 25 (peur extrême)
// Cash sanctuarisé : jamais moins de 20% de cash, même en mode dip
export const MIN_CASH_RESERVE_PCT = 20;

// Stop dynamique partagé IA <-> exécution : 1.5× la volatilité journalière,
// ancré à la config utilisateur (jamais < moitié ni > double du stop configuré).
export function dynamicStopPct(dailyVolPct: number | null | undefined, cfgStopPct: number): number {
  if (dailyVolPct === null || dailyVolPct === undefined || !(dailyVolPct > 0)) return cfgStopPct;
  return Math.min(Math.max(1.5 * dailyVolPct, 0.5 * cfgStopPct), 2 * cfgStopPct);
}

export interface DailyReport {
  date: string;
  portfolio_value_eur: number;
  daily_pnl_eur: number;
  daily_pnl_percent: number;
  total_pnl_eur: number;
  total_pnl_percent: number;
  trades_today: number;
  best_performer: string;
  worst_performer: string;
  decisions: BotDecision[];
  market_sentiment: string;
}
