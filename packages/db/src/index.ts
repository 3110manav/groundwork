import postgres from "postgres";

export const sql = postgres(process.env.DATABASE_URL ?? "", {
  max: 10,
  idle_timeout: 30,
  // halfvec/vector come back as strings; parse at the call site where the
  // dimension is known rather than globally.
  transform: { undefined: null },
});

export type ProviderId = "anthropic" | "gemini";
export type BillingMode = "byok" | "metered";

export interface SiteRow {
  id: string;
  org_id: string;
  site_key: string;
  billing_mode: BillingMode;
  provider: ProviderId;
  model: string;
  monthly_budget_usd: string;
  index_version: number;
}

/** pgvector wants a bracketed literal, not a JSON array. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
