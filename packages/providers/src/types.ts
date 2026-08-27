import type { ChatErrorCode } from "@groundwork/contracts";

export type ProviderId = "anthropic" | "gemini" | "openrouter";

/**
 * A system-prompt block with an explicit cacheability flag.
 *
 * The whole point of this shape: the caller declares WHICH blocks are stable,
 * and each adapter decides how to express that to its provider. Anthropic gets
 * an explicit `cache_control` breakpoint; Gemini decides implicit vs explicit
 * caching per site. Callers never write provider-specific cache code.
 *
 * Blocks are rendered in array order, so stable content MUST come first —
 * caching is a prefix match and one volatile byte early invalidates all of it.
 */
export interface SystemBlock {
  text: string;
  /** Mark the last stable block; everything after it is treated as volatile. */
  cacheable?: boolean;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatParams {
  model: string;
  system: SystemBlock[];
  messages: Turn[];
  maxTokens: number;
  /**
   * Hint for how hard the model should work. Chat widgets are latency-critical
   * and RAG answers are rarely hard reasoning, so the default is "low".
   */
  effort?: "low" | "medium" | "high";
  signal?: AbortSignal;
}

/**
 * Normalised token accounting.
 *
 * `inputTokens` is ALWAYS the uncached remainder. This is the single most
 * error-prone part of going multi-provider: Anthropic already reports it that
 * way, but Gemini's promptTokenCount INCLUDES the cached tokens, so its adapter
 * must subtract. Getting this wrong silently double-counts every cached turn
 * and inflates every invoice.
 */
export interface NormalizedUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

export type ProviderStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; usage: NormalizedUsage; finishReason: "stop" | "length" | "refusal" };

export interface ModelInfo {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** Below this many prefix tokens, caching silently does not happen. */
  minCacheablePrefixTokens: number;
}

export interface KeyValidation {
  valid: boolean;
  /** Present when invalid — for the dashboard, never for the widget. */
  reason?: string;
}

export interface LLMProvider {
  readonly id: ProviderId;
  chat(apiKey: string, params: ChatParams): AsyncIterable<ProviderStreamEvent>;
  countTokens(apiKey: string, params: Omit<ChatParams, "maxTokens">): Promise<number>;
  listModels(apiKey: string): Promise<ModelInfo[]>;
  validateKey(apiKey: string): Promise<KeyValidation>;
}

/** Adapters throw this; the route layer maps it onto the public envelope. */
export class ProviderError extends Error {
  constructor(
    readonly code: ChatErrorCode,
    readonly provider: ProviderId,
    detail: string,
    readonly retryable = false,
  ) {
    super(detail);
    this.name = "ProviderError";
  }
}
