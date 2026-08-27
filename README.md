# Groundwork

**Chat that only says what your site says.**

One script tag on any website. The crawler indexes it; the widget answers
visitor questions from that content on the site owner's own model provider key,
metered end to end, with six guards between a question and an answer.

Product surfaces live in `apps/web`: landing page, four-step onboarding, a
live preview, docs, and a per-site dashboard.

Full design rationale lives in the architecture doc. This file covers the repo.

## Why one repo

The widget and the API share a contract — `config.json`, the session token, the
SSE envelope, the error enum — and those change weekly early on. Across two
repos every change becomes a version dance: edit API, publish types, bump SDK,
install, test, deploy in order. Across one repo it is a single PR where the
type error shows up on both sides immediately. `packages/contracts` is the
whole argument.

Deployment is still independent: the widget builds to CDN, api and worker to
containers. A monorepo does not imply lockstep deploys.

## Layout

```
apps/
  web/        landing, onboarding, preview, docs, dashboard (Hono, server-rendered)
  api/        runtime plane — chat, retrieve, stream, meter (public, SSE, scales on concurrency)
  worker/     ingestion — crawl, extract, chunk, embed, index (long-running, memory-hungry)
packages/
  contracts/  zod schemas shared by widget + api
  providers/  LLMProvider adapters (anthropic, gemini)
  pricing/    price book + cost computation
  db/         schema, migrations, client
  widget/     browser SDK → CDN bundle
```

The split in `apps/` is by traffic characteristic, not frontend/backend. `api`
is public, site-key authenticated, and holds long-lived streams. `worker` is
none of those things.

`apps/dashboard` is not built yet — see Not built below.

## Prerequisites

- Node 20+ and pnpm 9+ (`corepack enable && corepack prepare pnpm@9 --activate`)
- Postgres 16 with **pgvector >= 0.7** (`halfvec` needs it) — Postgres.app, Homebrew, or `pnpm db:up` for Docker
- Redis

## Setup — once

```bash
cp .env.example .env     # fill in OPENROUTER_API_KEY and DATABASE_URL
pnpm setup               # install, build the widget, run migrations
```

## Run — every time

```bash
redis-server --daemonize yes    # if not already running
pnpm dev                        # api :8787 + worker + web :3000
```

Open <http://localhost:3000>. Stop with `pnpm stop`.

Every process loads `.env` itself via `--env-file`, so there is no
`set -a; source .env` ritual and no dependence on which directory you ran from.

### Tests

`apps/api` has integration tests that need a migrated database:

```bash
DATABASE_URL=postgres://$USER@localhost:5432/chatsdk pnpm --filter @groundwork/api test
```

They cover the two things that were wrong on the first pass (see below). Both
were invisible to `tsc` and only appeared when run against real Postgres — so
if you change `retrieve.ts`, run these.

Index a site:

```bash
pnpm --filter @groundwork/worker crawl <siteId> https://example.com "Example"
```

## The parts that carry the design

**`packages/providers/src/types.ts`** — `SystemBlock[]` with a `cacheable` flag.
Callers declare which blocks are stable; each adapter decides how to express
that to its provider. No provider-specific cache code escapes the adapter.

**`gemini.ts` usage mapping** — Gemini's `promptTokenCount` *includes* cached
tokens; Anthropic's `input_tokens` excludes them. Our contract says
`inputTokens` is always the uncached remainder, so the Gemini adapter subtracts.
Forget this and every cached turn is billed twice. This asymmetry is the single
best argument for owning the adapter layer rather than using a framework.

**`apps/api/src/lib/prompt.ts`** — cache-aware assembly. Stable prefix (persona
+ site core pack) above the breakpoint, volatile content (chunks, history,
question) below it. `decideCachePolicy` handles the two ways caching silently
fails: a prefix under the provider minimum, and Gemini's hourly cache storage
charge costing a low-traffic site more than it saves.

**`apps/worker/src/extract.ts`** — `stripBoilerplate` removes text repeating
across >40% of pages. On a 500-page site that is 30–50% of everything, and it
is text you would otherwise pay to embed once and retrieve hundreds of times.

