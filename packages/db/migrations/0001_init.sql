-- chat-sdk initial schema
-- Requires pgvector >= 0.7 for halfvec (2 bytes/dim instead of 4).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- tenancy --

CREATE TABLE orgs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE billing_mode AS ENUM ('byok', 'metered');
CREATE TYPE provider_id  AS ENUM ('anthropic', 'gemini');

CREATE TABLE sites (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name           text NOT NULL,
  site_key       text NOT NULL UNIQUE,          -- pk_live_... publishable
  billing_mode   billing_mode NOT NULL DEFAULT 'metered',
  provider       provider_id  NOT NULL DEFAULT 'anthropic',
  model          text NOT NULL,
  -- Hard ceiling, defaulted ON. A scraped widget must not be able to generate
  -- an unbounded bill that the owner will blame us for either way.
  monthly_budget_usd numeric(10,2) NOT NULL DEFAULT 50.00,
  -- Bumped on every recrawl. Invalidates answer_cache without deleting rows.
  index_version  integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Origin allowlist. Spoofable outside a browser, so it is one layer of
-- several (rate limits, budget ceiling, optional signed identity), not THE gate.
CREATE TABLE domains (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id           uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  hostname          text NOT NULL,
  verified_at       timestamptz,
  verification_token text NOT NULL,
  UNIQUE (site_id, hostname)
);

CREATE TYPE key_status AS ENUM ('active', 'invalid', 'revoked');

-- Envelope encryption: key_ciphertext is sealed by a per-tenant DEK which is
-- itself wrapped by KMS. Decrypted only inside the request handler, never
-- logged, never serialised into a response.
CREATE TABLE provider_keys (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id        uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  provider       provider_id NOT NULL,
  key_ciphertext bytea NOT NULL,
  wrapped_dek    bytea NOT NULL,
  key_last4      text NOT NULL,
  status         key_status NOT NULL DEFAULT 'active',
  validated_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, provider)
);

CREATE TABLE widget_configs (
  site_id        uuid PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  config         jsonb NOT NULL,
  config_version text NOT NULL,   -- part of the CDN cache key
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- ingestion --

CREATE TYPE crawl_status AS ENUM ('queued','running','succeeded','failed','cancelled');

CREATE TABLE crawl_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  status      crawl_status NOT NULL DEFAULT 'queued',
  pages_found integer NOT NULL DEFAULT 0,
  pages_indexed integer NOT NULL DEFAULT 0,
  error       text,
  started_at  timestamptz,
  finished_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  url           text NOT NULL,
  title         text,
  -- Pointer into object storage. Keeping raw HTML is what makes re-chunking and
  -- re-embedding possible without re-crawling the customer's site.
  raw_key       text,
  content_hash  text NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, url)
);

CREATE TYPE chunk_source AS ENUM ('crawl', 'manual');

CREATE TABLE chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_id     uuid REFERENCES pages(id) ON DELETE CASCADE,
  -- 'manual' chunks are owner-authored Q&A that the crawler cannot find.
  -- They outrank crawled content at retrieval time.
  source      chunk_source NOT NULL DEFAULT 'crawl',
  priority    smallint NOT NULL DEFAULT 0,
  breadcrumb  text NOT NULL,          -- "Site > H1 > H2"
  url         text NOT NULL,
  content     text NOT NULL,
  token_count integer NOT NULL,
  content_hash text NOT NULL,          -- embedding cache key across recrawls

  -- halfvec: 2 bytes/dim. 1536 dims -> ~3KB/vector -> ~3GB per 1M chunks,
  -- against ~6GB for plain vector. HNSW indexes live in RAM, so this matters.
  embedding   halfvec(1536),
  embedding_model   text NOT NULL,
  embedding_version integer NOT NULL DEFAULT 1,

  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chunks_site_idx  ON chunks (site_id);
CREATE INDEX chunks_hash_idx  ON chunks (content_hash);
CREATE INDEX chunks_tsv_idx   ON chunks USING gin (tsv);
CREATE INDEX chunks_vec_idx   ON chunks USING hnsw (embedding halfvec_cosine_ops);

-- The stable, deliberately-sized system prefix. Exists so there is something
-- ABOVE the cache breakpoint worth caching: a bare persona line is ~50 tokens
-- and falls under every provider's minimum cacheable prefix.
CREATE TABLE core_packs (
  site_id      uuid PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  content      text NOT NULL,
  token_count  integer NOT NULL,
  model_used   text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- runtime ----

CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  end_user_id text,                       -- set only in signed-identity mode
  summary     text,                       -- rolling summary of dropped turns
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_site_idx ON conversations (site_id, last_seen_at DESC);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user','assistant')),
  content         text NOT NULL,
  sources         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- True when the confidence gate fired. This column IS the "unanswered
  -- questions" report, which is the thing owners actually log in to read.
  unanswered      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv_idx ON messages (conversation_id, created_at);

-- Semantic response cache. Scoped by index_version so a recrawl invalidates
-- every stored answer without a delete pass.
CREATE TABLE answer_cache (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id        uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  index_version  integer NOT NULL,
  question       text NOT NULL,
  question_embedding halfvec(1536) NOT NULL,
  answer         text NOT NULL,
  sources        jsonb NOT NULL DEFAULT '[]'::jsonb,
  hit_count      integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX answer_cache_lookup_idx ON answer_cache (site_id, index_version);
CREATE INDEX answer_cache_vec_idx ON answer_cache USING hnsw (question_embedding halfvec_cosine_ops);

-- ------------------------------------------------------------- metering ---

CREATE TYPE billed_to AS ENUM ('platform', 'tenant');

-- Billing-grade. Written transactionally in the request path, never derived
-- from a trace store that can drop spans.
CREATE TABLE usage_events (
  id                  bigserial PRIMARY KEY,
  site_id             uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  conversation_id     uuid REFERENCES conversations(id) ON DELETE SET NULL,
  provider            provider_id NOT NULL,
  model               text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  input_tokens        integer NOT NULL,   -- ALWAYS the uncached remainder
  cached_input_tokens integer NOT NULL,
  cache_write_tokens  integer NOT NULL,
  output_tokens       integer NOT NULL,

  -- Snapshot, not a join: a later price change must not rewrite old invoices.
  unit_prices         jsonb NOT NULL,
  provider_cost_usd   numeric(12,8) NOT NULL,
  charged_amount_usd  numeric(12,8) NOT NULL DEFAULT 0,
  billed_to           billed_to NOT NULL,
  price_verified      boolean NOT NULL DEFAULT true,

  latency_ms          integer,
  cache_hit           boolean NOT NULL DEFAULT false,
  semantic_cache_hit  boolean NOT NULL DEFAULT false,
  trace_id            text
);
CREATE INDEX usage_site_time_idx ON usage_events (site_id, created_at DESC);

-- Prepaid credits for metered mode. Append-only ledger; balance is the sum.
CREATE TABLE credit_ledger (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  delta_usd   numeric(12,4) NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_org_idx ON credit_ledger (org_id, created_at DESC);
