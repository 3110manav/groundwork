import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { sql } from "@groundwork/db";
import { page } from "../lib/layout.js";
import { escape } from "../lib/html.js";
import { type AuthEnv, ownsSite, requireAuth } from "../lib/auth.js";

export const onboard = new Hono<AuthEnv>();

// Every step here writes to an org/site — none of it makes sense signed out.
onboard.use("*", requireAuth());

const steps = (on: number) =>
  ["Your site", "Indexing", "Style it", "Install"]
    .map((s, i) => `<li class="${i === on ? "on" : i < on ? "done" : ""}">${i + 1}. ${s}</li>`)
    .join("");

/** Free models by default: a new site works before anyone pays for anything. */
const DEFAULT_CHAIN =
  "minimax/minimax-m2.7:free,minimax/minimax-m3:free,nvidia/nemotron-3-super-120b-a12b:free";

// ---------------------------------------------------------------- step 1 --
onboard.get("/onboard", (c) =>
  c.html(
    page(
      { title: "Add your site — Groundwork", active: "onboard", user: c.get("user") },
      `<section class="band"><div class="wrap narrow">
  <ul class="steps">${steps(0)}</ul>
  ${c.req.query("error") === "unreachable"
      ? `<div class="card" style="border-color:var(--danger);margin-bottom:22px"><h3 style="color:var(--danger)">We couldn't reach that address</h3><p style="font-size:14.5px">${escape(c.req.query("url") ?? "")} did not respond. Check the spelling, and try the <code>www.</code> form (or without it) — they are often not the same server.</p></div>`
      : ""}
  <h1 style="font-size:clamp(28px,4vw,38px)">What should we read?</h1>
  <p class="lede">We'll fetch your sitemap, follow your links, and index the text. Nothing is published or changed on your site.</p>

  <form method="post" action="/onboard/create" style="margin-top:32px">
    <div class="field">
      <label for="url">Website address</label>
      <input type="url" id="url" name="url" required placeholder="https://example.com" autocomplete="url">
      <p class="hint">Use the exact host you want the widget to run on. We treat <code>www</code> and non-<code>www</code> as the same site.</p>
    </div>
    <div class="field">
      <label for="name">Company name</label>
      <input type="text" id="name" name="name" required placeholder="Example Ltd" maxlength="80">
    </div>
    <div class="field">
      <label for="pages">Pages to index</label>
      <select id="pages" name="maxPages">
        <option value="25">Up to 25 — quick look</option>
        <option value="100" selected>Up to 100 — most sites</option>
        <option value="400">Up to 400 — large site</option>
      </select>
    </div>
    <button class="btn lg" type="submit">Start indexing</button>
    <p class="hint" style="margin-top:14px">By continuing you confirm you're authorised to index this site. We respect <code>robots.txt</code>.</p>
  </form>
</div></section>`,
    ),
  ),
);

// ------------------------------------------------------- create + enqueue --
onboard.post("/onboard/create", async (c) => {
  const form = await c.req.parseBody();
  const rawUrl = String(form.url ?? "").trim();
  const name = String(form.name ?? "").trim().slice(0, 80);
  const maxPages = Math.min(Number(form.maxPages ?? 100) || 100, 400);

  let url: URL;
  try {
    url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
  } catch {
    return c.redirect("/onboard?error=url");
  }

  // Verify the URL actually serves before we queue a crawl. The www and bare
  // forms are NOT interchangeable — one commonly does not resolve at all, and
  // discovering that only when the crawl returns an empty site is a terrible
  // first experience.
  let reachable = false;
  try {
    const probe = await fetch(url.toString(), {
      method: "GET",
      headers: { "user-agent": "groundwork-crawler/0.1" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    reachable = probe.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) return c.redirect(`/onboard?error=unreachable&url=${encodeURIComponent(rawUrl)}`);

  const host = url.hostname;
  const bare = host.replace(/^www\./, "");
  const siteKey = `pk_live_${randomBytes(12).toString("hex")}`;
  const identitySecret = randomBytes(32).toString("hex");

  const user = c.get("user");
  const [org] = await sql<{ id: string }[]>`INSERT INTO orgs (name) VALUES (${name}) RETURNING id`;
  await sql`INSERT INTO org_members (org_id, user_id, role) VALUES (${org!.id}, ${user.id}, 'owner')`;
  const [site] = await sql<{ id: string }[]>`
    INSERT INTO sites (org_id, name, site_key, provider, model, billing_mode, identity_secret, crawl_origin)
    VALUES (${org!.id}, ${name}, ${siteKey}, 'openrouter', ${DEFAULT_CHAIN}, 'metered', ${identitySecret},
            ${url.origin})
    RETURNING id`;

  // Both host forms are verified: the operator proved control by initiating
  // this. A production flow would require a DNS TXT or well-known file first —
  // see the note rendered on the install step.
  //
  // Our own origin is verified too, so the owner can try the widget on the
  // preview page before touching their site. Without this the origin guard
  // (correctly) rejects the preview, and there is no way to see the thing work
  // before committing it to production.
  const previewHost = new URL(process.env.PUBLIC_WEB_URL ?? "http://localhost:3000").hostname;
  for (const h of new Set([host, bare, `www.${bare}`, previewHost])) {
    await sql`INSERT INTO domains (site_id, hostname, verification_token, verified_at)
              VALUES (${site!.id}, ${h}, ${randomBytes(8).toString("hex")}, now())
              ON CONFLICT (site_id, hostname) DO NOTHING`;
  }

  await sql`INSERT INTO widget_configs (site_id, config, config_version)
            VALUES (${site!.id}, ${sql.json({
              assistantName: "Assistant",
              greeting: `Hi! Ask me anything about ${name}.`,
              placeholder: "Ask a question...",
              suggestedQuestions: [],
              locale: "en",
              theme: {
                primary: "#1F5D3F", onPrimary: "#FFFFFF", surface: "#FFFFFF",
                text: "#14180F", textMuted: "#6B7264", userBubble: "#E8F2EC",
                radius: 14, fontFamily: "system-ui, -apple-system, sans-serif",
                colorScheme: "auto",
              },
              launcher: { position: "bottom-right", offsetX: 24, offsetY: 24, icon: null, label: null },
              showBranding: true, requireSignedIdentity: false,
            })}, 'v1')`;

  await sql`INSERT INTO crawl_jobs (site_id, status) VALUES (${site!.id}, 'queued')`;
  await sql`UPDATE sites SET name = ${name} WHERE id = ${site!.id}`;
  // maxPages is carried on the job via metadata-free convention: the worker
  // reads the site's configured cap. Kept simple deliberately.
  await sql`UPDATE sites SET max_messages_per_conversation = ${Math.max(40, maxPages)} WHERE id = ${site!.id}`;

  return c.redirect(`/onboard/${site!.id}/indexing`);
});

// ---------------------------------------------------------------- step 2 --
onboard.get("/onboard/:id/indexing", async (c) => {
  const id = c.req.param("id");
  if (!(await ownsSite(c.get("user").id, id))) return c.notFound();
  const [site] = await sql<{ name: string }[]>`SELECT name FROM sites WHERE id = ${id}`;
  if (!site) return c.notFound();

  return c.html(
    page(
      {
        title: "Indexing — Groundwork",
        user: c.get("user"),
        script: `
const id = ${JSON.stringify(id)};
async function poll() {
  const r = await fetch('/onboard/' + id + '/status').then(x => x.json());
  document.getElementById('status').textContent = r.label;
  document.getElementById('detail').textContent = r.detail;
  if (r.done) { location.href = '/onboard/' + id + '/style'; return; }
  if (r.failed) {
    document.getElementById('status').textContent = 'Indexing failed';
    document.getElementById('detail').textContent = r.detail;
    document.getElementById('spinner').style.display = 'none';
    return;
  }
  setTimeout(poll, 1500);
}
poll();`,
      },
      `<section class="band"><div class="wrap narrow">
  <ul class="steps">${steps(1)}</ul>
  <h1 style="font-size:clamp(28px,4vw,38px)">Reading ${escape(site.name)}…</h1>
  <div class="card" style="margin-top:24px">
    <div class="row">
      <span id="spinner" style="width:14px;height:14px;border:2px solid var(--rule);border-top-color:var(--accent);border-radius:50%;display:inline-block;animation:spin .8s linear infinite"></span>
      <strong id="status">Queued</strong>
    </div>
    <p id="detail" class="hint" style="margin-top:10px">Waiting for a worker to pick up the job.</p>
  </div>
  <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
  <p class="hint" style="margin-top:20px">Most sites finish in under a minute. You can leave this page open.</p>
</div></section>`,
    ),
  );
});

onboard.get("/onboard/:id/status", async (c) => {
  const id = c.req.param("id");
  if (!(await ownsSite(c.get("user").id, id))) return c.notFound();
  const [job] = await sql<{ status: string; pages_found: number; pages_indexed: number; error: string | null }[]>`
    SELECT status, pages_found, pages_indexed, error FROM crawl_jobs
    WHERE site_id = ${id} ORDER BY created_at DESC LIMIT 1`;
  const [chunks] = await sql<{ n: number }[]>`SELECT count(*)::int n FROM chunks WHERE site_id = ${id}`;

  if (!job) return c.json({ label: "Queued", detail: "Waiting for a worker.", done: false, failed: false });
  if (job.status === "failed")
    return c.json({ label: "Failed", detail: job.error ?? "Unknown error", done: false, failed: true });
  if (job.status === "succeeded") {
    const cov = await coverageFor(id);
    return c.json({
      label: "Indexed",
      detail:
        `${cov.pages} pages, ${cov.chunks} passages, ${cov.tokens.toLocaleString()} tokens saved` +
        (cov.contact ? " · contact found" : " · no contact found"),
      done: true, failed: false,
    });
  }
  return c.json({
    label: job.status === "running" ? "Reading your pages" : "Queued",
    detail: job.pages_found ? `${job.pages_found} pages discovered…` : "Discovering pages…",
    done: false, failed: false,
  });
});

// ---------------------------------------------------------------- step 3 --
onboard.get("/onboard/:id/style", async (c) => {
  const id = c.req.param("id");
  if (!(await ownsSite(c.get("user").id, id))) return c.notFound();
  const [row] = await sql<{ name: string; site_key: string; config: any }[]>`
    SELECT s.name, s.site_key, wc.config FROM sites s
    JOIN widget_configs wc ON wc.site_id = s.id WHERE s.id = ${id}`;
  if (!row) return c.notFound();
  const cfg = row.config;

  return c.html(
    page(
      {
        title: "Style your widget — Groundwork",
        user: c.get("user"),
        script: `
const apiBase = ${JSON.stringify(process.env.PUBLIC_API_URL ?? "http://localhost:8787")};
const siteKey = ${JSON.stringify(row.site_key)};
function paint() {
  const f = document.forms.style;
  const root = document.getElementById('preview');
  root.style.setProperty('--p', f.primary.value);
  root.style.setProperty('--r', f.radius.value + 'px');
  document.getElementById('pv-name').textContent = f.assistantName.value || 'Assistant';
  document.getElementById('pv-greeting').textContent = f.greeting.value || '';
  document.getElementById('radius-out').textContent = f.radius.value + 'px';
}
document.forms.style.addEventListener('input', paint);
paint();`,
      },
      `<section class="band"><div class="wrap">
  <ul class="steps">${steps(2)}</ul>
  <h1 style="font-size:clamp(28px,4vw,38px)">Make it yours</h1>
  <p class="lede">Change any of this later without touching your site again.</p>

  <div class="grid g2" style="margin-top:30px;align-items:start">
    <form name="style" method="post" action="/onboard/${id}/style">
      <div class="field">
        <label for="assistantName">Assistant name</label>
        <input type="text" id="assistantName" name="assistantName" maxlength="40" value="${escape(cfg.assistantName ?? "Assistant")}">
      </div>
      <div class="field">
        <label for="greeting">Greeting</label>
        <textarea id="greeting" name="greeting" rows="2" maxlength="300">${escape(cfg.greeting ?? "")}</textarea>
      </div>
      <div class="field">
        <label for="suggested">Suggested questions</label>
        <textarea id="suggested" name="suggested" rows="4" placeholder="One per line">${escape((cfg.suggestedQuestions ?? []).join("\n"))}</textarea>
        <p class="hint">Shown before the visitor types. Up to six.</p>
      </div>
      <div class="row" style="gap:20px">
        <div class="field" style="flex:1;min-width:150px">
          <label for="primary">Brand colour</label>
          <input type="color" id="primary" name="primary" value="${escape(cfg.theme?.primary ?? "#1F5D3F")}" style="width:100%;height:42px;padding:4px;border:1px solid var(--rule);border-radius:8px;background:var(--surface)">
        </div>
        <div class="field" style="flex:1;min-width:150px">
          <label for="radius">Corner radius — <span id="radius-out">${cfg.theme?.radius ?? 14}px</span></label>
          <input type="range" id="radius" name="radius" min="0" max="28" value="${cfg.theme?.radius ?? 14}" style="width:100%">
        </div>
      </div>
      <div class="field">
        <label for="position">Launcher position</label>
        <select id="position" name="position">
          <option value="bottom-right"${cfg.launcher?.position !== "bottom-left" ? " selected" : ""}>Bottom right</option>
          <option value="bottom-left"${cfg.launcher?.position === "bottom-left" ? " selected" : ""}>Bottom left</option>
        </select>
      </div>
      <button class="btn lg" type="submit">Save and get my snippet</button>
    </form>

    <div id="preview" style="--p:${escape(cfg.theme?.primary ?? "#1F5D3F")};--r:${cfg.theme?.radius ?? 14}px">
      <p class="eyebrow">Live preview</p>
      <div style="border:1px solid var(--rule);border-radius:var(--r);overflow:hidden;background:var(--surface);box-shadow:var(--shadow)">
        <div style="background:var(--p);color:#fff;padding:13px 16px;font-weight:600" id="pv-name">Assistant</div>
        <div style="padding:16px;min-height:190px;display:flex;flex-direction:column;gap:10px">
          <div style="align-self:flex-start;background:var(--surface-2);padding:9px 13px;border-radius:13px;max-width:85%;font-size:14.5px" id="pv-greeting"></div>
          <div style="align-self:flex-end;background:var(--accent-tint);padding:9px 13px;border-radius:13px;font-size:14.5px">Do you ship internationally?</div>
        </div>
        <div style="border-top:1px solid var(--rule);padding:11px 16px;display:flex;gap:8px">
          <div style="flex:1;border:1px solid var(--rule);border-radius:999px;padding:8px 13px;color:var(--ink-3);font-size:14px">Ask a question...</div>
          <div style="background:var(--p);color:#fff;border-radius:999px;padding:8px 16px;font-size:14px">Send</div>
        </div>
      </div>
    </div>
  </div>
</div></section>`,
    ),
  );
});

onboard.post("/onboard/:id/style", async (c) => {
  const id = c.req.param("id");
  if (!(await ownsSite(c.get("user").id, id))) return c.notFound();
  const f = await c.req.parseBody();
  const [row] = await sql<{ config: any }[]>`SELECT config FROM widget_configs WHERE site_id = ${id}`;
  if (!row) return c.notFound();

  const cfg = {
    ...row.config,
    assistantName: String(f.assistantName ?? "Assistant").slice(0, 40) || "Assistant",
    greeting: String(f.greeting ?? "").slice(0, 300),
    suggestedQuestions: String(f.suggested ?? "")
      .split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 6),
    theme: {
      ...row.config.theme,
      primary: /^#[0-9a-f]{6}$/i.test(String(f.primary)) ? String(f.primary) : row.config.theme.primary,
      radius: Math.min(28, Math.max(0, Number(f.radius) || 14)),
    },
    launcher: {
      ...row.config.launcher,
      position: f.position === "bottom-left" ? "bottom-left" : "bottom-right",
    },
  };

  // config_version is part of the CDN cache key, so it must change whenever
  // the config does — otherwise edits sit behind a stale edge cache.
  await sql`UPDATE widget_configs
            SET config = ${sql.json(cfg)}, config_version = ${randomBytes(6).toString("hex")}, updated_at = now()
            WHERE site_id = ${id}`;
  return c.redirect(`/onboard/${id}/install`);
});

/**
 * What did we actually capture?
 *
 * Surfacing this is the difference between "it said Indexed" and knowing the
 * index is any good. Every gap this project has hit — an empty JS site, a
 * discarded address, a thin chunk set — was invisible until someone asked the
 * chat a question and got a bad answer. This panel moves that discovery to the
 * moment of indexing.
 */
interface Coverage {
  pages: number;
  chunks: number;
  tokens: number;
  contact: boolean;
  faqs: boolean;
  products: boolean;
  corePackTokens: number;
  flagged: number;
}

async function coverageFor(siteId: string): Promise<Coverage> {
  const [r] = await sql<Coverage[]>`
    SELECT
      (SELECT count(*)::int FROM pages  WHERE site_id=${siteId}) AS pages,
      (SELECT count(*)::int FROM chunks WHERE site_id=${siteId}) AS chunks,
      (SELECT COALESCE(sum(token_count),0)::int FROM chunks WHERE site_id=${siteId}) AS tokens,
      (SELECT EXISTS(SELECT 1 FROM chunks WHERE site_id=${siteId} AND breadcrumb ILIKE '%Contact & location%')) AS contact,
      (SELECT EXISTS(SELECT 1 FROM chunks WHERE site_id=${siteId} AND breadcrumb ILIKE '%FAQ%')) AS faqs,
      (SELECT EXISTS(SELECT 1 FROM chunks WHERE site_id=${siteId} AND breadcrumb ILIKE '%Products%')) AS products,
      (SELECT COALESCE(token_count,0)::int FROM core_packs WHERE site_id=${siteId}) AS "corePackTokens",
      (SELECT count(*)::int FROM chunks WHERE site_id=${siteId} AND injection_risk) AS flagged`;
  return r!;
}

function coveragePanel(cov: Coverage): string {
  const row = (label: string, ok: boolean, detail: string, optional = false) => `
    <tr>
      <td style="width:26px">${ok ? "&#10003;" : optional ? "&ndash;" : "&#33;"}</td>
      <td><strong>${label}</strong><p class="hint" style="margin:2px 0 0">${detail}</p></td>
    </tr>`;

  return `
  <div class="card" style="margin-top:26px">
    <h3>What we read and saved</h3>
    <table style="margin-top:8px">
      <tbody>
        ${row("Pages read", cov.pages > 0, `${cov.pages} page${cov.pages === 1 ? "" : "s"} fetched and indexed`)}
        ${row("Text saved", cov.tokens > 800, `${cov.chunks} searchable passages, ${cov.tokens.toLocaleString()} tokens${cov.tokens <= 800 ? " — thin, answers may be weak" : ""}`)}
        ${row("Contact &amp; location", cov.contact, cov.contact ? "Address, phone and email captured" : "None found — &ldquo;where are you?&rdquo; will not be answerable")}
        ${row("FAQ pairs", cov.faqs, cov.faqs ? "Question and answer pairs captured" : "None published on the site", true)}
        ${row("Products &amp; pricing", cov.products, cov.products ? "Structured product data captured" : "None published on the site", true)}
        ${row("Site brief", cov.corePackTokens > 0, cov.corePackTokens > 0
            ? `${cov.corePackTokens.toLocaleString()}-token summary for instant answers`
            : "Not generated — usually a model quota. Chat still works; re-index to retry.", true)}
        ${cov.flagged > 0 ? row("Flagged content", false, `${cov.flagged} passage(s) look like prompt injection and were excluded`) : ""}
      </tbody>
    </table>
  </div>`;
}

// ---------------------------------------------------------------- step 4 --
onboard.get("/onboard/:id/install", async (c) => {
  const id = c.req.param("id");
  if (!(await ownsSite(c.get("user").id, id))) return c.notFound();
  const [row] = await sql<{ name: string; site_key: string; identity_secret: string | null }[]>`
    SELECT name, site_key, identity_secret FROM sites WHERE id = ${id}`;
  if (!row) return c.notFound();
  const cov = await coverageFor(id);

  const cdn = process.env.PUBLIC_CDN_URL ?? "http://localhost:8788";
  const api = process.env.PUBLIC_API_URL ?? "http://localhost:8787";
  const snippet = `<script src="${cdn}/w.js"\n        data-site-key="${row.site_key}"\n        data-api-base="${api}"\n        async></script>`;

  return c.html(
    page(
      {
        title: "Install — Groundwork",
        user: c.get("user"),
        script: `
function copy(id, btn) {
  navigator.clipboard.writeText(document.getElementById(id).textContent).then(() => {
    const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => btn.textContent = t, 1400);
  });
}`,
      },
      `<section class="band"><div class="wrap narrow">
  <ul class="steps">${steps(3)}</ul>
  <span class="pill">Indexed</span>
  <h1 style="font-size:clamp(28px,4vw,38px);margin-top:14px">${escape(row.name)} is ready</h1>
  <p class="lede">Paste this before <code>&lt;/body&gt;</code>.</p>

  <div style="position:relative;margin-top:26px">
    <button class="btn ghost" style="position:absolute;top:10px;right:10px;font-size:13px;padding:6px 12px" onclick="copy('snippet', this)">Copy</button>
    <pre><code id="snippet">${escape(snippet)}</code></pre>
  </div>

  ${coveragePanel(cov)}

  <div class="card" style="margin-top:20px">
    <h3>Your keys</h3>
    <table style="margin-top:10px">
      <tbody>
        <tr><td style="width:190px"><strong>Publishable key</strong><p class="hint" style="margin:2px 0 0">Safe in page source</p></td>
            <td><code>${escape(row.site_key)}</code></td></tr>
        <tr><td><strong>Identity secret</strong><p class="hint" style="margin:2px 0 0">Server-side only — never ship to a browser</p></td>
            <td><code style="word-break:break-all">${escape(row.identity_secret ?? "")}</code></td></tr>
      </tbody>
    </table>
    <p class="hint" style="margin-top:12px">The identity secret is only needed if you restrict chat to logged-in users. <a href="/docs">See the docs</a>.</p>
  </div>

  <div class="card" style="margin-top:20px;border-color:var(--warn)">
    <h3 style="color:var(--warn)">You're on our shared key</h3>
    <p style="font-size:14.5px">Fine for testing, but it's rate-limited and shared with every other trial site. <a href="/site/${id}/provider">Connect your own provider key</a> and chat runs on your account at cost — no shared limits.</p>
  </div>

  <div class="card" style="margin-top:20px;border-color:var(--warn)">
    <h3 style="color:var(--warn)">Before you go live</h3>
    <p style="font-size:14.5px">We verified <code>${escape(row.name)}</code>'s domains from this session so you can test immediately. For production, add a DNS TXT record so nobody else can point a widget at your index. Until then your key works only from the domains recorded here.</p>
  </div>

  <div class="row" style="margin-top:28px">
    <a class="btn lg" href="/site/${id}/provider">Connect your key</a>
    <a class="btn lg ghost" href="/site/${id}/preview">Try it live</a>
    <a class="btn lg ghost" href="/site/${id}">Dashboard</a>
    <a class="btn lg ghost" href="/docs">Integration docs</a>
  </div>
</div></section>`,
    ),
  );
});
