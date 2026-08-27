import { sql } from "@groundwork/db";

export const DIM = 1536;

/** Deterministic pseudo-embedding: same text -> same unit vector, no network. */
export function seeded(seed: string): number[] {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  const v: number[] = [];
  for (let i = 0; i < DIM; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    v.push(((h >>> 0) / 4294967295) * 2 - 1);
  }
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

/** Blend toward a target vector to simulate a semantically close embedding. */
export function near(target: number[], noise: string, alpha: number): number[] {
  const nv = seeded(noise);
  const v = target.map((x, i) => alpha * x + (1 - alpha) * nv[i]!);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

export async function makeSite(siteKey: string): Promise<{ orgId: string; siteId: string }> {
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO orgs (name) VALUES ('test') RETURNING id`;
  const [site] = await sql<{ id: string }[]>`
    INSERT INTO sites (org_id, name, site_key, model)
    VALUES (${org!.id}, 'Acme', ${siteKey}, 'claude-opus-5') RETURNING id`;
  return { orgId: org!.id, siteId: site!.id };
}

export async function dropOrg(orgId: string): Promise<void> {
  await sql`DELETE FROM orgs WHERE id = ${orgId}`;
}
