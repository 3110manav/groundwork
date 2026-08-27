/**
 * Google OAuth 2.0 authorization-code flow, no SDK. The flow is three HTTP
 * calls and a JWT payload read — a dependency would be bigger than the code.
 *
 * The id_token is NOT signature-verified here, deliberately: we receive it
 * directly from Google's token endpoint over TLS in exchange for a code, so
 * its provenance is the transport, not the signature. Signature verification
 * matters when a token arrives from an untrusted party (e.g. a browser);
 * this one never touches one.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function googleEnabled(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function googleRedirectUri(): string {
  return new URL(
    "/auth/google/callback",
    process.env.PUBLIC_WEB_URL ?? "http://localhost:3000",
  ).toString();
}

export function googleAuthUrl(state: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID!);
  u.searchParams.set("redirect_uri", googleRedirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  // Let returning users pick an account rather than being silently logged
  // into whichever Google session happens to be active.
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export async function exchangeGoogleCode(code: string): Promise<GoogleIdentity> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`token exchange failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as { id_token?: string };
  if (!data.id_token) throw new Error("token response had no id_token");

  const payloadB64 = data.id_token.split(".")[1];
  if (!payloadB64) throw new Error("malformed id_token");
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  if (!payload.sub || !payload.email) throw new Error("id_token missing sub or email");

  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: payload.email_verified === true,
    name: payload.name ?? null,
    picture: payload.picture ?? null,
  };
}