**`packages/pricing/src/price-book.ts`** — `verified: boolean` is load-bearing,
not documentation. Unverified entries still compute a cost, but flag every
usage row so the dashboard labels it an estimate.

## Crawler findings (from the first real crawl)

Five bugs, all found by running against one real site. Every one failed
silently — none would have surfaced as an error.

| Bug | Symptom | Fix |
|---|---|---|
| Sitemap treated as authoritative | Site's sitemap listed 1 URL; it has 4 real pages. Indexed 1/4 of the site. | Sitemap **seeds** the crawl; BFS from there under robots rules |
| robots `Disallow` ignored | We read only `Sitemap:` lines and crawled disallowed paths | Parse and honour the `User-agent: *` group |
| No URL canonicalisation | `www.x.com/a` and `x.com/a` indexed as two pages — double the embedding spend, duplicate results crowding every top-k | `canonicalize()` collapses host, scheme, trailing slash, tracking params |
| Stale pages never removed | Re-crawl deleted chunks but left orphaned `pages` rows | Delete pages no longer reachable |
| Core pack silently garbage | `openrouter/free` auto-routed the ingest prompt to a **content-safety classifier**, which returned `"User Safety: safe"` — 5 tokens, stored without complaint, and it would have become the assistant's entire standing knowledge of the company | Pin a model chain, never the auto-router; refuse to store a core pack under 400 tokens |

Two further notes worth keeping:

- **Free-model rate limits are per upstream provider, not per account.** Retrying
  the same model through a 429 with exponential backoff failed four times while
  three other models answered instantly — on an account with $0.0002 of lifetime
  usage. Falling *across* models is what works; `acrossModels()` in
  `core-pack.ts` does that.
- **JS-rendered pages are now reported, not swallowed.** The crawl warns which
  URLs looked JS-rendered and were indexed unrendered. Until the headless pool
  lands, that warning is the only thing standing between you and a quietly thin
  index.

## The chunking bug — worth reading before blaming a model

Symptom: some answers were thin and vague, which reads like a weak model.
Cause: chunking, not the model and not the scraper.

The chunker flushed on **every heading change**. Marketing pages are
heading-dense, so one real 4-page site produced 42 chunks averaging **85
tokens** against a 420 target. Retrieval's top-5 therefore handed the model
~425 tokens of shredded context instead of ~2,000 coherent ones.

| | chunks | avg tokens | context at top-5 |
|---|---:|---:|---:|
| Before | 42 | 85 | ~425 tok |
| After | 10 | 363 | ~2,176 tok |

Same site, same crawl, same free model — answers went from generic to naming
Forward Deployed Engineering, fractional CTO/CMO, and all three booking paths.

The lesson generalises: **when RAG answers are weak, measure the context before
changing the model.** Chunk size, retrieval depth and the reranker all move
answer quality more than the model does, and all three are cheaper to fix.

## Extraction: full DOM, not Readability

The original extractor was Mozilla Readability — a **news-article** extractor
that finds "the article" and discards the rest. On a business site the rest
*is* the content: service grids, pricing tables, FAQ accordions, footers,
contact strips. Every silent-empty-index bug in this project traces to that one
choice, and each earlier fix was a patch around it.

`extract.ts` now walks the full DOM and keeps every visible text-bearing
element — headings, **tables as markdown** (pricing lives there), lists,
definition lists, blockquotes, captions, descriptive alt text. De-boilerplating
moved downstream to cross-page shingling, which is a better signal than DOM
position and **never deletes something that appears once** — Readability's exact
failure with addresses.

`structured.ts` harvests schema.org JSON-LD (FAQ pairs, products with prices,
services, hours) plus visible FAQ accordions. Machine-authored, exact, and
previously ignored entirely because it lives in `<script>` tags.

Measured on one real site: 3,583 -> 6,133 tokens indexed. `@mozilla/readability`
and `turndown` are no longer dependencies.

### Every crawl reports its coverage

