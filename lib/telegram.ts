import axios from 'axios';
import { PortfolioSummary, BotDecision } from './types';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

export async function sendTelegramMessage(message: string): Promise<void> {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.log('[Telegram] Not configured, skipping message:', message.slice(0, 100));
    return;
  }

  const isLive = process.env.TRADING_MODE === 'live';
  // Prefix all paper trading messages so they're clearly identifiable
  const finalMessage = isLive ? message : `🧪 <b>[UAT/PAPER]</b>\n${message}`;

  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: finalMessage,
      parse_mode: 'HTML',
    });
  } catch (error) {
    console.error('Telegram error:', error);
  }
}

export async function sendDailyReport(
  portfolio: PortfolioSummary,
  decisions: BotDecision[],
  tradesCount: number,
  fearGreed: { value: number; label: string },
  marketSentiment: string
): Promise<void> {
  const now = new Date();
  const dateStr = format(now, "EEEE d MMMM yyyy", { locale: fr });
  const pnlEmoji = portfolio.pnl_eur >= 0 ? '📈' : '📉';
  const dailyPnlEmoji = portfolio.pnl_eur >= 0 ? '🟢' : '🔴';

  // Sort holdings by PnL
  const sortedHoldings = [...portfolio.holdings].sort(
    (a, b) => b.pnl_percent - a.pnl_percent
  );

  const holdingsText =
    sortedHoldings.length > 0
      ? sortedHoldings
          .map(h => {
            const emoji = h.pnl_percent >= 0 ? '🟢' : '🔴';
            return `  ${emoji} <b>${h.symbol}</b>: ${h.current_value_eur.toFixed(2)}€ (${h.pnl_percent >= 0 ? '+' : ''}${h.pnl_percent.toFixed(2)}%)`;
          })
          .join('\n')
      : '  💵 100% Cash EUR';

  const decisionsText =
    decisions.length > 0
      ? decisions
          .slice(0, 5)
          .map(d => {
            const actionEmoji =
              d.action === 'BUY' ? '🟢 ACHAT' : d.action === 'SELL' ? '🔴 VENTE' : '⏸ HOLD';
            return `  ${actionEmoji} <b>${d.symbol}</b> (${d.amount_eur.toFixed(0)}€, confiance: ${d.confidence}%)\n    └ ${d.reasoning.slice(0, 150)}...`;
          })
          .join('\n\n')
      : '  ⏸ Aucun trade exécuté aujourd\'hui';

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

  const message = `
🤖 <b>RAPPORT JOURNALIER — ${dateStr}</b>
━━━━━━━━━━━━━━━━━━━━

💼 <b>PORTEFEUILLE</b>
  Valeur totale: <b>${portfolio.total_value_eur.toFixed(2)}€</b>
  Cash disponible: ${portfolio.cash_eur.toFixed(2)}€
  P&L total: ${pnlEmoji} <b>${portfolio.pnl_eur >= 0 ? '+' : ''}${portfolio.pnl_eur.toFixed(2)}€ (${portfolio.pnl_percent >= 0 ? '+' : ''}${portfolio.pnl_percent.toFixed(2)}%)</b>

📊 <b>POSITIONS</b>
${holdingsText}

🌡️ <b>SENTIMENT MARCHÉ</b>
  Fear & Greed: ${fearEmoji} ${fearGreed.value}/100 (${fearGreed.label})
  ${marketSentiment}

🔄 <b>DÉCISIONS D'AUJOURD'HUI</b> (${tradesCount} trade${tradesCount > 1 ? 's' : ''})
${decisionsText}

━━━━━━━━━━━━━━━━━━━━
Mode: ${process.env.TRADING_MODE === 'live' ? '🔴 LIVE TRADING (Réel)' : '📝 PAPER TRADING (Fictif)'}
⏰ Prochain rapport: 18h00
  `.trim();

  await sendTelegramMessage(message);
}

export async function sendTradeAlert(
  decision: BotDecision,
  executed: boolean,
  price_eur: number,
  message: string
): Promise<void> {
  const actionEmoji =
    decision.action === 'BUY' ? '🟢 ACHAT' : decision.action === 'SELL' ? '🔴 VENTE' : '⏸';
  const statusEmoji = executed ? '✅' : '❌';

  const alert = `
${statusEmoji} <b>${actionEmoji} ${decision.symbol}</b>
  Montant: ${decision.amount_eur.toFixed(2)}€
  Prix: ${price_eur.toFixed(4)}€
  Confiance: ${decision.confidence}%
  Risque: ${decision.risk_score}/100
  ${decision.stop_loss_eur ? `Stop-loss: ${decision.stop_loss_eur.toFixed(4)}€` : ''}
  ${decision.take_profit_eur ? `Take-profit: ${decision.take_profit_eur.toFixed(4)}€` : ''}
  
💭 ${decision.reasoning.slice(0, 200)}
${message ? `\n📝 ${message}` : ''}
  `.trim();

  await sendTelegramMessage(alert);
}
