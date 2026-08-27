import type { NormalizedUsage, ProviderId } from "@groundwork/providers";
import { lookupPrice, type PriceEntry } from "./price-book.js";

export interface CostBreakdown {
  inputUsd: number;
  cachedInputUsd: number;
  cacheWriteUsd: number;
  outputUsd: number;
  totalUsd: number;
  /** Snapshotted onto the usage row so a later price change cannot rewrite history. */
  priceSnapshot: PriceEntry;
  /** False when computed from an unverified price entry. Surface it in the UI. */
  verified: boolean;
}

const PER_TOKEN = 1_000_000;

export function computeCost(
  provider: ProviderId,
  model: string,
  usage: NormalizedUsage,
  at: Date = new Date(),
): CostBreakdown | null {
  const price = lookupPrice(provider, model, at);
  if (!price) return null;

  const inputUsd = (usage.inputTokens / PER_TOKEN) * price.input;
  const cachedInputUsd = (usage.cachedInputTokens / PER_TOKEN) * price.cachedInput;
  const cacheWriteUsd = (usage.cacheWriteTokens / PER_TOKEN) * price.cacheWrite;
  const outputUsd = (usage.outputTokens / PER_TOKEN) * price.output;

  return {
    inputUsd,
    cachedInputUsd,
    cacheWriteUsd,
    outputUsd,
    totalUsd: inputUsd + cachedInputUsd + cacheWriteUsd + outputUsd,
    priceSnapshot: price,
    verified: price.verified,
  };
}

/**
 * What we charge in metered mode, versus what it cost us.
 * In BYO-key mode charged is always 0 — the owner pays their provider directly.
 */
export function applyMargin(providerCostUsd: number, marginPct: number): number {
  return providerCostUsd * (1 + marginPct / 100);
}

/** What the caching work actually bought, for the dashboard headline. */
export function cacheSavingsUsd(
  provider: ProviderId,
  model: string,
  usage: NormalizedUsage,
  at: Date = new Date(),
): number {
  const price = lookupPrice(provider, model, at);
  if (!price) return 0;
  const paid = (usage.cachedInputTokens / PER_TOKEN) * price.cachedInput;
  const wouldHavePaid = (usage.cachedInputTokens / PER_TOKEN) * price.input;
  return wouldHavePaid - paid;
}
