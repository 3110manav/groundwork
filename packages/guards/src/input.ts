/**
 * Inbound message guard. Runs before anything expensive — no embedding call,
 * no retrieval, no LLM — so abuse costs us nothing.
 */
export interface InputVerdict {
  ok: boolean;
  reason?: string;
}

const MAX_CHARS = 2000;
const MIN_CHARS = 2;

export function checkInput(message: string): InputVerdict {
  const t = message.trim();

  if (t.length < MIN_CHARS) return { ok: false, reason: "empty message" };
  if (t.length > MAX_CHARS) return { ok: false, reason: `message too long (${t.length} chars)` };

  // A wall of one repeated character is a token-burn attempt, not a question.
  if (/(.)\1{80,}/.test(t)) return { ok: false, reason: "repeated-character flood" };

  // Very long single "word" — usually an encoded payload or a paste accident.
  if (/\S{600,}/.test(t)) return { ok: false, reason: "single token too long" };

  // Mostly non-text (control chars, zero-width joiners used to smuggle text
  // past pattern matching).
  const printable = t.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "");
  if (printable.length < t.length * 0.7) return { ok: false, reason: "excessive control characters" };

  return { ok: true };
}