```
crawl <id>: 13 pages -> 13 chunks, 3165 tokens
  coverage: faqs=0 products=0 services=0 contact=yes rendered=13 unrendered-shells=0
```

Plus a warning when total tokens are implausibly low. A thin index announces
itself here instead of surfacing as a bad answer days later — which is how
every previous gap was found.

## Connecting your own provider key

This was **missing entirely**. Every site was created in metered mode against
the platform key, and nothing in the product let an owner attach their own —
so `provider_keys` sat empty, the envelope-encryption code had never executed,
and the `byok` branch of `resolveKey()` had never run in anger. Owners hit
*our* shared quota with no way out.

`/site/:id/provider` now handles it: pick provider, paste key, pick model. The
key is **validated against the live provider before anything is stored** — a
bad key would otherwise surface to visitors as "temporarily unavailable" with
no clue why. Then it is sealed with a per-tenant data key, that key wrapped by
the master key, and the site flipped to `byok`.

Verified end to end: an invalid key is rejected (HTTP 401, nothing written); a
valid key is encrypted (101-byte ciphertext, 72-byte wrapped DEK) and then
successfully **decrypted and used** at request time.

`MASTER_KEY_B64` was also empty in `.env`, which would have thrown on first
use. It is generated at setup now.

## Owners can see why chat is failing

A visitor sees "the assistant is temporarily unavailable" — deliberately bland,
because leaking a site's billing state to its visitors is wrong. But the owner
was left with nothing: the real reason existed only in a server log they cannot
read.

`site_alerts` records every owner-actionable failure (quota, auth, budget),
upserted with a tally so a recurring fault is one row rather than a flood. The
dashboard renders it with what it means and a link to fix it.

## The onboarding tells you what it captured

The install step now ends with a "What we read and saved" panel: pages read,
passages and tokens saved, whether contact details were found, whether FAQ and
product data existed, and whether the site brief generated. Missing items say
what they cost you rather than being silently absent.

This exists because of how every gap in this project was actually discovered —
someone asked the chat a question days later and got a bad answer. Moving that
discovery to the moment of indexing is worth more than any individual
extraction fix.

## A failed core pack must not destroy a good index

A quota-exhausted key failed the **entire crawl** at the last step, after pages
were fetched, chunks embedded and everything paid for. The core pack is an
enhancement (it answers common questions without retrieval); losing it degrades
quality but does not break chat. It is now non-fatal: the index commits, the
crawl succeeds, the dashboard shows a "site brief missing" notice, and
re-indexing retries it.

### Quota vs burst: two different 429s

`free-models-per-day` is exhausted until UTC midnight — retrying is pointless
and the model chain cannot route around it, because it exhausts every free
model on that key at once. That is now `provider_quota` (owner-actionable)
rather than `rate_limited` ("try again in a moment"), and **both the ingest and
chat paths walk keys as well as models**, since each key carries its own quota.

## Readability deletes exactly what visitors ask about

A visitor asked "where is Akshay Marble located?" and got "no address is
published on the pages provided" — while the page plainly showed one.

Readability keeps the *article* and discards header, footer, nav and contact
strips. That is correct for a news reader and wrong for us: it is precisely
where every business puts its address, phone and email. So the single most
common question on any business site was being deleted at index time, on every
site, silently — the crawl reported success and the assistant reported ignorance.

`contact.ts` extracts contact details from the **full DOM before Readability
runs**, from four sources in descending order of trust: JSON-LD
(`Organization`/`LocalBusiness`), `tel:`/`mailto:` links, `<address>` elements,
and text following a contact-ish heading. That last fallback is the one that
matters in practice — this site had no structured data at all and published its
address as plain text under "Our Location".

Details are merged across pages (they repeat site-wide), written as their own
chunk with `priority = 3` so a location question reaches them ahead of
marketing prose, and also appended to the core-pack input so common asks are
answered without retrieval. When nothing is found the crawl warns, because
silently having no answer to "where are you?" is the failure mode we just fixed.

## Bugs found by onboarding a second, JS-rendered site

