import { Hono } from "hono";
import { sql } from "@groundwork/db";
import { page } from "../lib/layout.js";
import { escape } from "../lib/html.js";
import { type AuthEnv, ownsSite, requireAuth } from "../lib/auth.js";

export const dashboard = new Hono<AuthEnv>();

// Scoped to this router's own paths, not "*" — dashboard is mounted at "/" in
// index.ts, so an unscoped wildcard here would gate every route registered
// after it app-wide (e.g. /health), not just this router's own pages.
dashboard.use("/dashboard", requireAuth());
dashboard.use("/site/*", requireAuth());

/** Landing spot after login — every site the owner's account belongs to. */
dashboard.get("/dashboard", async (c) => {
  const user = c.get("user");
  const sites = await sql<{ id: string; name: string; billing_mode: string; convos: number }[]>`
    SELECT s.id, s.name, s.billing_mode,
           (SELECT count(*)::int FROM conversations WHERE site_id = s.id) AS convos
    FROM sites s
    JOIN org_members m ON m.org_id = s.org_id
    WHERE m.user_id = ${user.id}
    ORDER BY s.created_at DESC`;

  return c.html(
    page(
      { title: "Dashboard — Groundwork", user },
      `<section class="band"><div class="wrap">
  <p class="eyebrow">Dashboard</p>
  <h1 style="font-size:clamp(26px,3.4vw,34px)">Your sites</h1>
  ${
    sites.length
      ? `<div class="grid g3" style="margin-top:26px">
          ${sites
            .map(
              (s) => `<a class="card" href="/site/${s.id}" style="text-decoration:none;color:inherit;display:block">
                <h3>${escape(s.name)}</h3>
                <p>${s.convos} conversation${s.convos === 1 ? "" : "s"} &middot; ${s.billing_mode === "byok" ? "your key" : "shared key"}</p>
              </a>`,
            )
            .join("")}
        </div>`
      : `<div class="card" style="margin-top:26px"><p>No sites yet.</p></div>`
  }
  <div class="row" style="margin-top:28px"><a class="btn lg" href="/onboard">Add a site</a></div>
</div></section>`,
    ),
  );
});

