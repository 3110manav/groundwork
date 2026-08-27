import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sql } from "@groundwork/db";
import {
  ChatError,
  ChatRequestSchema,
  encodeSSE,
  OWNER_ACTIONABLE,
  type ChatStreamEvent,
  type Source,
} from "@groundwork/contracts";
import { getModelInfo, getProvider, ProviderError, type ProviderId, type Turn } from "@groundwork/providers";
import { retrieve } from "../lib/retrieve.js";
import { assemble, decideCachePolicy, windowHistory } from "../lib/prompt.js";
import { markKeyInvalid, resolveKey } from "../lib/keys.js";
import * as meter from "../lib/meter.js";
import * as semanticCache from "../lib/semantic-cache.js";
import { take, takeTenantSlot } from "../lib/ratelimit.js";
import {
  checkAnswer,
  checkGrounding,
  checkInput,
  neutralize,
  verifyIdentity,
  UNTRUSTED_CONTENT_RULE,
} from "@groundwork/guards";

export const chatRoutes = new Hono();

interface SiteContext {
  id: string;
  site_key: string;
  billing_mode: "byok" | "metered";
  provider: ProviderId;
  model: string;
  index_version: number;
  assistant_name: string;
  core_pack: string | null;
  allowed_hosts: string[];
  identity_secret: string | null;
  require_signed_identity: boolean;
  max_messages_per_conversation: number;
}

async function loadSite(siteKey: string): Promise<SiteContext | null> {
  const rows = await sql<SiteContext[]>`
    SELECT s.id, s.site_key, s.billing_mode, s.provider, s.model, s.index_version,
           s.identity_secret, s.require_signed_identity, s.max_messages_per_conversation,
           COALESCE(wc.config->>'assistantName', 'Assistant') AS assistant_name,
           cp.content AS core_pack,
           COALESCE(
             (SELECT array_agg(d.hostname) FROM domains d
              WHERE d.site_id = s.id AND d.verified_at IS NOT NULL),
             ARRAY[]::text[]
           ) AS allowed_hosts
    FROM sites s
    LEFT JOIN widget_configs wc ON wc.site_id = s.id
    LEFT JOIN core_packs cp ON cp.site_id = s.id
    WHERE s.site_key = ${siteKey}
  `;
  return rows[0] ?? null;
}

/**
 * Fail CLOSED.
 *
 * This previously returned `true` when a site had no verified domains, on the
 * reasoning that an unconfigured site was in "dev mode". In practice every
 * site starts unconfigured, so the default was: any site key works from any
 * origin on the internet. A guard whose default is "allow" is not a guard.
 *
 * Origin is spoofable outside a browser, so this stops accidental and casual
 * misuse only — rate limits, the budget ceiling and signed identity are what
 * bound a determined abuser.
 */
