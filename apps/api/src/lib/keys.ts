import { createDecipheriv, createCipheriv, randomBytes } from "node:crypto";
import { sql } from "@groundwork/db";
import { ChatError } from "@groundwork/contracts";
import type { ProviderId } from "@groundwork/providers";

/**
 * Envelope encryption. A per-tenant data key (DEK) seals the provider key; the
 * DEK is itself wrapped by a master key. In production the master key is a KMS
 * key id and unwrapping is a KMS call — MASTER_KEY_B64 is the local-dev stand-in.
 *
 * Decrypted material must never be logged, cached in a module-level variable,
 * or serialised into any response.
 */
function masterKey(): Buffer {
  const b64 = process.env.MASTER_KEY_B64;
  if (!b64) throw new Error("MASTER_KEY_B64 is not set");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("MASTER_KEY_B64 must decode to 32 bytes");
  return key;
}

function seal(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function open(sealed: Buffer, key: Buffer): string {
  const iv = sealed.subarray(0, 12);
  const tag = sealed.subarray(12, 28);
  const ct = sealed.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export async function storeProviderKey(
  siteId: string,
  provider: ProviderId,
  apiKey: string,
): Promise<void> {
  const dek = randomBytes(32);
  const keyCiphertext = seal(apiKey, dek);
  const wrappedDek = seal(dek.toString("base64"), masterKey());

  await sql`
    INSERT INTO provider_keys (site_id, provider, key_ciphertext, wrapped_dek, key_last4, status, validated_at)
    VALUES (${siteId}, ${provider}, ${keyCiphertext}, ${wrappedDek}, ${apiKey.slice(-4)}, 'active', now())
    ON CONFLICT (site_id, provider) DO UPDATE
      SET key_ciphertext = EXCLUDED.key_ciphertext,
          wrapped_dek    = EXCLUDED.wrapped_dek,
          key_last4      = EXCLUDED.key_last4,
          status         = 'active',
          validated_at   = now()
  `;
}

/**
 * Platform key pool, per provider.
 *
 * A Record, not an if/else chain — the previous version tested for "anthropic"
 * and sent EVERYTHING else down the Gemini branch, so adding a third provider
 * silently broke metered mode for it.
 */
const PLATFORM_KEY_ENV: Record<ProviderId, string> = {
  anthropic: "PLATFORM_ANTHROPIC_KEYS",
  gemini: "PLATFORM_GEMINI_KEYS",
  openrouter: "PLATFORM_OPENROUTER_KEYS",
};

/** Round-robin across the pool so one site cannot pin a single key's limits. */
let poolCursor = 0;
function platformKey(provider: ProviderId): string {
  const envName = PLATFORM_KEY_ENV[provider];
  const keys = (process.env[envName] ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (keys.length === 0)
    throw new ChatError(
      "internal",
      `metered mode needs ${envName} set for provider "${provider}"`,
    );
  poolCursor = (poolCursor + 1) % keys.length;
  return keys[poolCursor]!;
}

/**
 * The ONLY place the byok and metered paths diverge. Everything downstream —
 * retrieval, prompt assembly, caching, metering — is identical.
 */
export interface ResolvedKey {
  key: string;
  /** Who pays. Surfaced in logs and the dashboard so "whose key ran that?" is never a guess. */
  source: "tenant" | "platform";
  last4: string;
}

export async function resolveKey(site: {
  id: string;
  billing_mode: "byok" | "metered";
  provider: ProviderId;
}): Promise<ResolvedKey> {
  if (site.billing_mode === "metered") {
    const key = platformKey(site.provider);
    return { key, source: "platform", last4: key.slice(-4) };
  }

  const rows = await sql<{ key_ciphertext: Buffer; wrapped_dek: Buffer; status: string }[]>`
    SELECT key_ciphertext, wrapped_dek, status
    FROM provider_keys
    WHERE site_id = ${site.id} AND provider = ${site.provider}
  `;
  const row = rows[0];
  if (!row) throw new ChatError("provider_auth", "no key on file for this site");
  if (row.status !== "active") throw new ChatError("provider_auth", `key status is ${row.status}`);

  const dek = Buffer.from(open(row.wrapped_dek, masterKey()), "base64");
  const key = open(row.key_ciphertext, dek);
  return { key, source: "tenant", last4: key.slice(-4) };
}

/** Called when a provider rejects the key mid-life, so the dashboard can nag. */
export async function markKeyInvalid(siteId: string, provider: ProviderId): Promise<void> {
  await sql`
    UPDATE provider_keys SET status = 'invalid'
    WHERE site_id = ${siteId} AND provider = ${provider}
  `;
}
