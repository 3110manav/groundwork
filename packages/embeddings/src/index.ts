import OpenAI from "openai";

/**
 * Embeddings live in ONE package because the index path and the query path
 * must use the same model — vectors are not portable, and indexing with model
 * A while querying with model B returns noise, not degraded results.
 *
 * This package exists because that invariant was broken within a day of being
 * written down: the API had one embedding client and the worker had a second,
 * independently configured copy. Two configs is one config drift away from a
 * silently useless index.
 *
 * The endpoint is configurable (OpenAI direct, OpenRouter, any compatible
 * gateway); only the MODEL is load-bearing. Changing it is a full reindex,
 * survivable only because raw HTML is archived.
 */
const baseURL = process.env.EMBEDDING_BASE_URL || undefined;
const apiKey =
  process.env.EMBEDDING_API_KEY ||
  process.env.OPENROUTER_API_KEY ||
  process.env.OPENAI_API_KEY ||
  "";

let client: OpenAI | null = null;
function getClient(): OpenAI {
  // Lazy, so importing this package never fails at module load in a process
  // that does not embed (and so tests can set env before first use).
  if (!client) client = new OpenAI({ apiKey, baseURL });
  return client;
}

export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 1536);

export async function embed(text: string): Promise<number[]> {
  const res = await getClient().embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    // Matryoshka truncation. 1536 -> 512 shrinks the HNSW index ~3x with
    // graceful quality loss; the scaling lever when Postgres RAM gets tight.
    dimensions: EMBEDDING_DIMENSIONS,
  });
  const vec = res.data[0]?.embedding;
  if (!vec) throw new Error("embedding: empty response");
  return vec;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await getClient().embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}
