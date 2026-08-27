-- Owner-facing alerts.
--
-- A visitor sees "the assistant is temporarily unavailable" — deliberately
-- bland, because leaking a site's billing state to its visitors is wrong. But
-- the OWNER was left with nothing: the real reason existed only in a server log
-- they cannot read. This table closes that gap.
CREATE TABLE IF NOT EXISTS site_alerts (
  id          bigserial PRIMARY KEY,
  site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  code        text NOT NULL,
  detail      text NOT NULL,
  seen_count  integer NOT NULL DEFAULT 1,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, code)
);
CREATE INDEX IF NOT EXISTS site_alerts_site_idx ON site_alerts (site_id, last_seen DESC);
