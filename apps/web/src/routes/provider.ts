import { Hono } from "hono";
import { createCipheriv, randomBytes } from "node:crypto";
import { sql } from "@groundwork/db";
import { ALL_MODELS, DEFAULT_MODEL, getProvider, type ProviderId } from "@groundwork/providers";
import { page } from "../lib/layout.js";
import { escape } from "../lib/html.js";
import { type AuthEnv, ownsSite, requireAuth } from "../lib/auth.js";

export const provider = new Hono<AuthEnv>();

// Scoped to "/site/*", not "*" — provider is mounted at "/" in index.ts, so
// an unscoped wildcard here would gate every route registered after it
// app-wide (e.g. /health), not just this router's own pages.
provider.use("/site/*", requireAuth());

/**
 * Provider connection — the step that was missing entirely.
 *
 * Every site was created in metered mode against the platform key, and there
 * was no path in the product to attach your own. The encryption code, the
 * provider_keys table and the byok branch of resolveKey() all existed and had
 * never once been exercised, which is why the table sat empty while owners hit
 * OUR quota.
 */

function masterKey(): Buffer {
  const b64 = process.env.MASTER_KEY_B64;
  if (!b64) throw new Error("MASTER_KEY_B64 is not set");
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("MASTER_KEY_B64 must decode to 32 bytes");
  return k;
}