dashboard.get("/site/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await ownsSite(c.get("user").id, id))) return c.notFound();
  const [site] = await sql<{
    name: string; site_key: string; model: string; index_version: number;
    billing_mode: string; provider: string; key_last4: string | null;
  }[]>`
    SELECT s.name, s.site_key, s.model, s.index_version, s.billing_mode, s.provider, pk.key_last4
    FROM sites s LEFT JOIN provider_keys pk ON pk.site_id = s.id
    WHERE s.id = ${id}`;
  if (!site) return c.notFound();

  const [stats] = await sql<{ pages: number; chunks: number; convos: number; flagged: number; corepack: number }[]>`
    SELECT (SELECT count(*)::int FROM pages  WHERE site_id=${id}) pages,
           (SELECT count(*)::int FROM chunks WHERE site_id=${id}) chunks,
           (SELECT count(*)::int FROM conversations WHERE site_id=${id}) convos,
           (SELECT count(*)::int FROM chunks WHERE site_id=${id} AND injection_risk) flagged,
           (SELECT COALESCE(token_count,0)::int FROM core_packs WHERE site_id=${id}) corepack`;

  const [usage] = await sql<{
    calls: number; cost: string; hits: number;
    inputToks: number; cachedToks: number; writeToks: number; outputToks: number;
  }[]>`
    SELECT count(*)::int calls,
           COALESCE(sum(provider_cost_usd),0)::text cost,
           COALESCE(sum(CASE WHEN semantic_cache_hit THEN 1 ELSE 0 END),0)::int hits,
           COALESCE(sum(input_tokens),0)::int "inputToks",
           COALESCE(sum(cached_input_tokens),0)::int "cachedToks",
           COALESCE(sum(cache_write_tokens),0)::int "writeToks",
           COALESCE(sum(output_tokens),0)::int "outputToks"
    FROM usage_events WHERE site_id=${id} AND created_at >= date_trunc('month', now())`;

  // "Memory" in the product sense: how conversations actually behave — do
  // visitors come back for multiple turns, and is the rolling summary (the
  // thing that keeps a long chat cheap once its history falls out of the
  // prompt window) ever actually kicking in.
  const [memory] = await sql<{ convos: number; msgs: number; summarized: number; maxTurn: number }[]>`
    SELECT count(DISTINCT c.id)::int convos,
           count(m.id)::int msgs,
           count(DISTINCT CASE WHEN c.summary IS NOT NULL THEN c.id END)::int summarized,
           COALESCE(max(sub.n),0)::int "maxTurn"
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id
    LEFT JOIN (SELECT conversation_id, count(*)::int n FROM messages GROUP BY conversation_id) sub
           ON sub.conversation_id = c.id
    WHERE c.site_id = ${id}`;

  // The report owners actually log in for: what visitors wanted and the site
  // could not answer. Each row is a content gap, not a bug.
  const unanswered = await sql<{ q: string; n: number }[]>`
    SELECT u.content q, count(*)::int n
    FROM messages a
    JOIN messages u ON u.conversation_id = a.conversation_id AND u.created_at < a.created_at AND u.role='user'
    JOIN conversations c ON c.id = a.conversation_id
    WHERE c.site_id=${id} AND a.role='assistant' AND a.unanswered
    GROUP BY u.content ORDER BY n DESC LIMIT 10`;

  const top = await sql<{ q: string; h: number }[]>`
    SELECT question q, hit_count h FROM answer_cache
    WHERE site_id=${id} AND index_version=${site.index_version}
    ORDER BY hit_count DESC, created_at DESC LIMIT 10`;

  const alerts = await sql<{ code: string; detail: string; seen_count: number; last_seen: string }[]>`
    SELECT code, detail, seen_count, last_seen FROM site_alerts
    WHERE site_id=${id} ORDER BY last_seen DESC LIMIT 5`;

  const ALERT_HELP: Record<string, string> = {
    provider_quota: "Your AI provider is out of quota or credit. Visitors see \u201cthe assistant is temporarily unavailable\u201d until it is topped up or you connect a different key.",
    provider_auth: "Your provider rejected the stored key. Reconnect it.",
    budget_exceeded: "This site hit its monthly spend ceiling. Raise it or wait for the month to roll over.",
  };

  const blocked = await sql<{ guard: string; reason: string; n: number }[]>`
    SELECT guard, reason, count(*)::int n FROM blocked_answers
    WHERE site_id=${id} GROUP BY guard, reason ORDER BY n DESC LIMIT 5`;

  const rows = (arr: { a: string; b: string }[], empty: string) =>
    arr.length
      ? arr.map((r) => `<tr><td>${escape(r.a)}</td><td style="text-align:right;font-family:var(--mono)">${escape(r.b)}</td></tr>`).join("")
      : `<tr><td colspan="2" class="hint">${empty}</td></tr>`;

  const delErr = c.req.query("delete_error");
  const cacheRate = usage && usage.calls > 0 ? Math.round((usage.hits / usage.calls) * 100) : 0;
  const billedTokens = (usage?.inputToks ?? 0) + (usage?.outputToks ?? 0);
  const cacheableTokens = billedTokens + (usage?.cachedToks ?? 0);
  const tokenCacheRate = cacheableTokens > 0 ? Math.round(((usage?.cachedToks ?? 0) / cacheableTokens) * 100) : 0;
  const avgTurns = memory && memory.convos > 0 ? (memory.msgs / memory.convos / 2).toFixed(1) : "0";

  return c.html(
    page(
      {
        title: `${site.name} — Groundwork`,
        user: c.get("user"),
        // Progressive enhancement only — the server re-checks the typed name,
        // so a no-JS visitor still gets the real guardrail.
        script: `var delInput=document.getElementById('del-confirm'),delBtn=document.getElementById('del-btn');
if(delInput&&delBtn){var syncDel=function(){delBtn.disabled=delInput.value.trim().toLowerCase()!==delInput.getAttribute('data-name').trim().toLowerCase();};delInput.addEventListener('input',syncDel);syncDel();}`,
      },
      `<section class="band"><div class="wrap">
  <p class="eyebrow">Dashboard</p>
  <h1 style="font-size:clamp(26px,3.4vw,34px)">${escape(site.name)}</h1>
  <p class="hint"><code>${escape(site.site_key)}</code> · index v${site.index_version}</p>
  <p style="margin-top:10px">
    Chat runs on
    ${site.billing_mode === "byok" && site.key_last4
        ? `<span class="pill">your ${escape(site.provider)} key ••••${escape(site.key_last4)}</span>`
        : `<span class="pill warn">our shared key</span> <span class="hint">rate-limited &mdash; <a href="/site/${id}/provider">connect your own</a></span>`}
  </p>

  ${
    alerts.length
      ? alerts
          .map(
            (a) => `<div class="card" style="margin-top:20px;border-color:var(--danger)">
        <h3 style="color:var(--danger)">Chat is failing — ${escape(a.code.replace(/_/g, " "))}</h3>
        <p style="font-size:14.5px">${escape(ALERT_HELP[a.code] ?? "")}</p>
        <p class="hint" style="margin-top:6px"><code>${escape(a.detail.slice(0, 160))}</code></p>
        <p class="hint">Seen ${a.seen_count}&times;, last ${escape(new Date(a.last_seen).toISOString().slice(0, 16).replace("T", " "))} UTC ·
          <a href="/site/${id}/provider">Connect a different key</a></p>
      </div>`,
          )
          .join("")
      : ""
  }

  <div class="grid g3" style="margin-top:26px">
    <div class="card"><h3>${stats?.pages ?? 0}</h3><p>pages indexed</p></div>
    <div class="card"><h3>${stats?.chunks ?? 0}</h3><p>passages searchable</p></div>
    <div class="card"><h3>${stats?.convos ?? 0}</h3><p>conversations</p></div>
    <div class="card"><h3>${usage?.calls ?? 0}</h3><p>model calls this month</p></div>
    <div class="card"><h3>${cacheRate}%</h3><p>answered from cache — free</p></div>
    <div class="card"><h3>$${Number(usage?.cost ?? 0).toFixed(4)}</h3><p>estimated spend this month</p></div>
  </div>

  <h2 style="font-size:21px;margin-top:36px">Tokens &amp; memory</h2>
  <p class="hint" style="margin-bottom:12px">What this site is actually costing, and how conversations are being carried forward.</p>
  <div class="grid g3">
    <div class="card">
      <h3>${(usage?.inputToks ?? 0).toLocaleString()}</h3>
      <p>uncached input tokens billed this month</p>
    </div>
    <div class="card">
      <h3>${(usage?.cachedToks ?? 0).toLocaleString()}</h3>
      <p>input tokens served from the provider's prompt cache — ${tokenCacheRate}% of everything sent</p>
    </div>
    <div class="card">
      <h3>${(usage?.outputToks ?? 0).toLocaleString()}</h3>
      <p>output tokens generated this month</p>
    </div>
    <div class="card">
      <h3>${(memory?.convos ?? 0).toLocaleString()}</h3>
      <p>conversations tracked &mdash; each one keeps its own message history and rolling summary</p>
    </div>
    <div class="card">
      <h3>${avgTurns}</h3>
      <p>average back-and-forth turns per conversation</p>
    </div>
    <div class="card">
      <h3>${memory?.summarized ?? 0}</h3>
      <p>conversation${memory?.summarized === 1 ? "" : "s"} long enough to fall back on a rolling summary${memory && memory.maxTurn > 0 ? ` (longest: ${memory.maxTurn} messages)` : ""}</p>
    </div>
  </div>

  <div class="grid g2" style="margin-top:32px;align-items:start">
    <div>
      <h2 style="font-size:21px">Questions your site couldn't answer</h2>
      <p class="hint" style="margin-bottom:12px">Each row is a content gap. Add the answer to your site, then re-index.</p>
      <div class="card" style="padding:0"><table>
        <thead><tr><th>Question</th><th style="text-align:right">Asked</th></tr></thead>
        <tbody>${rows(unanswered.map((r) => ({ a: r.q, b: String(r.n) })), "Nothing yet — no visitor has hit a gap.")}</tbody>
      </table></div>
    </div>
    <div>
      <h2 style="font-size:21px">Most repeated questions</h2>
      <p class="hint" style="margin-bottom:12px">Served from cache at no cost after the first ask.</p>
      <div class="card" style="padding:0"><table>
        <thead><tr><th>Question</th><th style="text-align:right">Cache hits</th></tr></thead>
        <tbody>${rows(top.map((r) => ({ a: r.q, b: String(r.h) })), "Nothing cached yet.")}</tbody>
      </table></div>
    </div>
  </div>

  ${
    (stats?.corepack ?? 0) === 0
      ? `<div class="card" style="margin-top:26px;border-color:var(--warn)">
           <h3 style="color:var(--warn)">Site brief missing</h3>
           <p style="font-size:14.5px">Your pages are indexed and chat works, but the site brief — a summary that answers common questions without a search — was not generated. Usually a model quota. Re-index to try again.</p>
         </div>`
      : ""
  }

  <h2 style="font-size:21px;margin-top:36px">Guardrails</h2>
  <div class="grid g2" style="align-items:start">
    <div class="card">
      <h3>Flagged content <span class="pill ${stats?.flagged ? "warn" : ""}">${stats?.flagged ?? 0}</span></h3>
      <p>Passages on your site that look like prompt-injection attempts. These are excluded from every answer.</p>
    </div>
    <div class="card">
      <h3>Blocked answers</h3>
      ${
        blocked.length
          ? `<table style="margin-top:8px"><tbody>${blocked
              .map((b) => `<tr><td>${escape(b.guard)} — ${escape(b.reason)}</td><td style="text-align:right;font-family:var(--mono)">${b.n}</td></tr>`)
              .join("")}</tbody></table>`
          : `<p>None. Every answer passed the grounding and quality checks.</p>`
      }
    </div>
  </div>

  <div class="row" style="margin-top:34px">
    <a class="btn" href="/site/${id}/preview">Try it live</a>
    <form method="post" action="/site/${id}/recrawl"><button class="btn ghost" type="submit">Re-index site</button></form>
    <a class="btn ghost" href="/site/${id}/provider">AI provider</a>
    <a class="btn ghost" href="/onboard/${id}/style">Edit appearance</a>
    <a class="btn ghost" href="/onboard/${id}/install">Install snippet</a>
  </div>

  <h2 style="font-size:21px;margin-top:48px;color:var(--danger)">Danger zone</h2>
  <div class="card" style="border-color:var(--danger);margin-top:12px">
    <h3>Delete this site</h3>
    <p style="font-size:14.5px">Removes the widget, the index, every conversation and all usage history — permanently. The install snippet on your pages stops working immediately. This cannot be undone.</p>
    ${delErr ? `<p style="color:var(--danger);font-size:14px;margin-top:10px">${escape(delErr)}</p>` : ""}
    <form method="post" action="/site/${id}/delete" style="margin-top:16px;max-width:420px">
      <div class="field" style="margin-bottom:12px">
        <label for="del-confirm">Type <strong>${escape(site.name)}</strong> to confirm</label>
        <input type="text" id="del-confirm" name="confirm" data-name="${escape(site.name)}" autocomplete="off" spellcheck="false">
      </div>
      <button class="btn danger" id="del-btn" type="submit">Delete site permanently</button>
    </form>
  </div>
</div></section>`,
    ),
  );
});

