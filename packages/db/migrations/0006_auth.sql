-- Owner accounts. Plain email + password for now — no SSO. A dashboard route
-- with no auth in front of it was the actual gap: any UUID in the URL bar
-- opened someone else's provider key and usage numbers.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE org_role AS ENUM ('owner', 'member');

-- Join table, not a single owner_id column on orgs — an org can only gain a
-- second member later (billing contact, teammate) if this exists from day one.
CREATE TABLE org_members (
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       org_role NOT NULL DEFAULT 'owner',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_members_user_idx ON org_members (user_id);

-- Server-side sessions, not a signed JWT: a stolen cookie is revoked by
-- deleting one row, and logout actually ends the session instead of just
-- deleting a cookie the token would still validate without.
CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
