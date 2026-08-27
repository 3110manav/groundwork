import { sql } from "@groundwork/db";
import { computeCost, applyMargin } from "@groundwork/pricing";
import type { NormalizedUsage, ProviderId } from "@groundwork/providers";

/** Metered-mode markup. Moves with pricing; not a constant to set and forget. */
const MARGIN_PCT = 30;

export interface MeterArgs {
  siteId: string;
  conversationId: string | null;
  provider: ProviderId;
  model: string;
  usage: NormalizedUsage;
  billingMode: "byok" | "metered";
  latencyMs: number;
  semanticCacheHit: boolean;
  traceId?: string;
}

/**
 * Billing-grade. Written in the request path, transactionally, before we
 * consider the turn complete. Never derived from a trace store that can drop
 * spans — Langfuse is for debugging, this table is for invoices.
 */
export async function record(args: MeterArgs): Promise<void> {
  const cost = computeCost(args.provider, args.model, args.usage);

  const providerCost = cost?.totalUsd ?? 0;
  const charged =
    args.billingMode === "metered" ? applyMargin(providerCost, MARGIN_PCT) : 0;

  await sql`
    INSERT INTO usage_events (
      site_id, conversation_id, provider, model,
      input_tokens, cached_input_tokens, cache_write_tokens, output_tokens,
      unit_prices, provider_cost_usd, charged_amount_usd, billed_to,
      price_verified, latency_ms, cache_hit, semantic_cache_hit, trace_id
    ) VALUES (
      ${args.siteId}, ${args.conversationId}, ${args.provider}, ${args.model},
      ${args.usage.inputTokens}, ${args.usage.cachedInputTokens},
      ${args.usage.cacheWriteTokens}, ${args.usage.outputTokens},
      ${sql.json(cost?.priceSnapshot ?? {})}, ${providerCost}, ${charged},
      ${args.billingMode === "metered" ? "platform" : "tenant"},
      ${cost?.verified ?? false}, ${args.latencyMs},
      ${args.usage.cachedInputTokens > 0}, ${args.semanticCacheHit},
      ${args.traceId ?? null}
    )
  `;
}

/**
 * Hard monthly ceiling, defaulted ON for every site. A scraped widget must not
 * be able to run up an unbounded bill — in metered mode that is our money, and
 * in BYO-key mode the owner blames us regardless of whose key it was.
 */
export async function isOverBudget(siteId: string): Promise<boolean> {
  const rows = await sql<{ spent: string; budget: string }[]>`
    SELECT
      COALESCE(SUM(u.provider_cost_usd), 0)::text AS spent,
      s.monthly_budget_usd::text AS budget
    FROM sites s
    LEFT JOIN usage_events u
      ON u.site_id = s.id AND u.created_at >= date_trunc('month', now())
    WHERE s.id = ${siteId}
    GROUP BY s.monthly_budget_usd
  `;
  const row = rows[0];
  if (!row) return false;
  return Number(row.spent) >= Number(row.budget);
}
