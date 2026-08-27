import { Hono } from "hono";
import { page } from "../lib/layout.js";
import { currentUser } from "../lib/auth.js";

export const landing = new Hono();

const ico = (d: string) =>
  `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

landing.get("/", async (c) =>
  c.html(
    page(
      {
        title: "Groundwork — site chat that can't make things up",
        description:
          "Drop one script tag on your site. Groundwork indexes your pages and answers visitor questions using only what your site actually says.",
        active: "home",
        user: await currentUser(c),
      },
      `
<section class="band">
  <div class="wrap">
    <p class="eyebrow">Grounded site chat</p>
    <h1>Chat that only says<br>what your site says.</h1>
    <p class="lede">One script tag. Groundwork reads your website, indexes it, and answers your visitors' questions from your own content — with the page it came from attached to every answer.</p>
    <div class="row" style="margin-top:28px">
      <a class="btn lg" href="/onboard">Add your site — free</a>
      <a class="btn lg ghost" href="/docs">Read the docs</a>
    </div>
    <pre style="margin-top:40px;max-width:660px"><code>&lt;script src="https://cdn.groundwork.dev/w.js"
        data-site-key="pk_live_..." async&gt;&lt;/script&gt;</code></pre>
  </div>
</section>

<section class="band tint" id="guardrails">
  <div class="wrap">
    <p class="eyebrow">Why it doesn't hallucinate</p>
    <h2>Six checks between a question and an answer.</h2>
    <p class="lede" style="margin-bottom:34px">Most site chatbots hand your content to a model and hope. Groundwork treats every layer as something that can fail, and refuses rather than guesses.</p>
    <div class="grid g3">
      <div class="card">
        ${ico('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>')}
        <h3>Answers only from your pages</h3>
        <p>The model is given your content and told to use nothing else. No answering from what it happens to know about your industry.</p>
      </div>
      <div class="card">
        ${ico('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>')}
        <h3>Refuses when it doesn't know</h3>
        <p>If nothing on your site is a confident match, it says so and points to your contact page — without ever calling the model. Free, instant, and honest.</p>
      </div>
      <div class="card">
        ${ico('<path d="M4 4h16v6H4z"/><path d="M4 14h16v6H4z"/>')}
        <h3>Grounding check on every answer</h3>
        <p>Before an answer reaches a visitor, we verify it actually derives from the retrieved text. Answers that drifted are rejected, not shipped.</p>
      </div>
      <div class="card">
        ${ico('<path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/>')}
        <h3>Prompt-injection defence</h3>
        <p>Anyone who can publish on your site — a comment, a review — could otherwise hijack your assistant. We flag those pages at indexing time and structurally separate content from instructions.</p>
      </div>
      <div class="card">
        ${ico('<path d="M3 12h4l3 8 4-16 3 8h4"/>')}
        <h3>Every answer is cited</h3>
        <p>Each response carries the pages it drew from, so a visitor — or you — can check it in one click.</p>
      </div>
      <div class="card">
        ${ico('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>')}
        <h3>Hard spend ceiling</h3>
        <p>A per-site monthly cap, on by default. A scraped widget cannot run up an unbounded bill.</p>
      </div>
    </div>
    <p style="margin-top:28px;font-size:14.5px;max-width:70ch">
      <strong>An honest note:</strong> no system can guarantee a language model never errs. What Groundwork does is remove the common causes — no source, weak source, hijacked source, drifted answer — and fail loudly rather than confidently. When it isn't sure, it says so.
    </p>
  </div>
</section>

<section class="band">
  <div class="wrap">
    <p class="eyebrow">How it works</p>
    <h2>Four steps, about five minutes.</h2>
    <div class="grid g2" style="margin-top:28px">
      <div class="card"><h3>1 · We read your site</h3><p>Sitemap first, then we follow your links — respecting <code>robots.txt</code>. Navigation, footers and cookie banners are stripped so they don't crowd out real answers.</p></div>
      <div class="card"><h3>2 · We build a brief</h3><p>A compact summary of what your company does, your services and your most likely questions — so common asks are answered instantly.</p></div>
      <div class="card"><h3>3 · You style the widget</h3><p>Colours, icon, assistant name, greeting, suggested questions. Changes apply without touching your site again.</p></div>
      <div class="card"><h3>4 · You paste one tag</h3><p>Under 9&nbsp;KB, loads after your page, isolated so it cannot affect your CSS or layout.</p></div>
    </div>
  </div>
</section>

<section class="band tint">
  <div class="wrap">
    <p class="eyebrow">Built for cost</p>
    <h2>Repeat questions cost nothing.</h2>
    <div class="grid g3" style="margin-top:26px">
      <div class="card"><h3>Answer cache</h3><p>The same question asked twice replays a stored answer — no model call at all. On FAQ-heavy sites that's a large share of traffic.</p></div>
      <div class="card"><h3>Prompt caching</h3><p>The stable part of every request is cached with your provider, billed at a tenth of the normal rate.</p></div>
      <div class="card"><h3>Your key or ours</h3><p>Bring your own provider key and pay them directly, or use ours and get billed here. Same product either way.</p></div>
    </div>
  </div>
</section>

<section class="band">
  <div class="wrap narrow" style="text-align:center">
    <h2>Point it at your site and see.</h2>
    <p class="lede" style="margin:0 auto 26px">Indexing takes under a minute for most sites. You'll get a working widget and a snippet before you decide anything.</p>
    <a class="btn lg" href="/onboard">Add your site</a>
  </div>
</section>
`,
    ),
  ),
);
