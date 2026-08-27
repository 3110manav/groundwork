import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed identity.
 *
 * A public widget is inherently abusable: the site key is visible in the page
 * source and `Origin` is trivially spoofed outside a browser. For sites where
 * chat should be limited to authenticated users, the owner's server signs the
 * end-user id with a shared secret and the widget forwards the signature.
 *
 * This existed as a config flag and a `{id, hmac}` request field with NOTHING
 * verifying either — the appearance of a control, which is worse than no
 * control at all, because it invites reliance.
 *
 * Owner-side, in their backend:
 *   hmac = HMAC_SHA256(identity_secret, userId).hex()
 */
export interface IdentityVerdict {
  ok: boolean;
  reason?: string;
}

export function verifyIdentity(
  user: { id: string; hmac: string } | null,
  secret: string | null,
  required: boolean,
): IdentityVerdict {
  if (!required) return { ok: true };
  if (!secret) return { ok: false, reason: "site requires signed identity but has no identity_secret set" };
  if (!user) return { ok: false, reason: "site requires signed identity but request carried none" };

  const expected = createHmac("sha256", secret).update(user.id).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(user.hmac, "hex");
  } catch {
    return { ok: false, reason: "hmac is not valid hex" };
  }
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, which would leak length through the error path.
  if (provided.length !== expected.length) return { ok: false, reason: "hmac length mismatch" };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: "hmac mismatch" };
  return { ok: true };
}
