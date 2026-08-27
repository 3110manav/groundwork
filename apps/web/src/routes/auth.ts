import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { sql } from "@groundwork/db";
import { page } from "../lib/layout.js";
import { escape } from "../lib/html.js";
import { createSession, currentUser, destroySession, hashPassword, verifyPassword } from "../lib/auth.js";
import { exchangeGoogleCode, googleAuthUrl, googleEnabled } from "../lib/google.js";

export const auth = new Hono();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OAUTH_COOKIE = "gw_oauth";

function safeNext(raw: string | undefined): string {
  // Only ever redirect within our own app — an open redirect via ?next= is a
  // classic phishing vector on a login form.
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/dashboard";
}

/* ---------------------------------------------------------------- design */

const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

const CHECK = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

const AUTH_CSS = `
<style>
.auth-shell { display:grid; grid-template-columns: 1fr 1fr; min-height: calc(100vh - 61px); }
.auth-side { position:relative; overflow:hidden; background:#0B120D; color:#EDF3EE;
  display:flex; flex-direction:column; justify-content:center; padding:64px; }
.auth-side::before { content:""; position:absolute; inset:0;
  background:
    radial-gradient(520px 340px at 18% 22%, rgba(111,207,151,.20), transparent 65%),
    radial-gradient(620px 420px at 82% 78%, rgba(31,93,63,.45), transparent 68%),
    radial-gradient(340px 260px at 70% 12%, rgba(111,207,151,.10), transparent 60%);
  animation: authGlow 14s ease-in-out infinite alternate; }
@keyframes authGlow { to { transform: translate3d(0,-26px,0) scale(1.06); } }
.auth-side::after { content:""; position:absolute; inset:0;
  background-image: linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px);
  background-size: 44px 44px;
  mask-image: radial-gradient(70% 70% at 50% 40%, #000 30%, transparent 100%); }
.auth-side > * { position:relative; z-index:1; }
.auth-side h2 { font-size:clamp(26px,2.6vw,36px); color:#F4F8F4; margin-bottom:18px; }
.auth-side .prop { display:flex; gap:12px; align-items:flex-start; margin:0 0 16px;
  color:#C6D2C7; font-size:15px; max-width:44ch; }
.auth-side .prop svg { flex-shrink:0; margin-top:4px; color:#6FCF97; }
.auth-side .quotebar { margin-top:34px; padding-left:16px; border-left:2px solid rgba(111,207,151,.5);
  color:#93A395; font-size:14px; max-width:42ch; }
.auth-main { display:flex; align-items:center; justify-content:center; padding:48px 24px; }
.auth-card { width:100%; max-width:420px; }
.auth-card h1 { font-size:clamp(26px,3vw,34px); margin-bottom:8px; }
.auth-card .sub { color:var(--ink-3); font-size:15px; margin-bottom:28px; }
.btn-google { display:flex; align-items:center; justify-content:center; gap:11px; width:100%;
  padding:12px; border:1px solid var(--rule); border-radius:10px; background:var(--surface);
  color:var(--ink); font-weight:550; font-size:15px; text-decoration:none;
  transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease; }
.btn-google:hover { border-color:var(--ink-3); box-shadow:var(--shadow); transform:translateY(-1px); }
.or { display:flex; align-items:center; gap:14px; color:var(--ink-3); font-size:12.5px;
  letter-spacing:.08em; text-transform:uppercase; margin:22px 0; }
.or::before, .or::after { content:""; flex:1; height:1px; background:var(--rule); }
.auth-err { border:1px solid var(--danger); background:rgba(156,58,58,.06);
  border-radius:10px; padding:12px 16px; margin-bottom:20px; font-size:14px; color:var(--danger); }
.auth-foot { margin-top:22px; font-size:14px; color:var(--ink-3); }
@media (max-width: 900px) { .auth-shell { grid-template-columns:1fr; } .auth-side { display:none; } }
</style>`;

