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
}

export interface PortfolioSummary {
  total_value_eur: number;
  cash_eur: number;
  crypto_value_eur: number;
  pnl_eur: number;
  pnl_percent: number;
  holdings: PortfolioHolding[];
}

export interface RiskConfig {
  max_trades_per_day: number;
  max_position_size_pct: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  min_confidence: number;
  max_portfolio_crypto_pct: number;
}

export const RISK_CONFIGS: Record<RiskLevel, RiskConfig> = {
  conservative: {
    max_trades_per_day: 2,
    max_position_size_pct: 10,
    stop_loss_pct: 5,
    take_profit_pct: 10,
    min_confidence: 75,
    max_portfolio_crypto_pct: 50,
  },
  moderate: {
    max_trades_per_day: 5,
    max_position_size_pct: 20,
    stop_loss_pct: 8,
    take_profit_pct: 15,
    min_confidence: 65,
    max_portfolio_crypto_pct: 70,
  },
  aggressive: {
    max_trades_per_day: 8,
    max_position_size_pct: 30,
    stop_loss_pct: 12,
    take_profit_pct: 25,
    min_confidence: 55,
    max_portfolio_crypto_pct: 90,
  },
};

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
