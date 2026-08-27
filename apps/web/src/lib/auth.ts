import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { sql } from "@groundwork/db";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SESSION_COOKIE = "gw_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * scrypt, not bcrypt — it is built into node:crypto, so a password hash does
 * not need a native dependency. Salt travels alongside the hash in one column.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

export interface SessionUser {
  id: string;
  email: string;
}

export type AuthEnv = { Variables: { user: SessionUser } };

/**
 * Server-side sessions, not a signed JWT — a stolen cookie is revoked by
 * deleting one row, and logout actually ends the session rather than just
 * discarding a token that would still validate anywhere else it was copied.
 */
export async function createSession(c: Context, userId: string): Promise<void> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO sessions (user_id, expires_at) VALUES (${userId}, ${expiresAt}) RETURNING id
  `;
  setCookie(c, SESSION_COOKIE, row!.id, {
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession(c: Context): Promise<void> {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) await sql`DELETE FROM sessions WHERE id = ${id}`;
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function currentUser(c: Context): Promise<SessionUser | null> {
  const id = getCookie(c, SESSION_COOKIE);
  if (!id) return null;
  const rows = await sql<SessionUser[]>`
    SELECT u.id, u.email FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ${id} AND s.expires_at > now()
  `;
  return rows[0] ?? null;
}

/**
 * Gate a page route behind login. Redirects to /login rather than 401ing —
 * every route here renders HTML for a human, not JSON for a client.
 */
export function requireAuth() {
  return async (c: Context<AuthEnv>, next: Next) => {
    const user = await currentUser(c);
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`);
    c.set("user", user);
    await next();
  };
}

/**
 * A valid session is not the same as owning the site in the URL. Returns 404
 * rather than 403 on mismatch — a wrong owner should learn nothing about
 * whether the id exists at all.
 */
export async function ownsSite(userId: string, siteId: string): Promise<boolean> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int n FROM sites s
    JOIN org_members m ON m.org_id = s.org_id
    WHERE s.id = ${siteId} AND m.user_id = ${userId}
  `;
  return (rows[0]?.n ?? 0) > 0;
}
