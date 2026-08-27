import { sql, toVectorLiteral } from "@groundwork/db";
import type { Source } from "@groundwork/contracts";
import { embed } from "./embed.js";

/**
 * The single biggest token lever: an exact-enough repeat question replays a
 * stored answer for zero LLM tokens. FAQ-heavy sites see 30–60% hit rates.
 *
 * Scoped by index_version, so a recrawl invalidates every stored answer
 * without a delete pass — bump sites.index_version and the old rows stop
 * matching.
 */
/**
 * Measured against text-embedding-3-small on one real question:
 *
 *   1.000  "Who are your clients?"                  (identical)
 *   0.957  "Who are your clients??"                 (extra punctuation)
 *   0.917  "who are your clients"                   (no capital, no question mark)
 *   0.511  "which companies have you worked with?"  (genuine paraphrase)
 *   0.539  "list your customers"                    (genuine paraphrase)
 *   0.352  "how fast are your websites?"            (different question)
 *
 * 0.95 was too strict — it missed a question differing only in casing and
 * punctuation, which is exactly the repeat traffic this cache exists to catch.
 * The gap between "same question retyped" (~0.92) and "genuine paraphrase"
 * (~0.51) is enormous, so 0.90 is comfortably safe. Note the corollary: a real
 * paraphrase will NOT hit this cache, by design — matching those is the
 * reranker's job, not a similarity threshold's.
 */
const SIMILARITY_THRESHOLD = Number(process.env.SEMANTIC_CACHE_THRESHOLD ?? 0.90);

export interface CachedAnswer {
  answer: string;
  sources: Source[];
}

export async function lookup(
  siteId: string,
  indexVersion: number,
  question: string,
): Promise<{ hit: CachedAnswer | null; embedding: number[] }> {
  const embedding = await embed(question);
  const literal = toVectorLiteral(embedding);

  const rows = await sql<{ id: string; answer: string; sources: Source[]; similarity: number }[]>`
    SELECT id, answer, sources,
           1 - (question_embedding <=> ${literal}::halfvec) AS similarity
    FROM answer_cache
    WHERE site_id = ${siteId} AND index_version = ${indexVersion}
    ORDER BY question_embedding <=> ${literal}::halfvec
    LIMIT 1
  `;

  const best = rows[0];
  if (!best || best.similarity < SIMILARITY_THRESHOLD) return { hit: null, embedding };

  // Fire-and-forget, but it must still be STARTED: postgres.js queries are
  // lazy and only execute when something subscribes to the promise. A bare
  // `void sql\`...\`` therefore never runs — hit_count sat at 0 through
  // confirmed cache hits, silently emptying the "top questions" report.
  // .catch() subscribes, so the query fires without blocking the response.
  sql`UPDATE answer_cache SET hit_count = hit_count + 1 WHERE id = ${best.id}`.catch(
    (err) => console.error("[semantic-cache] hit_count update failed", err),
  );

  return { hit: { answer: best.answer, sources: best.sources }, embedding };
}

export async function store(
  siteId: string,
  indexVersion: number,
  question: string,
  embedding: number[],
  answer: string,
  sources: Source[],
): Promise<void> {
  await sql`
    INSERT INTO answer_cache (site_id, index_version, question, question_embedding, answer, sources)
    VALUES (${siteId}, ${indexVersion}, ${question},
            ${toVectorLiteral(embedding)}::halfvec, ${answer}, ${sql.json(sources)})
  `;
}
