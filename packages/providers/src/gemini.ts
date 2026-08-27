import { GoogleGenAI } from "@google/genai";
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
 * Fallback model list ONLY.
 *
 * A hardcoded model list is a guess with an expiry date, and this one expired:
 * `gemini-2.5-flash` was retired for new users, which 404'd — and because
 * validateKey() probed that exact model, it rejected every valid Gemini key
 * with a message about a model the user never chose. Model ids belong to the
 * provider, so listModels() asks the API and this table is only what we fall
 * back to when that call fails.
 */
const FALLBACK_MODELS: Record<string, ModelInfo> = {
  "gemini-3.6-flash": {
    id: "gemini-3.6-flash",
    displayName: "Gemini 3.6 Flash",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    minCacheablePrefixTokens: 1024,
  },
  "gemini-3.6-pro": {
    id: "gemini-3.6-pro",
    displayName: "Gemini 3.6 Pro",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    minCacheablePrefixTokens: 2048,
  },
};

/** Strip the "models/" prefix the API returns. */
function bareId(name: string): string {
  return name.replace(/^models\//, "");
}

function titleCase(id: string): string {
  return id
    .split("-")
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function mapError(err: unknown): ProviderError {
  const msg = err instanceof Error ? err.message : String(err);
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status: unknown }).status)
      : undefined;

  if (status === 401 || status === 403 || /API key not valid|PERMISSION_DENIED/i.test(msg))
    return new ProviderError("provider_auth", "gemini", msg);
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) {
    // Gemini returns 429 for both "too fast" and "this model has no free-tier
    // allowance at all". The second is not retryable and the owner is the only
    // one who can fix it, so showing a visitor "try again in a moment" was
    // wrong — that is what `limit: 0` on an image model produced.
    const perDay = /PerDay|per-day|daily/i.test(msg);
    const zeroAllowance = /limit:\s*0\b/.test(msg);
    if (perDay || zeroAllowance) {
      const model = msg.match(/model:\s*([\w.-]+)/)?.[1];
      return new ProviderError(
        "provider_quota",
        "gemini",
        zeroAllowance && model
          ? `${model} has no free-tier allowance (limit: 0) — it needs a paid plan, or pick a different model`
          : msg,
      );
    }
    return new ProviderError("rate_limited", "gemini", msg, true);
  }
  if (status !== undefined && status >= 500)
    return new ProviderError("upstream_unavailable", "gemini", msg, true);
  if (/SAFETY|blocked/i.test(msg)) return new ProviderError("content_refused", "gemini", msg);
  return new ProviderError("invalid_request", "gemini", msg);
}

