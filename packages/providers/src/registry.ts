import { anthropicProvider, ANTHROPIC_MODELS } from "./anthropic.js";
import { geminiProvider, GEMINI_MODELS } from "./gemini.js";
import { openrouterProvider, OPENROUTER_MODELS } from "./openrouter.js";
import type { LLMProvider, ModelInfo, ProviderId } from "./types.js";

const PROVIDERS: Record<ProviderId, LLMProvider> = {
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  openrouter: openrouterProvider,
};

export function getProvider(id: ProviderId): LLMProvider {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

export const ALL_MODELS: Record<ProviderId, Record<string, ModelInfo>> = {
  anthropic: ANTHROPIC_MODELS,
  gemini: GEMINI_MODELS,
  openrouter: OPENROUTER_MODELS,
};

export function getModelInfo(provider: ProviderId, model: string): ModelInfo | undefined {
  return ALL_MODELS[provider][model];
}

/**
 * Default per provider. Site owners override this in their dashboard, so this
 * only decides what a fresh site starts on — which in metered mode is OUR cost,
 * and therefore sets gross margin. Revisit alongside pricing.
 */
export const DEFAULT_MODEL: Record<ProviderId, string> = {
  anthropic: "claude-opus-5",
  gemini: "gemini-3.6-flash",
  // Auto-routes across free models, which is the only thing that reliably
  // survives their rate limits and outages.
  openrouter: "openrouter/free",
};