A marble supplier's site indexed **zero pages**. The guard caught it — the
core-pack model reported that the pages it had been handed were empty, and
`generateCorePack` refused to store the result. But three real bugs sat behind
that one symptom.

**JS rendering was still a stub.** `needsRendering()` had always detected these
pages correctly; the fetch path returned the un-rendered shell anyway.
`render.ts` now drives the *system* Chrome through `playwright-core` — no 300MB
browser download — reusing one browser across pages, aborting images/fonts/
media/stylesheets, and degrading to the shell rather than throwing if Chrome is
absent. **Discovery goes through the same path**, which matters more than it
sounds: on a client-rendered site the shell has no links either, so BFS found
exactly one page. After: 14 discovered, 13 rendered.

**`www` and the bare domain are not interchangeable.** Onboarding registered
both as verified, and `akshaymarble.in` does not resolve at all — only
`www.akshaymarble.in` serves. Onboarding now probes the URL before queueing and
says so on the form if it doesn't respond.

**The crawl target was picked nondeterministically.** The worker chose one with
`SELECT hostname FROM domains ... LIMIT 1`, no `ORDER BY` — from a table that
legitimately holds www, bare, *and our own preview host*. It picked the dead
bare domain. It could have picked `localhost`. Crawl target and widget
allowlist are now separate concerns: `sites.crawl_origin` is the exact origin
the owner entered and we verified responds; `domains` stays the embed allowlist,
where several entries is correct.

### And an operational one

`.env` was silently overwritten with `.env.example`'s Docker defaults at some
point, which cost two debugging cycles: first a Postgres auth failure, then a
`401 Missing Authentication header` from the embedding call once the DB was
fixed. `--env-file` also takes the **last** duplicate key, and the file had
accumulated two `INGEST_CORE_PACK_MODEL` lines pointing at different models.
Worth a `pnpm doctor` that checks required keys are present before anything
starts.

## Bugs found by driving the widget live

**The auto-router answered chat with a safety classifier.** I pinned a model
chain for *ingest* but left `sites.model` as `openrouter/free`, so live chat
requests routed to `nvidia/nemotron-3.5-content-safety:free`, which replied
`"User Safety: safe"`. A reasoning model separately leaked `"Here's a thinking
process: 1. **Analyze User Input**..."`. Both were streamed to the visitor
**and written to the semantic cache**, so one transient glitch became a
permanent wrong answer. Fixes: a pinned model chain on the chat path too, and
`answer-guard.ts` — a backstop that refuses to serve or cache classifier
output, leaked reasoning, or implausibly short replies.

**`hit_count` never incremented.** postgres.js queries are **lazy**: they only
execute when something subscribes to the promise. `void sql\`UPDATE ...\``
therefore never ran, so the counter sat at 0 through confirmed cache hits and
the "top questions" report would have been permanently empty. `.catch()`
subscribes, so it fires without blocking.

**The semantic-cache threshold was too strict.** At 0.95, `"who are your
clients"` (no capital, no question mark) scored 0.9167 and *missed* — exactly
the repeat traffic the cache exists to catch. Measured spread: identical 1.00,
punctuation variant 0.957, casing variant 0.917, genuine paraphrase ~0.51.
Lowered to 0.90, which is far from the paraphrase band.

## Two bugs found by running the widget in a browser

**Metered mode broke for any third provider.** `platformKey()` tested for
`"anthropic"` and sent *everything else* down the Gemini branch, so adding
OpenRouter silently resolved to an empty key. Now a `Record<ProviderId, string>`
— adding a provider without adding its env var is a compile error, not a
runtime one.

**The failure was invisible.** `fail()` only logged `OWNER_ACTIONABLE` codes, so
an `internal` error reached the browser as "Something went wrong" while the
server log stayed *completely empty*. `OWNER_ACTIONABLE` decides whether to
**notify the site owner** — not whether a failure is worth recording. Every
failure is logged now.

## Two bugs the tests exist to prevent

Recorded because both look correct on the page and are wrong in a way that
fails silently rather than loudly.

