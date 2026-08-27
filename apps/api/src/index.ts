import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { chatRoutes } from "./routes/chat.js";
import { configRoutes } from "./routes/config.js";

const app = new Hono();

// The widget is embedded on arbitrary customer domains, so CORS is open here
// and the real check is the per-site verified-origin allowlist inside the
// chat route, plus rate limits and the monthly budget ceiling.
app.use("*", cors({ origin: "*", allowHeaders: ["content-type", "x-site-key"] }));

app.get("/health", (c) => c.json({ ok: true }));
app.route("/", configRoutes);
app.route("/", chatRoutes);

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`groundwork api listening on :${port}`);
