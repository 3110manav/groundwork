/**
 * Worker entrypoint. Polls crawl_jobs for queued work.
 *
 * Deliberately a separate process from the API: crawls are long, memory-hungry,
 * and (once the headless pool lands) prone to leaking browsers. None of that
 * should be able to take down the chat path.
 */
import { sql } from "@groundwork/db";
import { runCrawl } from "./pipeline.js";

const POLL_MS = 5000;
let running = true;

process.on("SIGTERM", () => { running = false; });
process.on("SIGINT", () => { running = false; });

async function claimJob() {
  const rows = await sql<{ id: string; site_id: string; origin: string | null; name: string }[]>`
    UPDATE crawl_jobs SET status = 'running', started_at = now()
    WHERE id = (
      SELECT cj.id FROM crawl_jobs cj
      WHERE cj.status = 'queued'
      ORDER BY cj.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, site_id,
      -- The exact origin recorded at onboarding. NOT a pick from the domains
      -- allowlist: that table holds www + bare + our preview host, and an
      -- arbitrary LIMIT 1 once selected a bare domain that does not resolve.
      (SELECT s.crawl_origin FROM sites s WHERE s.id = crawl_jobs.site_id) AS origin,
      (SELECT s.name FROM sites s WHERE s.id = crawl_jobs.site_id) AS name
  `;
  return rows[0] ?? null;
}

console.log("groundwork worker started");

while (running) {
  const job = await claimJob();
  if (!job) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    continue;
  }
  if (!job.origin) {
    await sql`UPDATE crawl_jobs SET status = 'failed', error = 'site has no crawl_origin recorded', finished_at = now() WHERE id = ${job.id}`;
    continue;
  }
  try {
    await runCrawl(job.site_id, job.origin, job.name);
  } catch (err) {
    console.error(`job ${job.id} failed`, err);
  }
}

await sql.end();
console.log("worker stopped");
