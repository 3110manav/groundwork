import { sql } from "@groundwork/db";
import { runCrawl } from "./pipeline.js";

/** Usage: pnpm --filter @groundwork/worker crawl <siteId> <origin> [siteName] */
const [, , siteId, origin, siteName, maxPages] = process.argv;

if (!siteId || !origin) {
  console.error("usage: crawl <siteId> <origin> [siteName] [maxPages]");
  process.exit(1);
}

await runCrawl(
  siteId,
  origin.replace(/\/$/, ""),
  siteName ?? new URL(origin).hostname,
  maxPages ? Number(maxPages) : 200,
);
await sql.end();
