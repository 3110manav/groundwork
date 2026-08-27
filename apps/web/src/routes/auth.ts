import { Hono } from "hono";
import { sql } from "@groundwork/db";
import { page } from "../lib/layout.js";
import { escape } from "../lib/html.js";
import { createSession, currentUser, destroySession, hashPassword, verifyPassword } from "../lib/auth.js";

export const auth = new Hono();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function safeNext(raw: string | undefined): string {
  // Only ever redirect within our own app — an open redirect via ?next= is a
  // classic phishing vector on a login form.
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/dashboard";
}

auth.get("/signup", async (c) => {
  if (await currentUser(c)) return c.redirect("/dashboard");
  const err = c.req.query("error");
  const next = c.req.query("next") ?? "";

  return c.html(
    page(
      { title: "Sign up — Groundwork" },
      `<section class="band"><div class="wrap narrow">
  <h1 style="font-size:clamp(28px,4vw,38px)">Create your account</h1>
  <p class="lede">One account per business. No SSO yet — just an email and a password.</p>
  ${err ? `<div class="card" style="border-color:var(--danger);margin-top:20px"><h3 style="color:var(--danger)">Couldn't sign you up</h3><p style="font-size:14.5px">${escape(err)}</p></div>` : ""}
  <form method="post" action="/signup" style="margin-top:26px">
    <input type="hidden" name="next" value="${escape(next)}">
    <div class="field">
      <label for="email">Work email</label>
      <input type="email" id="email" name="email" required autocomplete="email">
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required minlength="8" autocomplete="new-password">
      <p class="hint">At least 8 characters.</p>
    </div>
    <button class="btn lg" type="submit">Create account</button>
  </form>
  <p class="hint" style="margin-top:18px">Already have an account? <a href="/login${next ? `?next=${encodeURIComponent(next)}` : ""}">Log in</a></p>
</div></section>`,
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

auth.get("/login", async (c) => {
  if (await currentUser(c)) return c.redirect("/dashboard");
  const err = c.req.query("error");
  const next = c.req.query("next") ?? "";

  return c.html(
    page(
      { title: "Log in — Groundwork" },
      `<section class="band"><div class="wrap narrow">
  <h1 style="font-size:clamp(28px,4vw,38px)">Log in</h1>
  ${err ? `<div class="card" style="border-color:var(--danger);margin-top:20px"><h3 style="color:var(--danger)">Couldn't log you in</h3><p style="font-size:14.5px">${escape(err)}</p></div>` : ""}
  <form method="post" action="/login" style="margin-top:26px">
    <input type="hidden" name="next" value="${escape(next)}">
    <div class="field">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autocomplete="email">
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
    </div>
    <button class="btn lg" type="submit">Log in</button>
  </form>
  <p class="hint" style="margin-top:18px">New here? <a href="/signup${next ? `?next=${encodeURIComponent(next)}` : ""}">Create an account</a></p>
</div></section>`,
    ),
  );
});

auth.post("/login", async (c) => {
  const f = await c.req.parseBody();
  const email = String(f.email ?? "").trim().toLowerCase();
  const password = String(f.password ?? "");
  const next = safeNext(String(f.next ?? ""));

  const generic = "That email and password don't match an account.";
  const [user] = await sql<{ id: string; password_hash: string }[]>`
    SELECT id, password_hash FROM users WHERE email = ${email}
  `;
  // Same generic message whether the email is unknown or the password is
  // wrong — telling the two apart lets an attacker enumerate accounts.
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.redirect(`/login?error=${encodeURIComponent(generic)}`);
  }

  await createSession(c, user.id);
  return c.redirect(next);
});

auth.post("/logout", async (c) => {
  await destroySession(c);
  return c.redirect("/");
});
