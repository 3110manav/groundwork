import type { SystemBlock, Turn } from "@groundwork/providers";
import type { RetrievedChunk } from "./retrieve.js";

/**
 * Cache-aware prompt assembly. This is the heart of the token story.
 *
 * Prompt caching is a PREFIX MATCH: any byte change anywhere in the prefix
 * invalidates everything after it. In RAG that is awkward, because retrieved
 * chunks change on every single query and therefore can never be cached.
 *
 * So we build a stable prefix worth caching on purpose:
 *
 *   [ persona + core pack ]  <- cacheable, byte-identical between turns
 *   ----- cache breakpoint -----
 *   [ chunks + history + question ]  <- volatile, full price, always
 *
 * Everything below exists to keep the top half byte-identical. Anything that
 * varies per request — a timestamp, a request id, a user id, a conditionally
 * included section — belongs strictly below the breakpoint.
 */

/** Rough heuristic. Use provider countTokens when the number must be exact. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.8);
}

export interface PromptCachePolicy {
  /** Whether to ask the adapter for an explicit cache breakpoint at all. */
  useExplicitCache: boolean;
  reason: string;
}

/**
 * Below a provider's minimum cacheable prefix, caching silently does not
 * happen — no error, just zero cache tokens. And on Gemini, explicit caching
 * charges storage per hour whether or not anyone reads it, so a low-traffic
 * site can pay more to cache than it saves.
 */
export function decideCachePolicy(args: {
  prefixTokens: number;
  minCacheablePrefixTokens: number;
  requestsPerHour: number;
  providerChargesForIdleCache: boolean;
}): PromptCachePolicy {
  if (args.prefixTokens < args.minCacheablePrefixTokens) {
    return {
      useExplicitCache: false,
      reason: `prefix ${args.prefixTokens} tok is below the ${args.minCacheablePrefixTokens} tok minimum — grow the core pack or accept uncached traffic`,
    };
  }
  if (args.providerChargesForIdleCache && args.requestsPerHour < 20) {
    return {
      useExplicitCache: false,
      reason: `only ${args.requestsPerHour} req/h — hourly cache storage would cost more than it saves`,
    };
  }
  return { useExplicitCache: true, reason: "prefix is large enough and traffic justifies it" };
}

const PERSONA = (assistantName: string) => `You are ${assistantName}, an assistant embedded on a company's website.

Answer only from the CONTEXT provided in the user turn and the SITE BRIEF below. If the answer is not there, say you don't have that information and point the visitor to the site's contact route. Never invent product names, prices, availability, or policies.

Keep answers short and direct — usually two or three sentences. Skip preamble. Do not open with "Based on the context" or similar. Match the visitor's language.

Cite by naming the page you drew from in plain words, not by pasting URLs.`;

export interface AssembleArgs {
  assistantName: string;
  /** The stable, deliberately-sized site brief. 2–4K tokens is the target. */
  corePack: string;
  chunks: RetrievedChunk[];
  history: Turn[];
  /** Rolling summary of turns dropped from the window. */
  conversationSummary: string | null;
  question: string;
  useExplicitCache: boolean;
}

export interface AssembledPrompt {
  system: SystemBlock[];
  messages: Turn[];
  cacheablePrefixTokens: number;
  volatileTokens: number;
}

export function assemble(args: AssembleArgs): AssembledPrompt {
  // ---- above the breakpoint: identical on every turn for this site ----
  const persona = PERSONA(args.assistantName);
  const brief = `SITE BRIEF\n${args.corePack}`;

  const system: SystemBlock[] = [
    { text: persona },
    // The breakpoint sits on the LAST cacheable block, so it covers both.
    { text: brief, cacheable: args.useExplicitCache },
  ];

  // ---- below the breakpoint: different every turn ----
  const context = args.chunks
    .map((c, i) => `[${i + 1}] ${c.breadcrumb}\n${c.content}`)
    .join("\n\n---\n\n");

  const preamble = args.conversationSummary
    ? `EARLIER IN THIS CONVERSATION\n${args.conversationSummary}\n\n`
    : "";

  const userTurn = `${preamble}CONTEXT\n${context}\n\nQUESTION\n${args.question}`;

  const messages: Turn[] = [...args.history, { role: "user", content: userTurn }];

  const cacheablePrefixTokens = estimateTokens(persona) + estimateTokens(brief);
  const volatileTokens = messages.reduce((n, m) => n + estimateTokens(m.content), 0);

  return { system, messages, cacheablePrefixTokens, volatileTokens };
}

/**
 * Rolling window: keep the last N turns verbatim, summarise the rest.
 * Nobody's turn-40 support conversation needs full fidelity at turn 40.
 */
export const HISTORY_WINDOW_TURNS = 6;

export function windowHistory(all: Turn[]): { kept: Turn[]; dropped: Turn[] } {
  if (all.length <= HISTORY_WINDOW_TURNS) return { kept: all, dropped: [] };
  return {
    kept: all.slice(-HISTORY_WINDOW_TURNS),
    dropped: all.slice(0, -HISTORY_WINDOW_TURNS),
  };
}
