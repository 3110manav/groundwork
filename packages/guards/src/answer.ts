/**
 * Reject answers that are obviously not answers.
 *
 * Two failures seen live, both from free models behind an auto-router:
 *
 *   "User Safety: safe\nResponse Safety: safe"     <- a content-safety
 *                                                     classifier answered a
 *                                                     chat request
 *   "Here's a thinking process: 1. **Analyze..."   <- a reasoning model leaked
 *                                                     its chain of thought
 *
 * Both were streamed to the visitor AND written to the semantic cache, which
 * meant one bad reply poisoned every future asking of that question. The cache
 * is what makes this severe: a transient glitch becomes permanent.
 *
 * This is a backstop, not a substitute for pinning known-good models.
 */
const GARBAGE_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /^\s*(user|response|prompt)\s+safety\s*:/i, why: "content-safety classifier output" },
  { re: /^\s*(here'?s?|let me start with)\s+(a|my|the)\s+thinking process/i, why: "leaked reasoning preamble" },
  { re: /^\s*<(thinking|thought|reasoning|scratchpad)>/i, why: "leaked reasoning tags" },
  { re: /^\s*\d+\.\s*\*\*(analyze|understand|deconstruct)\s+(the\s+)?(user|request|input|query)/i, why: "leaked reasoning plan" },
  { re: /^\s*(okay|ok|alright)[,.]?\s+(so\s+)?the user (is asking|wants|asked)/i, why: "leaked reasoning monologue" },
];

export interface AnswerCheck {
  ok: boolean;
  reason?: string;
}

export function checkAnswer(text: string): AnswerCheck {
  const t = text.trim();
  if (t.length < 15) return { ok: false, reason: `implausibly short (${t.length} chars)` };
  for (const { re, why } of GARBAGE_PATTERNS) {
    if (re.test(t)) return { ok: false, reason: why };
  }
  return { ok: true };
}