export const geminiProvider: LLMProvider = {
  id: "gemini",

  async *chat(apiKey, params: ChatParams): AsyncIterable<ProviderStreamEvent> {
    const ai = new GoogleGenAI({ apiKey });

    // Gemini caches the prefix implicitly, with no per-request opt-in, so our
    // cacheable blocks just need to come FIRST in systemInstruction and stay
    // byte-identical between turns.
    //
    // The explicit path (ai.caches.create -> config.cachedContent) buys a
    // bigger discount but charges STORAGE PER HOUR whether or not the cache is
    // read. For a low-traffic site that costs more than it saves, so it is a
    // per-site decision gated on requests/hour — not a global default.
    // See PromptCachePolicy in apps/api/src/lib/prompt.ts.
    const systemInstruction = params.system.map((b) => b.text).join("\n\n");

    try {
      const stream = await ai.models.generateContentStream({
        model: params.model,
        contents: params.messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        config: {
          systemInstruction,
          maxOutputTokens: params.maxTokens,
          abortSignal: params.signal,
        },
      });

      let usage: NormalizedUsage = {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      };
      let finishReason: "stop" | "length" | "refusal" = "stop";

      for await (const chunk of stream) {
        const text = chunk.text;
        if (text) yield { type: "delta", text };

        const m = chunk.usageMetadata;
        if (m) {
          const prompt = m.promptTokenCount ?? 0;
          const cached = m.cachedContentTokenCount ?? 0;
          // THE ASYMMETRY. Gemini's promptTokenCount INCLUDES cached tokens;
          // Anthropic's input_tokens excludes them. Our contract says
          // inputTokens is always the uncached remainder, so subtract here.
          // Forget this and every cached turn is billed twice.
          usage = {
            inputTokens: Math.max(0, prompt - cached),
            cachedInputTokens: cached,
            // Implicit caching has no separate write charge to report.
            cacheWriteTokens: 0,
            outputTokens: m.candidatesTokenCount ?? 0,
          };
        }

        const reason = chunk.candidates?.[0]?.finishReason;
        if (reason === "MAX_TOKENS") finishReason = "length";
        else if (reason === "SAFETY" || reason === "PROHIBITED_CONTENT") finishReason = "refusal";
      }

      yield { type: "done", usage, finishReason };
    } catch (err) {
      throw mapError(err);
    }
  },

  async countTokens(apiKey, params) {
    const ai = new GoogleGenAI({ apiKey });
    try {
      const res = await ai.models.countTokens({
        model: params.model,
        contents: params.messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
      });
      return res.totalTokens ?? 0;
    } catch (err) {
      throw mapError(err);
    }
  },

  async listModels(apiKey) {
    // Ask the provider. Its list is the only authoritative one.
    try {
      const ai = new GoogleGenAI({ apiKey });
      const out: ModelInfo[] = [];
      for await (const m of await ai.models.list()) {
        const raw = (m as { name?: string }).name;
        if (!raw) continue;
        const id = bareId(raw);
        const actions =
          (m as { supportedActions?: string[] }).supportedActions ??
          (m as { supportedGenerationMethods?: string[] }).supportedGenerationMethods ??
          [];

        // `generateContent` does NOT mean "text model" — Gemini's image models
        // support it too, which is how an image model ("nano-banana-pro") ended
        // up selectable for chat and then failed with a quota error instead of
        // an obvious "this is not a chat model".
        //
        // Observed discriminator across the live list: text models advertise
        // createCachedContent; image, TTS and audio models do not. Combined
        // with a name check for the families that break the pattern
        // (omni/live/research/music), this filters cleanly. The save-time probe
        // in the UI is the real guarantee — this just keeps the picker honest.
        if (!actions.some((a) => /generateContent/i.test(a))) continue;
        if (!actions.some((a) => /createCachedContent/i.test(a))) continue;
        if (/embedding|aqa|imagen|veo|lyria|tts|audio|live|image|nano-banana/i.test(id)) continue;

        out.push({
          id,
          displayName: (m as { displayName?: string }).displayName ?? titleCase(id),
          contextWindow: (m as { inputTokenLimit?: number }).inputTokenLimit ?? 1_048_576,
          maxOutputTokens: (m as { outputTokenLimit?: number }).outputTokenLimit ?? 8192,
          // Not exposed by the API; a conservative default. Explicit caching is
          // a per-site decision anyway (see PromptCachePolicy).
          minCacheablePrefixTokens: 1024,
        });
      }
      if (out.length > 0) {
        // Rank so the FIRST entry is a sane default, since that is what a new
        // site gets. Plain alphabetical put `gemini-robotics-er-2-preview` at
        // the top: it answers, but a robotics model is not a chat default.
        const rank = (id: string): number => {
          if (/^gemini-(flash|pro)-latest$/.test(id)) return 0;        // stable aliases
          if (/^gemini-\d+(\.\d+)?-(flash|pro)$/.test(id)) return 1;  // released general models
          if (/^gemini-\d+(\.\d+)?-flash-lite$/.test(id)) return 2;
          if (/preview/.test(id)) return 4;                            // previews after stable
          if (/robotics|omni|research|customtools/.test(id)) return 5; // specialised
          return 3;
        };
        return out.sort(
          (a, b) => rank(a.id) - rank(b.id) || b.id.localeCompare(a.id, undefined, { numeric: true }),
        );
      }
    } catch {
      /* fall through to the static list */
    }
    return Object.values(FALLBACK_MODELS);
  },

  async validateKey(apiKey): Promise<KeyValidation> {
    // Must NOT depend on a specific model existing. The previous version probed
    // a hardcoded model id; when Google retired it, every valid key was
    // rejected with a 404 about a model the user had not chosen.
    try {
      const ai = new GoogleGenAI({ apiKey });
      const pager = await ai.models.list();
      for await (const _m of pager) return { valid: true };
      // Authenticated but no models visible — still a working key.
      return { valid: true };
    } catch (err) {
      return { valid: false, reason: mapError(err).message };
    }
  },
};

export const GEMINI_MODELS = FALLBACK_MODELS;
