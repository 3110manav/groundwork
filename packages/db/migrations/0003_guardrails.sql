-- Guardrails: signed identity, injection flagging, per-site limits.

-- Shared secret for signed-identity mode. The site owner's server HMACs the
-- end-user id with this; the widget forwards the signature. Until now the
-- config flag and the {id, hmac} field both existed and NOTHING verified them.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS identity_secret text;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS require_signed_identity boolean NOT NULL DEFAULT false;

-- Abuse limits, per site rather than global: a docs site and a support site
-- have very different legitimate traffic shapes.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS max_messages_per_conversation integer NOT NULL DEFAULT 40;

-- Crawled content is UNTRUSTED. Anything a third party can publish on the
-- customer's site — a blog comment, a user profile, a review — lands in the
-- prompt. Chunks that look like injection attempts are flagged at ingest so
-- retrieval can exclude them, and so an operator can see what was found.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS injection_risk boolean NOT NULL DEFAULT false;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS injection_reason text;
CREATE INDEX IF NOT EXISTS chunks_injection_idx ON chunks (site_id) WHERE injection_risk;

-- Answers that failed a guard, kept for tuning. Deliberately separate from
-- messages: these were never shown to a visitor.
CREATE TABLE IF NOT EXISTS blocked_answers (
  id           bigserial PRIMARY KEY,
  site_id      uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  question     text NOT NULL,
  answer       text NOT NULL,
  model        text NOT NULL,
  guard        text NOT NULL,   -- which guard rejected it
  reason       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blocked_answers_site_idx ON blocked_answers (site_id, created_at DESC);
