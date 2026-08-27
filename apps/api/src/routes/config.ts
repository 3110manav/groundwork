import { Hono } from "hono";
import { sql } from "@groundwork/db";
import { WidgetConfigSchema } from "@groundwork/contracts";

export const configRoutes = new Hono();

/**
 * Public widget configuration. Contains nothing secret — no provider key, no
 * model id, no prompt. Every field here is world-readable, because it is.
 *
 * Cached hard at the CDN and keyed by config_version, so a dashboard change
 * propagates on purge with no redeploy and no customer HTML edit.
 */
configRoutes.get("/v1/config/:siteKey", async (c) => {
  const siteKey = c.req.param("siteKey");

  const rows = await sql<{ config: unknown; config_version: string }[]>`
    SELECT wc.config, wc.config_version
    FROM widget_configs wc
    JOIN sites s ON s.id = wc.site_id
    WHERE s.site_key = ${siteKey}
  `;
  const row = rows[0];
  if (!row) return c.json({ error: "not_found" }, 404);

  const parsed = WidgetConfigSchema.safeParse({
    ...(row.config as object),
    siteKey,
    configVersion: row.config_version,
    apiBaseUrl: process.env.PUBLIC_API_URL ?? "http://localhost:8787",
  });
  if (!parsed.success) return c.json({ error: "invalid_config" }, 500);

  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  c.header("ETag", `"${row.config_version}"`);
  return c.json(parsed.data);
});
