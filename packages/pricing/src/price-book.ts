import type { ProviderId } from "@groundwork/providers";

/**
 * All rates are USD per 1,000,000 tokens.
 *
 * `verified` is load-bearing, not documentation. Provider pricing moves, and a
 * design doc is the wrong source of truth for billing code. Unverified entries
 * still compute a cost, but every usage row they produce is flagged so the
 * dashboard can label it as an estimate and so we never silently invoice from
 * a number nobody checked.
 */
// A type alias, not an interface: interfaces lack an implicit index signature
// and so are not assignable to postgres.js's JSONValue when we snapshot the
// price onto a usage row.
export type PriceEntry = {
  provider: ProviderId;
  model: string;
  input: number;
  output: number;
  /** Cached-read rate. Anthropic reads at 0.1x input. */
  cachedInput: number;
  /** Cache-write rate. Anthropic writes at 1.25x input on the 5m TTL. */
  cacheWrite: number;
  effectiveFrom: string; // ISO date
  verified: boolean;
  note?: string;
};

export const PRICE_BOOK: PriceEntry[] = [
  // ---- Anthropic: verified against current Anthropic documentation ----
  {
    provider: "anthropic",
    model: "claude-opus-5",
    input: 5.0,
    output: 25.0,
    cachedInput: 0.5,
    cacheWrite: 6.25,
    effectiveFrom: "2026-01-01",
    verified: true,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-5",
    input: 3.0,
    output: 15.0,
    cachedInput: 0.3,
    cacheWrite: 3.75,
    effectiveFrom: "2026-01-01",
    verified: true,
    note: "Introductory $2/$10 ran through 2026-08-31; add a dated entry if you need to reprice that window.",
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    input: 1.0,
    output: 5.0,
    cachedInput: 0.1,
    cacheWrite: 1.25,
    effectiveFrom: "2026-01-01",
    verified: true,
  },

  // ---- OpenRouter free tier: genuinely $0 for chat. ----
  // Free models rotate and are rate-limited; they exist for development, not
  // production traffic. Embeddings on OpenRouter are NOT free (they pass
  // through at the upstream rate) but run ~$0.02/MTok, i.e. cents per site.
  {
    provider: "openrouter",
    model: "openrouter/free",
    input: 0,
    output: 0,
    cachedInput: 0,
    cacheWrite: 0,
    effectiveFrom: "2026-01-01",
    verified: true,
    note: "Free tier. No explicit prompt caching on this surface, so cache columns always read zero.",
  },

  // ---- Gemini: PLACEHOLDERS. Do not ship billing on these. ----
  {
    provider: "gemini",
    model: "gemini-2.5-pro",
    input: 0,
    output: 0,
    cachedInput: 0,
    cacheWrite: 0,
    effectiveFrom: "2026-01-01",
    verified: false,
    note: "Fill from Google's current pricing page. Explicit caching also carries an hourly storage charge not modelled here.",
  },
  {
    provider: "gemini",
    model: "gemini-2.5-flash",
    input: 0,
    output: 0,
    cachedInput: 0,
    cacheWrite: 0,
    effectiveFrom: "2026-01-01",
    verified: false,
    note: "Fill from Google's current pricing page.",
  },
];

/** Most recent entry at or before `at`. */
export function lookupPrice(
  provider: ProviderId,
  model: string,
  at: Date = new Date(),
): PriceEntry | undefined {
  return PRICE_BOOK.filter(
    (p) => p.provider === provider && p.model === model && new Date(p.effectiveFrom) <= at,
  ).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
}