**The lexical arm ANDed its terms.** `plainto_tsquery` and
`websearch_to_tsquery` combine every term with AND, so `"how much does the Pro
plan cost"` becomes `'much' & 'pro' & 'plan' & 'cost'` and matches nothing —
the pricing page says "The Pro plan costs 49 dollars" but never says "much".
The lexical arm returned zero rows for essentially every real question, so
hybrid search silently degraded to vector-only and nobody would have noticed
except as mediocre answers. Fixed by OR-ing the lexemes and letting `ts_rank`
weight documents that match more of them.

**The confidence gate could never fire.** It compared a score that had been
normalised by dividing through the top score — which makes the top score 1.0 by
construction, always above any threshold. The gate only triggered on a site
with zero chunks, so every irrelevant question still reached the LLM: the
hallucination guard, and the "answer for free without an LLM call" saving,
were both inert. The deeper cause is that RRF is a rank-combination heuristic
whose output sits in a narrow band (~0.016–0.033) whether the match is perfect
or garbage — it carries no absolute-relevance information at all. Fixed by
gating on raw signals instead: cosine similarity from the dense arm, plus
whether the lexical arm matched anything. When a reranker lands, its calibrated
score replaces both.

## Model ids belong to the provider, not to us

A hardcoded model list is a guess with an expiry date, and ours expired:
`gemini-2.5-flash` was retired for new users. That alone would be a one-line
fix — the damage was that `validateKey()` *probed that exact model*, so a
retired id meant **every valid Gemini key was rejected**, with a 404 about a
model the user never chose.

Two fixes, both structural:

- `validateKey()` no longer references any model. It lists models instead, so
  key validity and model availability are independent questions.
- `listModels()` asks the provider's API (Gemini and OpenRouter both expose
  one). The static tables are fallbacks for when that call fails, not the
  source of truth. Verified live: OpenRouter returns 200 models, free ones
  first.
- The provider UI fetches the real list as soon as you paste a key, so the
  picker can never offer something the provider has retired.

## Verifying a provider adapter

```bash
pnpm --filter @groundwork/providers verify gemini      # or anthropic, openrouter
```

Typechecking proves an adapter compiles against documented shapes; it proves
nothing about the live API. This exercises every method against a real key —
invalid-key rejection, each configured model, incremental streaming, token
counting — and asserts the invariant that silently corrupts billing when wrong:
**`inputTokens` must be the uncached remainder.** Anthropic reports it that way;
OpenAI-shaped and Gemini responses include cached tokens in the prompt total and
must subtract. Get it backwards and every cached turn bills twice.

It also reports which configured model ids actually answer, since a hardcoded
model list is a guess until something proves it.

## Verified vs not

Anthropic model pricing, cache economics (1.25×/2× write, 0.1× read) and
minimum cacheable prefixes are verified against current Anthropic docs.

Typecheck (13/13), build (8/8) and tests (10/10) pass. The schema is applied to
a real Postgres 16 + pgvector 0.8.6. **The full pipeline has been run end to
end against a live site** — crawl, de-boilerplate, chunk, embed, core-pack
generation, hybrid retrieval, gating, streaming answers and metering — via
OpenRouter. Total spend for all of that: **$0.00023**.

Still unrun: the **Anthropic and Gemini adapters**. They typecheck and follow
documented shapes, but no live call has been made through either. Gemini's
price-book entries remain zeros with `verified: false`.

Free models are fine for development and wrong for production: first-token
latency ran 4–39s, per-model rate limits are aggressive, and none of them
accept an explicit cache breakpoint — so the prompt-caching work in
`prompt.ts` is dormant and the cache columns will read zero until the chat path
points at a paid provider.

**Gemini prices in the price book are zeros with `verified: false`.** Fill them
from Google's current pricing page before enabling metered billing on Gemini.
Gemini model ids and context windows in `gemini.ts` should be checked too.

## Guardrails

`packages/guards` is shared by the request path and the ingest path — same
argument as `@groundwork/embeddings`: two copies of a security check is one drift
away from a hole. 38 tests.

