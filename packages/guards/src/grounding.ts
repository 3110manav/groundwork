/**
 * Grounding check: does the answer actually come from the retrieved context?
 *
 * The failure this catches is the expensive one. Retrieval returns something
 * plausible-but-wrong, and the model — which knows plenty about the world —
 * fills the gap from its own parameters. The result reads confident, cites
 * nothing checkable, and is wrong about a customer's prices or policies.
 *
 * A cheap lexical overlap check catches the blatant cases without a second
 * model call. It is intentionally permissive: the goal is flagging answers with
 * ~no relationship to the context, not scoring faithfulness. A proper
 * NLI/faithfulness model is the real answer if this ever needs to be strict.
 */
const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","than","that","this","these","those",
  "is","are","was","were","be","been","being","have","has","had","do","does","did",
  "will","would","can","could","should","may","might","must","of","in","on","at",
  "to","for","with","from","by","as","it","its","you","your","we","our","they",
  "their","i","me","my","not","no","yes","there","here","what","which","who","how",
  "when","where","why","also","more","most","some","any","all","about","into","over",
]);

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

export interface GroundingVerdict {
  ok: boolean;
  overlap: number;
  reason?: string;
}

/** Answers shorter than this are usually "I don't know", which needs no grounding. */
const SHORT_ANSWER_CHARS = 120;
const MIN_OVERLAP = 0.25;

export function checkGrounding(answer: string, context: string): GroundingVerdict {
  const a = answer.trim();
  if (a.length < SHORT_ANSWER_CHARS) return { ok: true, overlap: 1 };

  const answerWords = contentWords(a);
  if (answerWords.size === 0) return { ok: true, overlap: 1 };

  const contextWords = contentWords(context);
  let shared = 0;
  for (const w of answerWords) if (contextWords.has(w)) shared++;
  const overlap = shared / answerWords.size;

  if (overlap < MIN_OVERLAP) {
    return {
      ok: false,
      overlap,
      reason: `only ${(overlap * 100).toFixed(0)}% of answer terms appear in the retrieved context`,
    };
  }
  return { ok: true, overlap };
}