/**
 * Preview: a stand-in customer page with the real widget on it, served from
 * our own origin (which onboarding verifies for exactly this purpose). This is
 * the first time an owner sees the product working on their own content.
 */
dashboard.get("/site/:id/preview", async (c) => {
  const id = c.req.param("id");
  if (!(await ownsSite(c.get("user").id, id))) return c.notFound();
  const [site] = await sql<{ name: string; site_key: string; billing_mode: string; key_last4: string | null }[]>`
    SELECT s.name, s.site_key, s.billing_mode, pk.key_last4
    FROM sites s LEFT JOIN provider_keys pk ON pk.site_id = s.id
    WHERE s.id = ${id}`;
  if (!site) return c.notFound();
  const keyNote =
    site.billing_mode === "byok" && site.key_last4
      ? `running on your key ••••${site.key_last4}`
      : "running on our shared key (rate-limited)";

  const cdn = process.env.PUBLIC_CDN_URL ?? "http://localhost:3000/cdn";
  const api = process.env.PUBLIC_API_URL ?? "http://localhost:8787";

  return c.html(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Preview — ${escape(site.name)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; font-family: ui-sans-serif,-apple-system,"Segoe UI",sans-serif;
         background:#FBFBFA; color:#14180F; }
  .bar { background:#14180F; color:#fff; padding:12px 26px; font-size:14px; display:flex; gap:14px; align-items:center; }
  .bar a { color:#9DDFBB; text-decoration:none; margin-left:auto; }
  main { max-width:720px; margin:0 auto; padding:60px 26px 160px; }
  h1 { font-size:32px; letter-spacing:-.025em; margin:0 0 14px; }
  p { line-height:1.65; color:#4A5142; }
  .note { margin-top:34px; padding:16px 18px; background:#fff; border:1px solid #E1E4DC;
          border-radius:10px; font-size:14.5px; color:#4A5142; }
</style></head><body>
<div class="bar"><strong>Preview</strong> <span style="opacity:.6">${escape(site.name)} &middot; ${escape(keyNote)}</span>
  <a href="/site/${id}">&larr; Back to dashboard</a></div>
<main>
  <h1>Try it before you install it.</h1>
  <p>The widget in the corner is running against your real indexed content. It behaves exactly as it will on your own site — same answers, same citations, same refusals.</p>
  <div class="note">Ask it something your site covers, then ask something it doesn't. It should answer the first confidently with sources, and decline the second rather than inventing anything.</div>
</main>
<script src="${cdn}/w.js" data-site-key="${escape(site.site_key)}" data-api-base="${api}" async></script>
</body></html>`);
});

dashboard.post("/site/:id/recrawl", async (c) => {
  const id = c.req.param("id");
  if (!(await ownsSite(c.get("user").id, id))) return c.notFound();
  await sql`INSERT INTO crawl_jobs (site_id, status) VALUES (${id}, 'queued')`;
  return c.redirect(`/onboard/${id}/indexing`);
});

/**
 * The one action here that cannot be walked back. The form makes the owner
 * type the site's name, and the server re-checks it — the client-side gate
 * is convenience, this comparison is the guardrail.
 */
dashboard.post("/site/:id/delete", async (c) => {
  const id = c.req.param("id");
  if (!(await ownsSite(c.get("user").id, id))) return c.notFound();
  const [site] = await sql<{ name: string }[]>`SELECT name FROM sites WHERE id = ${id}`;
  if (!site) return c.notFound();

  const f = await c.req.parseBody();
  const typed = String(f.confirm ?? "").trim();
  if (typed.toLowerCase() !== site.name.trim().toLowerCase()) {
    return c.redirect(
      `/site/${id}?delete_error=${encodeURIComponent("The name you typed didn't match — nothing was deleted.")}`,
    );
  }

  // Every dependent table references sites with ON DELETE CASCADE, so this one
  // statement removes the index, conversations, keys, config and usage with it.
  await sql`DELETE FROM sites WHERE id = ${id}`;
  return c.redirect("/dashboard");
});
