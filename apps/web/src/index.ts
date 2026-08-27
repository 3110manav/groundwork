import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { landing } from "./routes/landing.js";
import { docs } from "./routes/docs.js";
import { auth } from "./routes/auth.js";
import { onboard } from "./routes/onboard.js";
import { dashboard } from "./routes/dashboard.js";
import { provider } from "./routes/provider.js";

const app = new Hono();

/**
 * Serve the widget bundle from here in development so there is one fewer
 * process to run. In production this is a CDN origin — the widget must be
 * cached at the edge, and PUBLIC_CDN_URL is what the install snippet points at.
 */
// Resolved against this file, not the shell's cwd — otherwise `pnpm dev` works
// from the repo root and fails from apps/web, or vice versa.
const widgetDist = relative(
  process.cwd(),
  join(dirname(fileURLToPath(import.meta.url)), "../../../packages/widget/dist"),
);

app.use(
  "/cdn/*",
  serveStatic({
    root: widgetDist,
    rewriteRequestPath: (path) => path.replace(/^\/cdn/, ""),
  }),
);

app.route("/", landing);
app.route("/", docs);
app.route("/", auth);
app.route("/", onboard);
app.route("/", dashboard);
app.route("/", provider);
app.get("/health", (c) => c.json({ ok: true }));

const port = Number(process.env.WEB_PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`groundwork web listening on :${port}`);