function sidePanel(): string {
  return `<div class="auth-side">
  <h2>Chat that only says<br>what your site says.</h2>
  <div class="prop">${CHECK}<span>Answers come from your pages, with the source cited on every reply.</span></div>
  <div class="prop">${CHECK}<span>When your site doesn't have the answer, it says so — no guessing, ever.</span></div>
  <div class="prop">${CHECK}<span>One script tag. Indexed in under a minute. Live the same afternoon.</span></div>
  <p class="quotebar">Six independent checks stand between a visitor's question and every answer.</p>
</div>`;
}

function authPage(opts: {
  title: string;
  heading: string;
  sub: string;
  err?: string;
  next: string;
  form: string;
  foot: string;
  googleIntent: string;
}): string {
  const nextQS = opts.next ? `?next=${encodeURIComponent(opts.next)}` : "";
  return `${AUTH_CSS}
<div class="auth-shell">
  ${sidePanel()}
  <div class="auth-main"><div class="auth-card">
    <h1>${opts.heading}</h1>
    <p class="sub">${opts.sub}</p>
    ${opts.err ? `<div class="auth-err">${escape(opts.err)}</div>` : ""}
    <a class="btn-google" href="/auth/google${nextQS}">${GOOGLE_G} ${opts.googleIntent} with Google</a>
    <div class="or">or use email</div>
    ${opts.form}
    <p class="auth-foot">${opts.foot}</p>
  </div></div>
</div>`;
}

/* ---------------------------------------------------------------- signup */

auth.get("/signup", async (c) => {
  if (await currentUser(c)) return c.redirect("/dashboard");
  const err = c.req.query("error");
  const next = c.req.query("next") ?? "";

  return c.html(
    page(
      { title: "Sign up — Groundwork", bare: true },
      authPage({
        title: "Sign up",
        heading: "Create your account",
        sub: "One account per business. Free to start — no card required.",
        err,
        next,
        googleIntent: "Sign up",
        form: `<form method="post" action="/signup">
    <input type="hidden" name="next" value="${escape(next)}">
    <div class="field">
      <label for="email">Work email</label>
      <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@company.com">
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required minlength="8" autocomplete="new-password" placeholder="At least 8 characters">
    </div>
    <button class="btn lg" type="submit" style="width:100%;justify-content:center">Create account</button>
  </form>`,
        foot: `Already have an account? <a href="/login${next ? `?next=${encodeURIComponent(next)}` : ""}">Log in</a>`,
      }),
    ),
  );
});

