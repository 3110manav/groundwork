import Anthropic from "@anthropic-ai/sdk";
import {
  ProviderError,
  type ChatParams,
  type KeyValidation,
  type LLMProvider,
  type ModelInfo,
  type NormalizedUsage,
  type ProviderStreamEvent,
  type SystemBlock,
} from "./types.js";

/**
 * Minimum cacheable prefix, per model. Below these, `cache_control` is accepted
 * but silently does nothing — no error, just cache_creation_input_tokens: 0.
 * This is why the site "core pack" is deliberately sized at 2–4K tokens.
 */
const MODELS: Record<string, ModelInfo> = {
  "claude-opus-5": {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    minCacheablePrefixTokens: 512,
  },
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    minCacheablePrefixTokens: 1024,
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    // Note the trap: routing cheap turns here only pays off if the prefix
    // clears 4096 tokens. Below that, Haiku traffic is entirely uncached.
    minCacheablePrefixTokens: 4096,
  },
};

/**
 * Render our SystemBlock[] into Anthropic's system parameter, putting the
 * cache breakpoint on the LAST block marked cacheable. Anthropic renders
 * tools -> system -> messages, so a breakpoint here covers everything above it.
 */
function toSystem(blocks: SystemBlock[]): Anthropic.TextBlockParam[] {
  let lastCacheable = -1;
  blocks.forEach((b, i) => {
    if (b.cacheable) lastCacheable = i;
  });

  return blocks.map((b, i) => {
    const block: Anthropic.TextBlockParam = { type: "text", text: b.text };
    if (i === lastCacheable) {
      // 1h TTL costs 2x to write vs 1.25x, but survives traffic gaps. The
      // caller picks by traffic volume; 5m is the safer default for the tail.
      block.cache_control = { type: "ephemeral" };
    }
    return block;
  });
}

function mapError(err: unknown): ProviderError {
  if (err instanceof Anthropic.APIError) {
    const detail = err.message;
    if (err instanceof Anthropic.AuthenticationError)
      return new ProviderError("provider_auth", "anthropic", detail);
    if (err instanceof Anthropic.PermissionDeniedError)
      return new ProviderError("provider_auth", "anthropic", detail);
    if (err instanceof Anthropic.RateLimitError)
      return new ProviderError("rate_limited", "anthropic", detail, true);
    if (err.status && err.status >= 500)
      return new ProviderError("upstream_unavailable", "anthropic", detail, true);
    if (err.status === 400 && /credit|billing|quota/i.test(detail))
      return new ProviderError("provider_quota", "anthropic", detail);
    return new ProviderError("invalid_request", "anthropic", detail);
  }
  if (err instanceof Anthropic.APIConnectionError)
    return new ProviderError("upstream_unavailable", "anthropic", err.message, true);
  return new ProviderError("internal", "anthropic", String(err));
}

export const anthropicProvider: LLMProvider = {
  id: "anthropic",

  async *chat(apiKey, params: ChatParams): AsyncIterable<ProviderStreamEvent> {
    const client = new Anthropic({ apiKey, maxRetries: 2 });

    try {
      const stream = client.messages.stream(
        {
          model: params.model,
          max_tokens: params.maxTokens,
          system: toSystem(params.system),
          messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
          // Thinking stays ON. Disabling it on Opus 5 can leak <thinking> tags
          // into the visible response; low effort is the cheaper, safer lever
          // and keeps a chat widget's latency acceptable.
          thinking: { type: "adaptive" },
          output_config: { effort: params.effort ?? "low" },
        },
        { signal: params.signal },
      );

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "delta", text: event.delta.text };
        }
      }

      const final = await stream.finalMessage();
      const u = final.usage;

      // Anthropic already reports input_tokens as the UNCACHED remainder,
      // so this is a straight pass-through. Contrast with gemini.ts.
      const usage: NormalizedUsage = {
        inputTokens: u.input_tokens ?? 0,
        cachedInputTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
      };

      const finishReason =
        final.stop_reason === "max_tokens"
          ? "length"
          : final.stop_reason === "refusal"
            ? "refusal"
            : "stop";

      yield { type: "done", usage, finishReason };
    } catch (err) {
      throw mapError(err);
    }
  },

  async countTokens(apiKey, params) {
    const client = new Anthropic({ apiKey, maxRetries: 1 });
    try {
      const res = await client.messages.countTokens({
        model: params.model,
        system: toSystem(params.system),
        messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
      });
      return res.input_tokens;
    } catch (err) {
      throw mapError(err);
    }
  },

  async listModels() {
    return Object.values(MODELS);
  },

  async validateKey(apiKey): Promise<KeyValidation> {
    const client = new Anthropic({ apiKey, maxRetries: 0 });
    try {
      // Cheapest possible round trip that proves the key works.
      await client.models.list({ limit: 1 });
      return { valid: true };
    } catch (err) {
      return { valid: false, reason: mapError(err).message };
    }
  },
};

export const ANTHROPIC_MODELS = MODELS;
