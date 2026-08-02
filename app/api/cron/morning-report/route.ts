import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { getMarketData, getFearGreedIndex, getEurUsdRate, getCryptoNews } from '@/lib/market-data';
import { getPortfolioSummary } from '@/lib/portfolio';
import { WATCHLIST_COINS } from '@/lib/market-data';
import { sendTelegramMessage } from '@/lib/telegram';
import OpenAI from 'openai';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { logAICost } from '@/lib/ai-costs';

export const maxDuration = 45;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface MarketReport {
  date: string;
  market_score: number;           // 0-100
  market_score_label: string;
  market_score_color: string;
  outlook: string;                // 'bullish' | 'bearish' | 'neutral' | 'volatile'
  summary: string;                // 2-3 phrases résumé
  key_points: string[];           // 3-5 points clés
  opportunities: string[];        // cryptos à surveiller
  risks: string[];                // risques du jour
  advice: string;                 // conseil du bot pour la journée
  fear_greed: number;
  fear_greed_label: string;
  eur_usd: number;
  top_movers: { symbol: string; change: number }[];
  created_at: string;
}

async function generateMorningReport(
  marketData: ReturnType<typeof Array.prototype.slice>,
  fearGreed: { value: number; label: string },
  eurUsd: number,
  news: { title: string; sentiment: string }[],
  portfolio: { total_value_eur: number; pnl_eur: number; pnl_percent: number }
): Promise<MarketReport> {
  const topMovers = [...marketData]
    .sort((a, b) => Math.abs(b.change_24h) - Math.abs(a.change_24h))
    .slice(0, 5)
    .map((m: { symbol: string; change_24h: number }) => ({ symbol: m.symbol, change: m.change_24h }));

  const marketSummary = marketData.slice(0, 10).map((m: {
    symbol: string; price_eur: number; change_24h: number; change_7d: number
  }) =>
    `${m.symbol}: ${m.price_eur.toFixed(2)}€ (24h: ${m.change_24h.toFixed(1)}%, 7j: ${m.change_7d.toFixed(1)}%)`
  ).join('\n');

  const newsSummary = news.slice(0, 8).map(n =>
    `[${n.sentiment.toUpperCase()}] ${n.title}`
  ).join('\n');

  const prompt = `Tu es un analyste crypto senior. Génère un rapport matinal du marché crypto pour aujourd'hui.

DONNÉES ACTUELLES:
Fear & Greed Index: ${fearGreed.value}/100 (${fearGreed.label})
Taux EUR/USD: ${eurUsd}
Portefeuille actuel: ${portfolio.total_value_eur.toFixed(2)}€ (${portfolio.pnl_percent >= 0 ? '+' : ''}${portfolio.pnl_percent.toFixed(2)}%)

MARCHÉS:
${marketSummary}

ACTUALITÉS DU MATIN:
${newsSummary}

Génère un rapport JSON structuré et précis:
{
  "market_score": <0-100, score global du marché aujourd'hui: 0=catastrophique, 50=neutre, 100=excellent>,
  "market_score_label": <"Excellent" | "Bon" | "Neutre" | "Prudence" | "Danger">,
  "outlook": <"bullish" | "bearish" | "neutral" | "volatile">,
  "summary": "<2-3 phrases résumant la situation du marché aujourd'hui>",
  "key_points": [
    "<point clé 1 sur le marché>",
    "<point clé 2>",
    "<point clé 3>"
  ],
  "opportunities": [
    "<crypto/secteur à surveiller aujourd'hui avec raison brève>"
  ],
  "risks": [
    "<risque principal du jour>"
  ],
  "advice": "<conseil concret et actionnable pour aujourd'hui en 1-2 phrases>"
}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Tu es un analyste crypto expert. Réponds UNIQUEMENT en JSON valide.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    max_tokens: 800,
    response_format: { type: 'json_object' },
  });

  // Log AI cost
  if (response.usage) {
    await logAICost('gpt-4o-mini', response.usage, eurUsd, undefined, 'morning-report');
  }

  const parsed = JSON.parse(response.choices[0].message.content ?? '{}');

  const scoreColor =
    parsed.market_score >= 70 ? 'green' :
    parsed.market_score >= 50 ? 'blue' :
    parsed.market_score >= 35 ? 'yellow' : 'red';

  return {
    date: format(new Date(), "EEEE d MMMM yyyy", { locale: fr }),
    market_score: parsed.market_score ?? 50,
    market_score_label: parsed.market_score_label ?? 'Neutre',
    market_score_color: scoreColor,
    outlook: parsed.outlook ?? 'neutral',
    summary: parsed.summary ?? '',
    key_points: parsed.key_points ?? [],
    opportunities: parsed.opportunities ?? [],
    risks: parsed.risks ?? [],
    advice: parsed.advice ?? '',
    fear_greed: fearGreed.value,
    fear_greed_label: fearGreed.label,
    eur_usd: eurUsd,
    top_movers: topMovers,
    created_at: new Date().toISOString(),
  };
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [marketData, fearGreed, eurUsd, news] = await Promise.all([
      getMarketData(WATCHLIST_COINS),
      getFearGreedIndex(),
      getEurUsdRate(),
      getCryptoNews(),
    ]);

    const portfolio = await getPortfolioSummary(marketData);
    const report = await generateMorningReport(marketData, fearGreed, eurUsd, news, portfolio);

    // Save to DB
    await sql`
      INSERT INTO morning_reports (report_date, data, created_at)
      VALUES (CURRENT_DATE, ${JSON.stringify(report)}, NOW())
      ON CONFLICT (report_date) DO UPDATE SET data = ${JSON.stringify(report)}, created_at = NOW()
    `;

    // Send Telegram
    const outlookEmoji: Record<string, string> = {
      bullish: '📈', bearish: '📉', neutral: '➡️', volatile: '⚡'
    };
    const scoreEmoji =
      report.market_score >= 70 ? '🟢' :
      report.market_score >= 50 ? '🔵' :
      report.market_score >= 35 ? '🟡' : '🔴';

    const telegramMsg = `
🌅 <b>RAPPORT MATINAL — ${report.date}</b>
━━━━━━━━━━━━━━━━━━━━

${scoreEmoji} <b>Score de marché: ${report.market_score}/100 — ${report.market_score_label}</b>
${outlookEmoji[report.outlook] ?? '➡️'} Outlook: <b>${report.outlook.toUpperCase()}</b>

📋 <b>RÉSUMÉ</b>
${report.summary}

🔑 <b>POINTS CLÉS</b>
${report.key_points.map(p => `  • ${p}`).join('\n')}

🎯 <b>OPPORTUNITÉS</b>
${report.opportunities.slice(0, 3).map(o => `  • ${o}`).join('\n')}

⚠️ <b>RISQUES DU JOUR</b>
${report.risks.slice(0, 2).map(r => `  • ${r}`).join('\n')}

💡 <b>CONSEIL DU BOT</b>
${report.advice}

📊 Fear & Greed: ${report.fear_greed}/100 (${report.fear_greed_label})
━━━━━━━━━━━━━━━━━━━━
⏰ Prochain rapport: 18h00
    `.trim();

    await sendTelegramMessage(telegramMsg);

    return NextResponse.json({ success: true, report });
  } catch (error) {
    console.error('Morning report error:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
