-- Separate "where do we crawl" from "who may embed the widget".
--
-- These were conflated: the worker picked a crawl target with
-- `SELECT hostname FROM domains ... LIMIT 1` and no ORDER BY. That is
-- nondeterministic, and the domains table legitimately holds several hosts —
-- the www and bare forms, plus our own preview origin. It picked a bare domain
-- that does not resolve (only www. serves), crawled nothing, and reported an
-- empty site. It could equally have picked `localhost`.
--
-- crawl_origin is the exact origin the owner entered and we verified responds.
-- domains stays the widget allowlist, where having several entries is correct.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS crawl_origin text;

UPDATE sites s SET crawl_origin = 'https://' || (
  SELECT d.hostname FROM domains d
  WHERE d.site_id = s.id AND d.verified_at IS NOT NULL AND d.hostname <> 'localhost'
  ORDER BY (d.hostname LIKE 'www.%') DESC, d.hostname
  LIMIT 1
) WHERE s.crawl_origin IS NULL;
