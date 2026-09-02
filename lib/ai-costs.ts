import { sql, sqlForContext, DbContext } from './db';

// OpenAI pricing (USD per 1M tokens) — updated 2024
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o':       { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':  { input: 0.15,  output: 0.60  },
};

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export function calculateCostUSD(model: string, usage: TokenUsage): number {
  const pricing = PRICING[model] ?? PRICING['gpt-4o-mini'];
  const inputCost  = (usage.prompt_tokens     / 1_000_000) * pricing.input;
  const outputCost = (usage.completion_tokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

export async function logAICost(
  model: string,
  usage: TokenUsage,
  eurUsdRate: number,
  cycleId?: string,
  purpose = 'analysis'
): Promise<void> {
  try {
    const costUsd = calculateCostUSD(model, usage);
    const costEur = costUsd * eurUsdRate;

    await sql`
      INSERT INTO ai_costs
        (cycle_id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, cost_eur, purpose)
      VALUES
        (${cycleId ?? null}, ${model}, ${usage.prompt_tokens}, ${usage.completion_tokens},
         ${usage.total_tokens}, ${costUsd}, ${costEur}, ${purpose})
    `;
  } catch (error) {
    // Non-blocking — don't crash the bot if cost tracking fails
    console.error('Failed to log AI cost:', error);
  }
}

export async function getTotalAICosts(ctx: DbContext = 'uat'): Promise<{
  total_usd: number;
  total_eur: number;
  total_tokens: number;
  calls_count: number;
  by_model: Array<{ model: string; calls: number; tokens: number; cost_usd: number; cost_eur: number }>;
  last_30_days_usd: number;
}> {
  try {
    const db = sqlForContext(ctx);

    const totals = (await db`
      SELECT
        COUNT(*) as calls_count,
        SUM(total_tokens) as total_tokens,
        SUM(cost_usd) as total_usd,
        SUM(cost_eur) as total_eur
      FROM ai_costs
    `) as Array<Record<string, unknown>>;

    const byModel = (await db`
      SELECT
        model,
        COUNT(*) as calls,
        SUM(total_tokens) as tokens,
        SUM(cost_usd) as cost_usd,
        SUM(cost_eur) as cost_eur
      FROM ai_costs
      GROUP BY model
      ORDER BY cost_usd DESC
    `) as Array<Record<string, unknown>>;

    const last30 = (await db`
      SELECT SUM(cost_usd) as total_usd
      FROM ai_costs
      WHERE created_at > NOW() - INTERVAL '30 days'
    `) as Array<Record<string, unknown>>;

    return {
      total_usd:       parseFloat(String(totals[0]?.total_usd ?? 0)),
      total_eur:       parseFloat(String(totals[0]?.total_eur ?? 0)),
      total_tokens:    parseInt(String(totals[0]?.total_tokens ?? 0)),
      calls_count:     parseInt(String(totals[0]?.calls_count ?? 0)),
      by_model:        byModel.map(r => ({
        model:    String(r.model),
        calls:    parseInt(String(r.calls)),
        tokens:   parseInt(String(r.tokens)),
        cost_usd: parseFloat(String(r.cost_usd)),
        cost_eur: parseFloat(String(r.cost_eur)),
      })),
      last_30_days_usd: parseFloat(String(last30[0]?.total_usd ?? 0)),
    };
  } catch {
    return { total_usd: 0, total_eur: 0, total_tokens: 0, calls_count: 0, by_model: [], last_30_days_usd: 0 };
  }
}