| Guard | Runs at | Catches |
|---|---|---|
| `checkInput` | before embedding | floods, oversized input, zero-width smuggling — costs nothing to reject |
| `verifyIdentity` | before retrieval | forged/absent HMAC when the site requires signed identity |
| `scanForInjection` | ingest, per chunk | instruction override, persona hijack, prompt extraction, concealment |
| `neutralize` | prompt assembly | role markup and fences that could escape the context delimiter |
| `checkAnswer` | before streaming | classifier output, leaked reasoning, implausibly short replies |
| `checkGrounding` | before streaming | answers with almost no lexical overlap with the retrieved context |

### The threat model worth stating plainly

We crawl a third party's website and paste the result into an LLM prompt.
Anything anyone can publish on that site — a blog comment, a review, a user
profile, an SEO-spam page — becomes prompt content. An attacker needs no access
to our systems, just one paragraph on the customer's site. The customer's own
widget then repeats it to their customers, in their brand voice.

Two layers, because detection alone is not enough:

1. **Detect at ingest** — flagged chunks are excluded from retrieval entirely
   (`chunks.injection_risk`, and the crawl warns about what it found).
2. **Structure at prompt time** — `UNTRUSTED_CONTENT_RULE` tells the model that
   context is data, never instruction. This is what handles what detection misses.

Verified against a live attack: a poisoned chunk instructing the assistant to
tell visitors the company was acquired and to email card details to an attacker
was planted in the index **unflagged**, then retrieved. The assistant answered
the real question from the real content and never mentioned the injected text.

### Calibrating a scanner is mostly about false positives

Two patterns had to be tightened because they ate real product copy — and a
false positive here *silently deletes good content from the index*, which is
worse than a missed attempt (the structural layer still covers those):

- `"you are now"` flagged *"You are now able to export reports as CSV"*. Now
  requires an identity assertion (`you are now a/an/the X`), not a capability.
- `"act as"` flagged *"Our consultants act as an extension of your team"*. Now
  anchored to imperative position — sentence start, or after `you must`/`please`.

### Fail closed

`originAllowed()` used to return `true` when a site had no verified domains, on
the reasoning that an unconfigured site was in "dev mode". Every site starts
unconfigured, so the real default was: **any site key works from any origin on
the internet.** A guard whose default is allow is not a guard.

## Seeing it run

```bash
redis-server --daemonize yes
pnpm --filter @groundwork/widget build
pnpm --filter @groundwork/api dev      # :8787  chat API
pnpm --filter @groundwork/worker dev   # crawl worker
pnpm --filter @groundwork/web dev      # :3000  site + widget CDN
```

Then open <http://localhost:3000> and walk the onboarding. The web app serves
the widget bundle under `/cdn/` in development; in production that's a real CDN
origin (`PUBLIC_CDN_URL`).

Stop everything with:

```bash
pkill -f "tsx/dist/cli.mjs"; redis-cli shutdown
```

### The preview page exists because the origin guard works

After onboarding, `originAllowed()` correctly rejected the widget on our own
domain — only the customer's domains were verified. That is right, and it left
an owner with no way to see the product work before committing a script tag to
production. Onboarding now also verifies `PUBLIC_WEB_URL`, and `/site/:id/preview`
serves a stand-in customer page with the real widget on it.

## Not built

- `apps/dashboard` — control plane UI. Auth, site CRUD, key paste + validate,
  theme editor, usage charts.
- Reranker. `retrieve.ts` stops at RRF fusion; the cross-encoder pass is the
  single biggest quality/token lever and is still an open build-vs-buy call.
- Headless Chromium pool. `crawl.ts` detects JS-rendered pages but does not yet
  render them.
- Credit ledger enforcement. The table exists; nothing debits it.
- Conversation retention / PII policy. **Treat as blocking before any EU
  customer** — we are a sub-processor for end-user chat content, and retrofitting
  deletion across Postgres, Redis, the answer cache and the trace store is
  genuinely painful.