auth.post("/signup", async (c) => {
  const f = await c.req.parseBody();
  const email = String(f.email ?? "").trim().toLowerCase();
  const password = String(f.password ?? "");
  const next = safeNext(String(f.next ?? ""));

  if (!EMAIL_RE.test(email)) {
    return c.redirect(`/signup?error=${encodeURIComponent("Enter a valid email address.")}`);
  }
  if (password.length < 8) {
    return c.redirect(`/signup?error=${encodeURIComponent("Password must be at least 8 characters.")}`);
  }

  const [existing] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
  if (existing) {
    return c.redirect(`/signup?error=${encodeURIComponent("An account with that email already exists.")}`);
  }

  const passwordHash = await hashPassword(password);
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, password_hash) VALUES (${email}, ${passwordHash}) RETURNING id
  `;
  await createSession(c, user!.id);
  return c.redirect(next);
});

/* ----------------------------------------------------------------- login */

auth.get("/login", async (c) => {
  if (await currentUser(c)) return c.redirect("/dashboard");
  const err = c.req.query("error");
  const next = c.req.query("next") ?? "";

  return c.html(
    page(
      { title: "Log in — Groundwork", bare: true },
      authPage({
        title: "Log in",
        heading: "Welcome back",
        sub: "Log in to your dashboard.",
        err,
        next,
        googleIntent: "Continue",
        form: `<form method="post" action="/login">
    <input type="hidden" name="next" value="${escape(next)}">
    <div class="field">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autocomplete="email" placeholder="you@company.com">
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password" placeholder="Your password">
    </div>
    <button class="btn lg" type="submit" style="width:100%;justify-content:center">Log in</button>
  </form>`,
        foot: `New here? <a href="/signup${next ? `?next=${encodeURIComponent(next)}` : ""}">Create an account</a>`,
      }),
    ),
  );
});

auth.post("/login", async (c) => {
  const f = await c.req.parseBody();
  const email = String(f.email ?? "").trim().toLowerCase();
  const password = String(f.password ?? "");
  const next = safeNext(String(f.next ?? ""));

  const generic = "That email and password don't match an account.";
  const [user] = await sql<{ id: string; password_hash: string | null }[]>`
    SELECT id, password_hash FROM users WHERE email = ${email}
  `;
  // Same generic message whether the email is unknown, the password is wrong,
  // or the account is Google-only — distinguishing them lets an attacker
  // enumerate accounts and their sign-in methods.
  if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
    return c.redirect(`/login?error=${encodeURIComponent(generic)}`);
  }

  await createSession(c, user.id);
  return c.redirect(next);
});

auth.post("/logout", async (c) => {
  await destroySession(c);
  return c.redirect("/");
});

/* ------------------------------------------------------------ google sso */

auth.get("/auth/google", (c) => {
  if (!googleEnabled()) {
    return c.redirect(
      `/login?error=${encodeURIComponent("Google sign-in isn't configured on this server yet. Use email and password.")}`,
    );
  }
  const state = randomBytes(16).toString("hex");
  const next = safeNext(c.req.query("next"));
  // State rides in a short-lived cookie and must match on the way back —
  // otherwise an attacker could complete the flow with THEIR code and log
  // the victim into the attacker's account (login CSRF).
  setCookie(c, OAUTH_COOKIE, `${state}|${next}`, {
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  return c.redirect(googleAuthUrl(state));
});

auth.get("/auth/google/callback", async (c) => {
  const fail = (msg: string) => c.redirect(`/login?error=${encodeURIComponent(msg)}`);

  const stored = getCookie(c, OAUTH_COOKIE);
  deleteCookie(c, OAUTH_COOKIE, { path: "/" });
  const [expectedState, storedNext] = (stored ?? "").split("|");
  const state = c.req.query("state");
  const code = c.req.query("code");

  if (c.req.query("error")) return fail("Google sign-in was cancelled.");
  if (!code || !state || !expectedState || state !== expectedState) {
    return fail("Sign-in session expired — please try again.");
  }

  let identity;
  try {
    identity = await exchangeGoogleCode(code);
  } catch (err) {
    console.error("[google-sso] exchange failed", err);
    return fail("Couldn't complete Google sign-in. Please try again.");
  }

  // An unverified email must never link to or create an account — anyone can
  // add an address they don't own to a Google account without proving it.
  if (!identity.emailVerified) {
    return fail("Your Google account's email isn't verified. Verify it with Google first.");
  }

  const [bySub] = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE google_sub = ${identity.sub}
  `;
  let userId: string;
  if (bySub) {
    userId = bySub.id;
    await sql`
      UPDATE users SET name = ${identity.name}, picture_url = ${identity.picture}
      WHERE id = ${userId}
    `;
  } else {
    const [byEmail] = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${identity.email}
    `;
    if (byEmail) {
      // Existing password account, same (Google-verified) email: link rather
      // than duplicate. The password keeps working alongside Google.
      userId = byEmail.id;
      await sql`
        UPDATE users
        SET google_sub = ${identity.sub}, name = ${identity.name}, picture_url = ${identity.picture}
        WHERE id = ${userId}
      `;
    } else {
      const [created] = await sql<{ id: string }[]>`
        INSERT INTO users (email, google_sub, name, picture_url)
        VALUES (${identity.email}, ${identity.sub}, ${identity.name}, ${identity.picture})
        RETURNING id
      `;
      userId = created!.id;
    }
  }

  await createSession(c, userId);
  return c.redirect(safeNext(storedNext));
});
