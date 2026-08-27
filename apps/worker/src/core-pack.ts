import { getProvider, ProviderError, type LLMProvider, type ProviderId } from "@groundwork/providers";
import type { ExtractedPage } from "./extract.js";

/**
 * The site "core pack": a deliberately-sized, stable system prefix.
 *
 * Two jobs, and the second is the non-obvious one:
 *   1. Answer common questions before retrieval even matters.
 *   2. Give prompt caching something worth caching. A bare "you are a helpful
 *      assistant for Acme" line is ~50 tokens and falls under every provider's
 *      minimum cacheable prefix, so it caches never. 2-4K tokens caches always.
 *
 * Generated ONCE per site, because its quality compounds into every future
 * conversation. Runs through the provider registry rather than a hard-coded
 * SDK, so the ingest model can differ from the chat model.
 */
const TARGET_TOKENS = 3000;
const MIN_TOKENS = 400;

function prompt(siteName: string, corpus: string): string {
  return `Below are pages from ${siteName}'s website. Write a reference brief of roughly ${TARGET_TOKENS} tokens that a support assistant can rely on without retrieving anything.

Include, where the source supports it: what the company does and for whom; the product or service lineup with the distinctions between tiers; pricing and plan structure; the 15-20 questions a visitor is most likely to ask, with direct answers; key policies (returns, shipping, support hours, SLAs); a glossary of any product-specific terms; and how to reach a human.

Rules:
- State only what the pages support. Never infer a price, a policy, or an availability claim.
- Write flat prose and short lists. No preamble, no meta-commentary, no markdown headers deeper than ##.
- Prefer specifics over adjectives: figures, names, limits.

<pages>
${corpus}
</pages>`;
}

async function generate(
  provider: LLMProvider,
  apiKey: string,
  model: string,
  siteName: string,
  corpus: string,
): Promise<string> {
  let out = "";
  for await (const ev of provider.chat(apiKey, {
    model,
    maxTokens: 8000,
    effort: "high",
    system: [
      {
        text: "You write compact reference briefs that another AI assistant will use as its only standing knowledge about a company. Precision matters more than prose.",
      },
    ],
    messages: [{ role: "user", content: prompt(siteName, corpus) }],
  })) {
    if (ev.type === "delta") out += ev.text;
  }
  return out;
}

/**
 * Default ingest model chain.
 *
 * Free-model rate limits are enforced per upstream provider, not per account,
 * so retrying the SAME model through a 429 is close to useless — observed
 * directly: four attempts with exponential backoff all failed on one model
 * while three others answered immediately, on an account with $0.0002 of
 * lifetime usage. Falling ACROSS models is what actually works.
 *
 * Deliberately not `openrouter/free`: that auto-router once sent this prompt
 * to a content-safety classifier, which returned "User Safety: safe".
 */
const DEFAULT_INGEST_MODELS = [
  "minimax/minimax-m3:free",
  "minimax/minimax-m2.7:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "z-ai/glm-5.2:free",
];

/**
 * Try every (key, model) pair.
 *
 * OpenRouter's free quota is per ACCOUNT, and the daily one
 * ("free-models-per-day") exhausts every free model on that key at once — so
 * walking the model chain alone gets nowhere. A second key has its own quota,
 * which is why the key list matters as much as the model list here.
 *
 * `provider_quota` is advanced past too: it is not retryable on the same key,
 * but the next key may well have quota left.
 */
async function acrossKeysAndModels<T>(
  keys: string[],
  models: string[],
  fn: (key: string, model: string) => Promise<T>,
): Promise<{ result: T; model: string }> {
  let lastErr: unknown;
  for (const [i, key] of keys.entries()) {
    for (const model of models) {
      try {
        return { result: await fn(key, model), model };
      } catch (err) {
        lastErr = err;
        const code = err instanceof ProviderError ? err.code : "internal";
        const worthAdvancing =
          err instanceof ProviderError && (err.retryable || code === "provider_quota");
        if (!worthAdvancing) throw err;
        console.warn(`  core pack: key#${i + 1} ${model} -> ${code}, advancing`);
      }
    }
  }
  throw lastErr;
}

export async function generateCorePack(
  pages: ExtractedPage[],
  siteName: string,
): Promise<{ content: string; model: string }> {
  const providerId = (process.env.INGEST_PROVIDER ?? "openrouter") as ProviderId;
  const models = (process.env.INGEST_CORE_PACK_MODEL ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const chain = models.length > 0 ? models : DEFAULT_INGEST_MODELS;
  // Comma-separated, same shape as PLATFORM_OPENROUTER_KEYS. Each key carries
  // its own daily quota.
  const apiKeys = (
    process.env.INGEST_API_KEYS ||
    process.env.INGEST_API_KEY ||
    process.env.PLATFORM_OPENROUTER_KEYS ||
    process.env.OPENROUTER_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    ""
  )
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (apiKeys.length === 0) throw new Error("no ingest API key configured");

  // Feed the highest-signal pages. Homepage, pricing, about, docs index first.
  const ranked = [...pages].sort((a, b) => score(b.url) - score(a.url)).slice(0, 40);
  const corpus = ranked
    .map((p) => `## ${p.title}\n<${p.url}>\n${p.markdown.slice(0, 4000)}`)
    .join("\n\n---\n\n");

  const provider = getProvider(providerId);
  const { result: content, model } = await acrossKeysAndModels(apiKeys, chain, (k, m) =>
    generate(provider, k, m, siteName, corpus),
  );
  const trimmed = content.trim();

  // Guard, because a bad core pack poisons EVERY future conversation on this
  // site and does so silently. Observed once for real: `openrouter/free`
  // auto-routed this prompt to a content-safety classifier, which returned
  // "User Safety: safe" — five tokens, stored without complaint, and it would
  // have become the assistant's entire standing knowledge of the company.
  // Pin a known-good chat model for ingest rather than relying on a router.
  const estimated = Math.ceil(trimmed.length / 3.8);
  if (estimated < MIN_TOKENS) {
    throw new Error(
      `core pack from ${model} is implausibly short (${estimated} tokens, need >= ${MIN_TOKENS}). ` +
        `Got: ${JSON.stringify(trimmed.slice(0, 200))}. ` +
        `Set INGEST_CORE_PACK_MODEL to a pinned chat model.`,
    );
  }

  return { content: trimmed, model };
}

function score(url: string): number {
  const path = new URL(url).pathname.toLowerCase();
  if (path === "/" || path === "") return 100;
  if (/pricing|plans/.test(path)) return 90;
  if (/about|company/.test(path)) return 80;
  if (/faq|help|support/.test(path)) return 75;
  if (/docs|guide/.test(path)) return 60;
  if (/blog|news|press/.test(path)) return 10;
  return 40;
}
