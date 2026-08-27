import OpenAI from "openai";
import {
  ProviderError,
  type ChatParams,
  type KeyValidation,
  type LLMProvider,
  type ModelInfo,
  type NormalizedUsage,
  type ProviderStreamEvent,
} from "./types.js";

/**
 * OpenRouter — one key, many upstream models, including a free tier.
 *
 * The API is OpenAI-compatible, so this adapter is thin. What it is NOT is a
 * cheap way to get the caching story: free models route to whichever upstream
 * provider is available, and none of them accept an explicit cache breakpoint.
 * `SystemBlock.cacheable` is therefore honoured only in ORDER (stable content
 * first, so any upstream implicit prefix caching can still hit) and never as an
 * explicit control. Treat free-tier traffic as uncached and do not read
 * anything into the cache columns it produces.
 */
const BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Free models rotate and get deprecated without notice, so this list is a
 * convenience for the dashboard picker, not a contract. `openrouter/free` is
 * the default deliberately: it auto-routes across free models, which is the
 * only thing that reliably survives their rate limits and outages.
 */
const MODELS: Record<string, ModelInfo> = {
  "openrouter/free": {
    id: "openrouter/free",
    displayName: "OpenRouter Auto (free)",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    minCacheablePrefixTokens: Number.MAX_SAFE_INTEGER, // never explicitly cacheable
  },
  "minimax/minimax-m2.7:free": {
    id: "minimax/minimax-m2.7:free",
    displayName: "MiniMax M2.7 (free)",
    contextWindow: 196_608,
    maxOutputTokens: 8_192,
    minCacheablePrefixTokens: Number.MAX_SAFE_INTEGER,
  },
  "z-ai/glm-5.2:free": {
    id: "z-ai/glm-5.2:free",
    displayName: "GLM 5.2 (free)",
    contextWindow: 256_000,
    maxOutputTokens: 8_192,
    minCacheablePrefixTokens: Number.MAX_SAFE_INTEGER,
  },
  "google/gemma-4-31b-it:free": {
    id: "google/gemma-4-31b-it:free",
    displayName: "Gemma 4 31B (free)",
    contextWindow: 262_144,
    maxOutputTokens: 8_192,
    minCacheablePrefixTokens: Number.MAX_SAFE_INTEGER,
  },
};

function client(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: BASE_URL,
    maxRetries: 2,
    defaultHeaders: {
      // OpenRouter attribution headers — optional, but they keep the account
      // visible in their dashboard and are used for free-tier accounting.
      "HTTP-Referer": process.env.PUBLIC_API_URL ?? "http://localhost:8787",
      "X-Title": "groundwork",
    },
  });
}

function mapError(err: unknown): ProviderError {
  if (err instanceof OpenAI.APIError) {
    const detail = err.message;
    if (err.status === 401 || err.status === 403)
      return new ProviderError("provider_auth", "openrouter", detail);
    if (err.status === 402)
      return new ProviderError("provider_quota", "openrouter", detail);
    if (err.status === 429) {
      // Two very different 429s share a status code. A burst limit is
      // retryable and the model chain routes around it. A DAILY quota
      // ("free-models-per-day") is exhausted until midnight UTC — retrying is
      // pointless, and the site owner is the one who can fix it (add credits
      // or attach a paid key), so it must surface as provider_quota, which is
      // owner-actionable, not as "try again in a moment".
      if (/per-day|daily/i.test(detail))
        return new ProviderError("provider_quota", "openrouter", detail);
      return new ProviderError("rate_limited", "openrouter", detail, true);
    }
    if (err.status && err.status >= 500)
      return new ProviderError("upstream_unavailable", "openrouter", detail, true);
    return new ProviderError("invalid_request", "openrouter", detail);
  }
  if (err instanceof OpenAI.APIConnectionError)
    return new ProviderError("upstream_unavailable", "openrouter", err.message, true);
  return new ProviderError("internal", "openrouter", String(err));
}

export const openrouterProvider: LLMProvider = {
  id: "openrouter",

  async *chat(apiKey, params: ChatParams): AsyncIterable<ProviderStreamEvent> {
    try {
      const stream = await client(apiKey).chat.completions.create(
        {
          model: params.model,
          max_tokens: params.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            { role: "system", content: params.system.map((b) => b.text).join("\n\n") },
            ...params.messages.map((m) => ({ role: m.role, content: m.content }) as const),
          ],
        },
        { signal: params.signal },
      );

      let usage: NormalizedUsage = {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      };
      let finishReason: "stop" | "length" | "refusal" = "stop";

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield { type: "delta", text: delta };

        const reason = chunk.choices[0]?.finish_reason;
        if (reason === "length") finishReason = "length";
        else if (reason === "content_filter") finishReason = "refusal";

        // Only the final chunk carries usage (stream_options.include_usage).
        if (chunk.usage) {
          const prompt = chunk.usage.prompt_tokens ?? 0;
          const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          // Same asymmetry as Gemini: OpenAI-shaped prompt_tokens INCLUDES
          // cached tokens, while our contract says inputTokens is the uncached
          // remainder. Subtract, or every cached turn is billed twice.
          usage = {
            inputTokens: Math.max(0, prompt - cached),
            cachedInputTokens: cached,
            cacheWriteTokens: 0, // no explicit cache writes on this surface
            outputTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
      }

      yield { type: "done", usage, finishReason };
    } catch (err) {
      throw mapError(err);
    }
  },

  async countTokens(_apiKey, params) {
    // OpenRouter exposes no token-counting endpoint. Estimate, and rely on the
    // usage reported after the fact for anything that must be exact.
    const text =
      params.system.map((b) => b.text).join("\n") +
      params.messages.map((m) => m.content).join("\n");
    return Math.ceil(text.length / 3.8);
  },

  async listModels(apiKey) {
    // Live list, for the same reason as Gemini: free model ids rotate and get
    // deprecated without notice, so a hardcoded table goes stale silently.
    try {
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok) {
        const body = (await res.json()) as {
          data?: {
            id: string; name?: string; context_length?: number;
            pricing?: { prompt?: string; completion?: string };
            architecture?: { output_modalities?: string[] };
          }[];
        };
        const models = (body.data ?? [])
          .filter((m) => (m.architecture?.output_modalities ?? ["text"]).includes("text"))
          .map((m) => {
            const free = m.pricing?.prompt === "0" && m.pricing?.completion === "0";
            return {
              id: m.id,
              displayName: `${m.name ?? m.id}${free ? " (free)" : ""}`,
              contextWindow: m.context_length ?? 128_000,
              maxOutputTokens: 8192,
              // No explicit cache breakpoint on this surface.
              minCacheablePrefixTokens: Number.MAX_SAFE_INTEGER,
            };
          });
        // Free models first — they are what a trial site should default to.
        const freeFirst = models.filter((m) => m.displayName.endsWith("(free)"));
        const rest = models.filter((m) => !m.displayName.endsWith("(free)"));
        if (models.length > 0) return [...freeFirst, ...rest].slice(0, 200);
      }
    } catch {
      /* fall through */
    }
    return Object.values(MODELS);
  },

  async validateKey(apiKey): Promise<KeyValidation> {
    try {
      const res = await fetch(`${BASE_URL}/key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return { valid: false, reason: `HTTP ${res.status}` };
      return { valid: true };
    } catch (err) {
      return { valid: false, reason: String(err) };
    }
  },
};

export const OPENROUTER_MODELS = MODELS;
