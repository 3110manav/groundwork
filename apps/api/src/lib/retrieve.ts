import { sql, toVectorLiteral } from "@groundwork/db";
import { embed } from "./embed.js";

export interface RetrievedChunk {
  id: string;
  url: string;
  breadcrumb: string;
  content: string;
  tokenCount: number;
  score: number;
  source: "crawl" | "manual";
  /** Cosine similarity from the dense arm; 0 when this chunk only matched lexically. */
  similarity: number;
}

const CANDIDATES = 20;
const FINAL_K = 5;

/**
 * Confidence gate. If nothing clears it we answer "I don't have that on this
 * site" WITHOUT calling the LLM at all — free, faster, and it removes the
 * hallucination class that gets widgets uninstalled.
 *
 * Gate on the RAW relevance signals, never on the fused RRF score. RRF is a
 * rank-combination heuristic: its output sits in a narrow band (~0.016–0.033)
 * whether the match is perfect or garbage, so it carries no information about
 * absolute relevance. Normalising it makes this worse — divide by the top
 * score and the top is 1.0 by construction, so the gate can only ever fire on
 * an empty site.
 *
 * So: gate on cosine similarity from the dense arm, plus whether the lexical
 * arm matched at all. Once a cross-encoder reranker lands, its calibrated
 * score becomes the right gate signal and replaces both.
 *
 * OBSERVED with text-embedding-3-small on a small real corpus:
 *   0.52  "how do I check a webhook is really from you?"  -> answer
 *   0.38  "can I get my money back if I don't like it?"   -> answer
 *   0.22  "what does the top tier include?"               -> answer (was wrongly gated at 0.28)
 *   0.12  "do you sell bicycles?"                         -> gate
 *
 * The answer/gate boundary is uncomfortably narrow, and a paraphrase that
 * shares no stem with the source ("top tier" vs "Enterprise") gets no help
 * from the lexical arm either. 0.18 is a compromise pending real traffic;
 * tune per site via RETRIEVAL_MIN_SIMILARITY. This narrowness is the
 * strongest argument for the reranker: a cross-encoder reads query and chunk
 * TOGETHER and would score that third question decisively.
 */
const MIN_SIMILARITY = Number(process.env.RETRIEVAL_MIN_SIMILARITY ?? 0.18);

/** Reciprocal Rank Fusion. k=60 is the standard constant from the paper. */
function rrf(ranks: number[], k = 60): number {
  return ranks.reduce((acc, r) => acc + 1 / (k + r), 0);
}

export async function retrieve(
  siteId: string,
  query: string,
): Promise<{ chunks: RetrievedChunk[]; gated: boolean }> {
  return searchChunks(siteId, query, await embed(query));
}

/**
 * The search half, taking a pre-computed query vector. Separated from
 * `retrieve` so the hybrid SQL can be exercised without a network round-trip
 * to the embedding provider.
 */
export async function searchChunks(
  siteId: string,
  query: string,
  queryEmbedding: number[],
): Promise<{ chunks: RetrievedChunk[]; gated: boolean }> {
  const queryVec = toVectorLiteral(queryEmbedding);

  // Vector and lexical arms run in parallel, then fuse. Hybrid beats either
  // alone: vectors catch paraphrase, BM25 catches exact product names and SKUs
  // that embeddings routinely miss.
  type Row = {
    id: string; url: string; breadcrumb: string; content: string;
    token_count: number; source: "crawl" | "manual"; priority: number;
    similarity?: number;
  };

  const [dense, lexical] = await Promise.all([
    sql<Row[]>`
      SELECT id, url, breadcrumb, content, token_count, source, priority,
             1 - (embedding <=> ${queryVec}::halfvec) AS similarity
      FROM chunks
      WHERE site_id = ${siteId} AND embedding IS NOT NULL AND NOT injection_risk
      ORDER BY embedding <=> ${queryVec}::halfvec
      LIMIT ${CANDIDATES}
    `,
    sql<Row[]>`
      -- plainto_tsquery/websearch_to_tsquery AND every term together, so a
      -- natural-language question containing one word absent from the document
      -- matches nothing at all: "how much does the Pro plan cost" becomes
      -- 'much & pro & plan & cost' and misses a page that says exactly that,
      -- because it never says "much". That silently degrades hybrid search to
      -- vector-only. OR the lexemes instead and let ts_rank do the weighting,
      -- so documents matching more terms score higher.
      WITH q AS (
        SELECT to_tsquery(
          'english',
          NULLIF(array_to_string(tsvector_to_array(to_tsvector('english', ${query})), ' | '), '')
        ) AS tsq
      )
      SELECT c.id, c.url, c.breadcrumb, c.content, c.token_count, c.source, c.priority
      FROM chunks c, q
      WHERE c.site_id = ${siteId}
        AND NOT c.injection_risk
        AND q.tsq IS NOT NULL
        AND c.tsv @@ q.tsq
      ORDER BY ts_rank(c.tsv, q.tsq) DESC
      LIMIT ${CANDIDATES}
    `,
  ]);

  const byId = new Map<string, RetrievedChunk & { ranks: number[]; priority: number }>();
  const ingest = (rows: Row[], arm: number) => {
    rows.forEach((row, i) => {
      const existing = byId.get(row.id);
      if (existing) {
        existing.ranks[arm] = i + 1;
        if (row.similarity !== undefined) existing.similarity = row.similarity;
        return;
      }
      const ranks = [CANDIDATES + 1, CANDIDATES + 1];
      ranks[arm] = i + 1;
      byId.set(row.id, {
        id: row.id,
        url: row.url,
        breadcrumb: row.breadcrumb,
        content: row.content,
        tokenCount: row.token_count,
        source: row.source,
        priority: row.priority,
        similarity: row.similarity ?? 0,
        score: 0,
        ranks,
      });
    });
  };
  ingest(dense, 0);
  ingest(lexical, 1);

  const fused = [...byId.values()].map((c) => ({
    ...c,
    // Owner-authored chunks outrank crawled content at equal relevance —
    // they exist precisely to correct what the crawler got wrong.
    score: rrf(c.ranks) * (1 + c.priority * 0.1),
  }));

  // TODO(rerank): a cross-encoder pass here is the single best token lever —
  // it lets us send 4 chunks instead of 15 while improving answer quality, and
  // its calibrated score replaces the two-signal gate below. Decision still
  // open: hosted rerank API vs self-hosted bge-reranker-v2-m3. Until then RRF
  // ordering stands in, which is meaningfully worse.
  const chunks = fused.sort((a, b) => b.score - a.score).slice(0, FINAL_K);

  // Gate on real signals, not on the fused score. The lexical arm returning
  // anything at all is itself evidence: to_tsquery only matches on a shared
  // stemmed term, so a hit means genuine lexical overlap.
  const bestSimilarity = Math.max(0, ...chunks.map((c) => c.similarity));
  const lexicalMatched = lexical.length > 0;
  const gated = chunks.length === 0 || (bestSimilarity < MIN_SIMILARITY && !lexicalMatched);

  return { chunks, gated };
}
