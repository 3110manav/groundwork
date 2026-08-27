import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { sql, toVectorLiteral } from "@groundwork/db";
import { searchChunks } from "../src/lib/retrieve.js";
import { dropOrg, makeSite, near, seeded } from "./helpers.js";

/**
 * Integration tests — these need a migrated Postgres:
 *   DATABASE_URL=postgres://user@localhost:5432/chatsdk pnpm --filter @groundwork/api test
 *
 * Both suites below exist because the original implementations were wrong in
 * ways that only surfaced when run against a real database.
 */

const DOCS = [
  {
    bc: "Acme > Pricing > Plans",
    url: "https://acme.test/pricing",
    body: "The Pro plan costs 49 dollars per month and includes unlimited seats and priority support.",
  },
  {
    bc: "Acme > Docs > Webhooks",
    url: "https://acme.test/docs/webhooks",
    body: "Webhooks deliver events over HTTPS. Each payload is signed with an HMAC header you verify.",
  },
  {
    bc: "Acme > About > Company",
    url: "https://acme.test/about",
    body: "Acme was founded in 2019 and builds logistics tooling for freight brokers.",
  },
];

describe("hybrid retrieval — lexical arm", () => {
  let orgId: string;
  let siteId: string;

  before(async () => {
    ({ orgId, siteId } = await makeSite("pk_test_lexical"));
    for (const d of DOCS) {
      await sql`
        INSERT INTO chunks (site_id, source, breadcrumb, url, content, token_count,
                            content_hash, embedding, embedding_model)
        VALUES (${siteId}, 'crawl', ${d.bc}, ${d.url}, ${d.body}, 20, ${d.bc},
                ${toVectorLiteral(seeded(d.body))}::halfvec, 'test')`;
    }
  });
  after(async () => { await dropOrg(orgId); });

  // REGRESSION: plainto_tsquery/websearch_to_tsquery AND every term, so
  // "how much does the Pro plan cost" -> 'much & pro & plan & cost' matched
  // nothing, because the pricing page never says "much". The lexical arm
  // returned zero rows for realistic questions and hybrid search silently
  // degraded to vector-only.
  const cases: [string, string][] = [
    ["how much does the Pro plan cost", "Acme > Pricing > Plans"],
    ["how do I verify a webhook signature", "Acme > Docs > Webhooks"],
    ["when was the company founded", "Acme > About > Company"],
  ];

  for (const [query, expected] of cases) {
    it(`matches a natural-language question: ${query}`, async () => {
      // Deliberately unrelated vector, so only the lexical arm can succeed.
      const r = await searchChunks(siteId, query, seeded("unrelated vector"));
      assert.equal(r.chunks[0]?.breadcrumb, expected);
    });
  }

  it("survives an all-stopword query without throwing", async () => {
    await assert.doesNotReject(() => searchChunks(siteId, "the of and is", seeded("x")));
  });

  it("survives punctuation and apostrophes", async () => {
    const r = await searchChunks(siteId, "what's the plan's cost? (per-month)", seeded("x"));
    assert.equal(r.chunks[0]?.breadcrumb, "Acme > Pricing > Plans");
  });
});

describe("confidence gate", () => {
  let orgId: string;
  let siteId: string;
  const body = "The Pro plan costs 49 dollars per month and includes unlimited seats.";
  const bodyVec = seeded(body);

  before(async () => {
    ({ orgId, siteId } = await makeSite("pk_test_gate"));
    await sql`
      INSERT INTO chunks (site_id, source, breadcrumb, url, content, token_count,
                          content_hash, embedding, embedding_model)
      VALUES (${siteId}, 'crawl', 'Acme > Pricing', 'https://acme.test/pricing',
              ${body}, 20, 'h1', ${toVectorLiteral(bodyVec)}::halfvec, 'test')`;
  });
  after(async () => { await dropOrg(orgId); await sql.end(); });

  it("does not gate when the lexical arm matches", async () => {
    const r = await searchChunks(siteId, "what does the Pro plan cost", seeded("unrelated"));
    assert.equal(r.gated, false);
  });

  it("does not gate when the vector arm is semantically close", async () => {
    const r = await searchChunks(siteId, "zzz qqq", near(bodyVec, "noise", 0.9));
    assert.equal(r.gated, false);
  });

  // REGRESSION: the gate used to compare a score normalised by the top score,
  // which is 1.0 by construction — so it could only ever fire on an empty
  // site, and every irrelevant query still reached the LLM.
  it("gates when neither arm has signal", async () => {
    const r = await searchChunks(siteId, "zzz qqq", seeded("unrelated"));
    assert.equal(r.gated, true);
  });

  it("gates an all-stopword query", async () => {
    const r = await searchChunks(siteId, "the of and is", seeded("unrelated"));
    assert.equal(r.gated, true);
  });

  it("gates a site with no chunks", async () => {
    const r = await searchChunks("00000000-0000-0000-0000-000000000000", "anything", seeded("x"));
    assert.equal(r.gated, true);
  });
});