function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return false;
  if (!origin) return false;
  try {
    return allowed.includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lets a returning visitor see their own prior turns after a page reload.
 * The widget persists conversationId in localStorage (scoped to the site's own
 * origin already) and calls this on mount — the id is unguessable, but we
 * still scope the lookup to THIS site so one tenant's widget can never read
 * another tenant's conversation even by a leaked or malformed id.
 */
chatRoutes.get("/v1/history/:conversationId", async (c) => {
  const siteKey = c.req.header("x-site-key");
  const origin = c.req.header("origin");
  const conversationId = c.req.param("conversationId");

  if (!siteKey) return c.json({ error: "missing_site_key" }, 401);
  if (!UUID_RE.test(conversationId)) return c.json({ error: "not_found" }, 404);

  const site = await loadSite(siteKey);
  if (!site) return c.json({ error: "unknown_site" }, 404);
  if (!originAllowed(origin, site.allowed_hosts)) return c.json({ error: "origin_not_allowed" }, 403);

  const rows = await sql<{ role: "user" | "assistant"; content: string; sources: Source[] }[]>`
    SELECT m.role, m.content, m.sources
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.conversation_id = ${conversationId} AND c.site_id = ${site.id}
    ORDER BY m.created_at ASC
  `;
  // Empty array either way — an unknown or foreign conversation id is
  // indistinguishable from an empty one, so nothing is leaked either way.
  return c.json({ messages: rows });
});

chatRoutes.post("/v1/chat", async (c) => {
  const siteKey = c.req.header("x-site-key");
  const origin = c.req.header("origin");
  const started = Date.now();

  if (!siteKey) return c.json({ error: "missing_site_key" }, 401);

  const site = await loadSite(siteKey);
  if (!site) return c.json({ error: "unknown_site" }, 404);

  // One layer of several. Origin is spoofable outside a browser, so it stops
  // casual embedding on the wrong domain, not a determined abuser.
  if (!originAllowed(origin, site.allowed_hosts)) {
    console.warn(
      `[origin] rejected site=${site.id} origin=${origin ?? "(none)"} allowed=[${site.allowed_hosts.join(",")}]`,
    );
    return c.json({ error: "origin_not_allowed" }, 403);
  }

  const body = ChatRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const { message, conversationId } = body.data;

  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  return streamSSE(c, async (stream) => {
    const send = (e: ChatStreamEvent) => stream.write(encodeSSE(e));

    const fail = async (err: ChatError) => {
      // ALWAYS log. OWNER_ACTIONABLE decides whether to NOTIFY the site owner,
      // not whether the failure is worth recording — an earlier version
      // conflated the two, so an internal error reached the browser as
      // "Something went wrong" while the server log stayed completely empty.
      const ownerActionable = OWNER_ACTIONABLE.has(err.code);
      const scope = ownerActionable ? "owner-actionable" : "internal";
      console.error(`[${scope}] site=${site.id} code=${err.code} :: ${err.detail ?? "(no detail)"}`);

      if (ownerActionable) {
        // Record it where the owner can actually see it. Upsert-and-count so a
        // recurring fault is one dashboard row with a tally, not a flood.
        await sql`
          INSERT INTO site_alerts (site_id, code, detail)
          VALUES (${site.id}, ${err.code}, ${err.detail ?? ""})
          ON CONFLICT (site_id, code) DO UPDATE
            SET detail = EXCLUDED.detail,
                seen_count = site_alerts.seen_count + 1,
                last_seen = now()
        `.catch((e) => console.error("[alerts] insert failed", e));
      }
      await send({ type: "error", ...err.toPublic() });
    };

    try {
      // Cheapest checks first: nothing below costs an embedding or a token.
      const input = checkInput(message);
      if (!input.ok) throw new ChatError("invalid_request", `input rejected: ${input.reason}`);

      const identity = verifyIdentity(
        body.data.user,
        site.identity_secret,
        site.require_signed_identity,
      );
      if (!identity.ok) throw new ChatError("provider_auth", `identity: ${identity.reason}`);

      if (!(await take(`ip:${ip}`, 20, 60)) || !(await takeTenantSlot(site.id))) {
        throw new ChatError("rate_limited", `ip=${ip} site=${site.id}`, true);
      }
      if (await meter.isOverBudget(site.id)) {
        throw new ChatError("budget_exceeded", `site=${site.id} hit monthly ceiling`);
      }

      // ---- conversation ----
      let convId = conversationId;
      if (convId) {
        const [count] = await sql<{ n: number }[]>`
          SELECT count(*)::int n FROM messages WHERE conversation_id = ${convId}`;
        if ((count?.n ?? 0) >= site.max_messages_per_conversation * 2) {
          throw new ChatError(
            "rate_limited",
            `conversation ${convId} hit its ${site.max_messages_per_conversation}-turn cap`,
          );
        }
      }
      if (!convId) {
        const rows = await sql<{ id: string }[]>`
          INSERT INTO conversations (site_id) VALUES (${site.id}) RETURNING id
        `;
        convId = rows[0]!.id;
      }
      const msgRows = await sql<{ id: string }[]>`
        INSERT INTO messages (conversation_id, role, content)
        VALUES (${convId}, 'user', ${message}) RETURNING id
      `;
      await send({ type: "start", conversationId: convId, messageId: msgRows[0]!.id });

      // ---- 1. semantic cache: zero LLM tokens on a hit ----
      const { hit, embedding } = await semanticCache.lookup(site.id, site.index_version, message);
      if (hit) {
        await send({ type: "sources", sources: hit.sources });
        await send({ type: "delta", text: hit.answer });
        await send({ type: "done", finishReason: "stop" });
        await sql`
          INSERT INTO messages (conversation_id, role, content, sources)
          VALUES (${convId}, 'assistant', ${hit.answer}, ${sql.json(hit.sources)})
        `;
        await meter.record({
          siteId: site.id,
          conversationId: convId,
          provider: site.provider,
          model: site.model,
          usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
          billingMode: site.billing_mode,
          latencyMs: Date.now() - started,
          semanticCacheHit: true,
        });
        return;
      }

      // ---- 2. retrieval + confidence gate ----
      const { chunks, gated } = await retrieve(site.id, message);
      if (gated) {
        // No LLM call at all. Free, faster, and it removes the hallucination
        // class that gets widgets uninstalled.
        const answer = "I couldn't find that on this site. Try the contact page and someone can help.";
        await send({ type: "delta", text: answer });
        await send({ type: "done", finishReason: "stop" });
        await sql`
          INSERT INTO messages (conversation_id, role, content, unanswered)
          VALUES (${convId}, 'assistant', ${answer}, true)
        `;
        return;
      }

      const sources: Source[] = chunks.map((ch) => ({
        url: ch.url,
        title: ch.breadcrumb.split(">").pop()?.trim() || ch.url,
        breadcrumb: ch.breadcrumb,
      }));
      await send({ type: "sources", sources });

      // ---- 3. history window ----
      const historyRows = await sql<{ role: "user" | "assistant"; content: string }[]>`
        SELECT role, content FROM messages
        WHERE conversation_id = ${convId}
        ORDER BY created_at ASC
      `;
      const priorTurns: Turn[] = historyRows.slice(0, -1);
      const { kept } = windowHistory(priorTurns);

      const summaryRows = await sql<{ summary: string | null }[]>`
        SELECT summary FROM conversations WHERE id = ${convId}
      `;

      // ---- 4. cache-aware assembly ----
      // Retrieved text is UNTRUSTED — anything a third party can publish on the
      // customer's site reaches this prompt. Strip role markup, then let the
      // system prompt state that context is data, never instruction.
      const safeChunks = chunks.map((ch) => ({ ...ch, content: neutralize(ch.content) }));

      const modelInfo = getModelInfo(site.provider, site.model.split(",")[0]!.trim());
      const draft = assemble({
        assistantName: site.assistant_name,
        corePack: `${UNTRUSTED_CONTENT_RULE}\n\n${site.core_pack ?? "(no site brief has been generated yet)"}`,
        chunks: safeChunks,
        history: kept,
        conversationSummary: summaryRows[0]?.summary ?? null,
        question: message,
        useExplicitCache: true,
      });

      const policy = decideCachePolicy({
        prefixTokens: draft.cacheablePrefixTokens,
        minCacheablePrefixTokens: modelInfo?.minCacheablePrefixTokens ?? 1024,
        requestsPerHour: 100, // TODO: read from a rolling counter per site
        providerChargesForIdleCache: site.provider === "gemini",
      });

      const prompt =
        policy.useExplicitCache
          ? draft
          : assemble({
              assistantName: site.assistant_name,
              corePack: `${UNTRUSTED_CONTENT_RULE}\n\n${site.core_pack ?? "(no site brief has been generated yet)"}`,
              chunks: safeChunks,
              history: kept,
              conversationSummary: summaryRows[0]?.summary ?? null,
              question: message,
              useExplicitCache: false,
            });

      // ---- 5. the one place byok and metered diverge ----
      // resolveKey may return several comma-separated platform keys. Each
      // carries its own upstream quota, so an exhausted key is a reason to try
      // the NEXT KEY, not just the next model.
      const resolved = await resolveKey(site);
      const apiKeys = resolved.key.split(",").map((k) => k.trim()).filter(Boolean);
      const provider = getProvider(site.provider);
      console.log(
        `[chat] site=${site.id} using ${resolved.source} key ••••${resolved.last4}` +
          (apiKeys.length > 1 ? ` (+${apiKeys.length - 1} more)` : ""),
      );

      // sites.model may hold a comma-separated chain. Free models rate-limit
      // per upstream provider, so falling ACROSS models is what works —
      // retrying one model through a 429 mostly does not.
      const chain = site.model.split(",").map((m) => m.trim()).filter(Boolean);

      let answer = "";
      let finishReason: "stop" | "length" | "refusal" = "stop";
      let usage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
      let usedModel = chain[0]!;
      let served = false;

      const attempts: { key: string; model: string }[] = [];
      for (const key of apiKeys) for (const model of chain) attempts.push({ key, model });

      for (const [attemptIndex, attempt] of attempts.entries()) {
        const candidate = attempt.model;
        const isLast = attemptIndex === attempts.length - 1;
        // Buffer rather than streaming straight through: an answer has to pass
        // checkAnswer() before the visitor sees any of it, and a rejected one
        // must be replaceable by the next model in the chain.
        let draft = "";
        try {
          for await (const ev of provider.chat(attempt.key, {
            model: candidate,
            system: prompt.system,
            messages: prompt.messages,
            maxTokens: 600, // output is 5x input; this is where the money goes
            effort: "low",
          })) {
            if (ev.type === "delta") draft += ev.text;
            else {
              usage = ev.usage;
              finishReason = ev.finishReason;
            }
          }
        } catch (err) {
          // provider_quota is not retryable on THIS key but the next key has
          // its own quota, so it is worth advancing past too.
          const advance =
            err instanceof ProviderError && (err.retryable || err.code === "provider_quota");
          if (advance && !isLast) {
            console.warn(`[chat] ${candidate} ${(err as ProviderError).code}, advancing`);
            continue;
          }
          throw err;
        }

        const contextText = safeChunks.map((ch) => ch.content).join("\n");
        const guards: [string, { ok: boolean; reason?: string }][] = [
          ["answer", checkAnswer(draft)],
          ["grounding", checkGrounding(draft, `${contextText}\n${site.core_pack ?? ""}`)],
        ];
        const failed = guards.find(([, v]) => !v.ok);

        if (failed) {
          const [guardName, verdict] = failed;
          console.warn(`[chat] ${guardName} guard rejected ${candidate}: ${verdict.reason}`);
          await sql`
            INSERT INTO blocked_answers (site_id, question, answer, model, guard, reason)
            VALUES (${site.id}, ${message}, ${draft}, ${candidate}, ${guardName}, ${verdict.reason ?? ""})
          `;
          if (!isLast) continue;
          throw new ChatError("upstream_unavailable", "all models returned unusable answers");
        }

        answer = draft;
        usedModel = candidate;
        served = true;
        break;
      }

      if (!served) throw new ChatError("upstream_unavailable", "no model in the chain answered");

      await send({ type: "delta", text: answer });
      await send({ type: "done", finishReason });

      // ---- 6. persist, cache, meter ----
      await sql`
        INSERT INTO messages (conversation_id, role, content, sources)
        VALUES (${convId}, 'assistant', ${answer}, ${sql.json(sources)})
      `;
      if (finishReason === "stop" && answer.length > 0) {
        await semanticCache.store(site.id, site.index_version, message, embedding, answer, sources);
      }
      await meter.record({
        siteId: site.id,
        conversationId: convId,
        provider: site.provider,
        model: usedModel,
        usage,
        billingMode: site.billing_mode,
        latencyMs: Date.now() - started,
        semanticCacheHit: false,
      });
    } catch (err) {
      if (err instanceof ProviderError) {
        if (err.code === "provider_auth") await markKeyInvalid(site.id, site.provider);
        await fail(new ChatError(err.code, err.message, err.retryable));
      } else if (err instanceof ChatError) {
        await fail(err);
      } else {
        console.error("[chat] unhandled", err);
        await fail(new ChatError("internal", String(err)));
      }
    }
  });
});