function seal(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

const PROVIDERS: { id: ProviderId; label: string; hint: string; where: string }[] = [
  { id: "anthropic", label: "Anthropic (Claude)", hint: "sk-ant-…", where: "console.anthropic.com" },
  { id: "gemini", label: "Google Gemini", hint: "AIza…", where: "aistudio.google.com" },
  { id: "openrouter", label: "OpenRouter", hint: "sk-or-v1-…", where: "openrouter.ai/keys" },
];

provider.get("/site/:id/provider", async (c) => {
  const id = c.req.param("id");
  if (!(await ownsSite(c.get("user").id, id))) return c.notFound();
  const [site] = await sql<{
    name: string; billing_mode: string; provider: ProviderId; model: string;
  }[]>`SELECT name, billing_mode, provider, model FROM sites WHERE id = ${id}`;
  if (!site) return c.notFound();

  const [key] = await sql<{ provider: ProviderId; key_last4: string; status: string; validated_at: string | null }[]>`
    SELECT provider, key_last4, status, validated_at FROM provider_keys WHERE site_id = ${id}`;

  const err = c.req.query("error");
  const ok = c.req.query("ok");

  const modelOptions = (p: ProviderId) =>
    Object.values(ALL_MODELS[p])
      .map((m) => `<option value="${escape(m.id)}"${site.model.split(",")[0]?.trim() === m.id ? " selected" : ""}>${escape(m.displayName)}</option>`)
      .join("");

  return c.html(
    page(
      {
        title: `Connect a provider — ${site.name}`,
        user: c.get("user"),
        script: `
const MODELS = ${JSON.stringify(
          Object.fromEntries(
            (Object.keys(ALL_MODELS) as ProviderId[]).map((p) => [
              p, Object.values(ALL_MODELS[p]).map((m) => ({ id: m.id, name: m.displayName })),
            ]),
          ),
        )};
const sel = document.getElementById('provider');
const models = document.getElementById('model');
const hint = document.getElementById('keyhint');
const HINTS = ${JSON.stringify(Object.fromEntries(PROVIDERS.map((p) => [p.id, { hint: p.hint, where: p.where }])))};
function fill(list) {
  models.innerHTML = list.map(m => '<option value="' + m.id + '">' + m.name + '</option>').join('');
}
function sync() {
  const p = sel.value;
  fill(MODELS[p]);
  document.getElementById('apikey').placeholder = HINTS[p].hint;
  hint.textContent = 'Create one at ' + HINTS[p].where + '. We validate it before saving.';
}
sel.addEventListener('change', sync);
sync();

// Once a key is entered, replace the fallback list with the provider's own.
// A stale hardcoded id is exactly how a retired model became the default.
let t;
document.getElementById('apikey').addEventListener('input', (e) => {
  clearTimeout(t);
  const key = e.target.value.trim();
  if (key.length < 20) return;
  t = setTimeout(async () => {
    hint.textContent = 'Looking up available models\u2026';
    try {
      const r = await fetch(location.pathname + '/models', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: sel.value, apikey: key }),
      });
      const d = await r.json();
      if (d.models && d.models.length) {
        fill(d.models);
        hint.textContent = d.models.length + ' models available on this key.';
      } else {
        hint.textContent = d.error ? ('Could not list models: ' + d.error) : 'Key not accepted yet.';
      }
    } catch { hint.textContent = 'Could not reach the provider.'; }
  }, 600);
});`,
      },
      `<section class="band"><div class="wrap narrow">
  <p class="eyebrow">${escape(site.name)}</p>
  <h1 style="font-size:clamp(26px,3.6vw,34px)">Connect your AI provider</h1>
  <p class="lede">Bring your own key and you pay your provider directly at cost. Leave it and you run on ours, which is fine for testing but rate-limited.</p>

  ${err ? `<div class="card" style="border-color:var(--danger);margin-top:20px"><h3 style="color:var(--danger)">Key rejected</h3><p style="font-size:14.5px">${escape(err)}</p></div>` : ""}
  ${ok ? `<div class="card" style="border-color:var(--accent);margin-top:20px"><h3 style="color:var(--accent)">Connected</h3><p style="font-size:14.5px">Your key was validated and stored encrypted. Chat now runs on your account.</p></div>` : ""}

  <div class="card" style="margin-top:22px">
    <h3>Current setup</h3>
    <table style="margin-top:8px"><tbody>
      <tr><td style="width:150px"><strong>Mode</strong></td>
          <td>${site.billing_mode === "byok"
              ? `<span class="pill">Your own key</span>`
              : `<span class="pill warn">Our shared key</span> <span class="hint">rate-limited, for testing</span>`}</td></tr>
      <tr><td><strong>Provider</strong></td><td>${escape(site.provider)}</td></tr>
      <tr><td><strong>Model</strong></td><td><code>${escape(site.model.split(",")[0] ?? "")}</code>${site.model.includes(",") ? ` <span class="hint">+${site.model.split(",").length - 1} fallback(s)</span>` : ""}</td></tr>
      ${key ? `<tr><td><strong>Key on file</strong></td><td><code>••••${escape(key.key_last4)}</code> — ${key.status === "active" ? "active" : `<span style="color:var(--danger)">${escape(key.status)}</span>`}</td></tr>` : ""}
    </tbody></table>
  </div>

  <form method="post" action="/site/${id}/provider" style="margin-top:26px">
    <div class="field">
      <label for="provider">Provider</label>
      <select id="provider" name="provider">
        ${PROVIDERS.map((p) => `<option value="${p.id}"${site.provider === p.id ? " selected" : ""}>${escape(p.label)}</option>`).join("")}
      </select>
    </div>
    <div class="field">
      <label for="apikey">API key</label>
      <input type="text" id="apikey" name="apikey" autocomplete="off" spellcheck="false" required>
      <p class="hint" id="keyhint"></p>
    </div>
    <div class="field">
      <label for="model">Model</label>
      <select id="model" name="model">${modelOptions(site.provider)}</select>
    </div>
    <button class="btn lg" type="submit">Validate and connect</button>
    <p class="hint" style="margin-top:12px">Your key is encrypted at rest and only ever used server-side. It is never sent to a browser and never appears in the widget.</p>
  </form>

  ${key ? `<form method="post" action="/site/${id}/provider/disconnect" style="margin-top:20px">
    <button class="btn ghost" type="submit">Disconnect and use our shared key</button>
  </form>` : ""}

  <p style="margin-top:28px"><a href="/site/${id}">&larr; Back to dashboard</a></p>
</div></section>`,
    ),
  );
});

/**
 * Live model list for the key the user is currently typing.
 *
 * The picker used to be built from a hardcoded table, which is how a retired
 * Gemini model ended up as the default and 404'd. The provider's own list is
 * the only authoritative one.
 */
provider.post("/site/:id/provider/models", async (c) => {
  if (!(await ownsSite(c.get("user").id, c.req.param("id")))) return c.notFound();
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const providerId = String(body.provider ?? "") as ProviderId;
  const apiKey = String(body.apikey ?? "").trim();
  if (!ALL_MODELS[providerId] || !apiKey) return c.json({ models: [] }, 400);
  try {
    const models = await getProvider(providerId).listModels(apiKey);
    return c.json({ models: models.map((m) => ({ id: m.id, name: m.displayName })) });
  } catch (err) {
    return c.json({ models: [], error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

provider.post("/site/:id/provider", async (c) => {
  const id = c.req.param("id");
  if (!(await ownsSite(c.get("user").id, id))) return c.notFound();
  const f = await c.req.parseBody();
  const providerId = String(f.provider ?? "") as ProviderId;
  const apiKey = String(f.apikey ?? "").trim();
  const model = String(f.model ?? "").trim();

  if (!ALL_MODELS[providerId]) return c.redirect(`/site/${id}/provider?error=Unknown+provider`);
  if (!apiKey) return c.redirect(`/site/${id}/provider?error=No+key+provided`);

  const p = getProvider(providerId);

  // Validate BEFORE storing. A key that fails here would otherwise surface to
  // visitors as "the assistant is temporarily unavailable" with no clue why.
  const check = await p.validateKey(apiKey);
  if (!check.valid) {
    return c.redirect(
      `/site/${id}/provider?error=${encodeURIComponent(check.reason ?? "the provider rejected this key")}`,
    );
  }

  // Then PROVE the chosen model can actually hold a conversation.
  //
  // Capability filtering is a heuristic over whatever fields a provider
  // happens to expose, and it has already failed once: an image model
  // ("nano-banana-pro") advertised generateContent, passed the filter, and
  // reached a visitor as "too many messages" — a quota error for a model that
  // was never going to answer. One real generation is the only thing that
  // settles it, and it costs a handful of tokens.
  const chosen = model || DEFAULT_MODEL[providerId];
  try {
    let text = "";
    for await (const ev of p.chat(apiKey, {
      model: chosen,
      system: [{ text: "Reply with exactly the word: ok" }],
      messages: [{ role: "user", content: "ok?" }],
      maxTokens: 16,
    })) {
      if (ev.type === "delta") text += ev.text;
    }
    if (text.trim().length === 0) {
      return c.redirect(
        `/site/${id}/provider?error=${encodeURIComponent(
          `${chosen} accepted the request but returned no text — it is probably an image, audio or embedding model. Pick a text model.`,
        )}`,
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return c.redirect(
      `/site/${id}/provider?error=${encodeURIComponent(`${chosen} could not answer: ${detail.slice(0, 200)}`)}`,
    );
  }

  const dek = randomBytes(32);
  const keyCiphertext = seal(apiKey, dek);
  const wrappedDek = seal(dek.toString("base64"), masterKey());

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO provider_keys (site_id, provider, key_ciphertext, wrapped_dek, key_last4, status, validated_at)
      VALUES (${id}, ${providerId}, ${keyCiphertext}, ${wrappedDek}, ${apiKey.slice(-4)}, 'active', now())
      ON CONFLICT (site_id, provider) DO UPDATE
        SET key_ciphertext = EXCLUDED.key_ciphertext,
            wrapped_dek    = EXCLUDED.wrapped_dek,
            key_last4      = EXCLUDED.key_last4,
            status         = 'active',
            validated_at   = now()`;
    await tx`
      UPDATE sites SET billing_mode = 'byok', provider = ${providerId}, model = ${chosen}
      WHERE id = ${id}`;
  });

  return c.redirect(`/site/${id}/provider?ok=1`);
});

provider.post("/site/:id/provider/disconnect", async (c) => {
  const id = c.req.param("id");
  if (!(await ownsSite(c.get("user").id, id))) return c.notFound();
  await sql.begin(async (tx) => {
    await tx`DELETE FROM provider_keys WHERE site_id = ${id}`;
    await tx`UPDATE sites SET billing_mode = 'metered' WHERE id = ${id}`;
  });
  return c.redirect(`/site/${id}/provider`);
});
