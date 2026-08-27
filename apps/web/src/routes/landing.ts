import { Hono } from "hono";
import { page } from "../lib/layout.js";
import { currentUser } from "../lib/auth.js";

export const landing = new Hono();

const ico = (d: string) =>
  `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

/**
 * The hero "demo" is a scripted, self-playing conversation — not a video.
 * It weighs nothing, matches the theme in both color schemes, and the third
 * exchange deliberately shows the honest refusal, because "it says I don't
 * know" is the entire pitch. Reduced-motion visitors get the finished
 * conversation rendered statically.
 */
const LANDING_CSS = `
<style>
.hero { position:relative; overflow:hidden; background:#0B120D; color:#EDF3EE;
  border-bottom:1px solid var(--rule); }
.hero::before { content:""; position:absolute; inset:-20%;
  background:
    radial-gradient(46% 38% at 20% 24%, rgba(111,207,151,.17), transparent 68%),
    radial-gradient(52% 44% at 78% 76%, rgba(31,93,63,.5), transparent 70%),
    radial-gradient(30% 26% at 66% 10%, rgba(140,220,172,.12), transparent 62%);
  animation: heroGlow 16s ease-in-out infinite alternate; }
@keyframes heroGlow { to { transform:translate3d(0,-30px,0) rotate(2deg) scale(1.05); } }
.hero::after { content:""; position:absolute; inset:0;
  background-image:linear-gradient(rgba(255,255,255,.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.04) 1px, transparent 1px);
  background-size:44px 44px;
  mask-image:radial-gradient(75% 85% at 50% 30%, #000 25%, transparent 100%); }
.hero .wrap { position:relative; z-index:1; display:grid;
  grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr); gap:56px; align-items:center;
  padding-top:92px; padding-bottom:96px; }
.hero .eyebrow { color:#8ADCAC; }
.hero h1 { color:#F5F9F5; font-size:clamp(40px,4.8vw,62px); }
.hero h1 em { font-style:italic; color:#8ADCAC; }
.hero .lede { color:#B9C6BB; font-size:19px; }
.hero .btn.ghost { color:#EDF3EE; border-color:rgba(255,255,255,.22); }
.hero .btn.ghost:hover { background:rgba(255,255,255,.07); border-color:rgba(255,255,255,.4); }
.hero-badges { display:flex; gap:18px; flex-wrap:wrap; margin-top:34px;
  font-size:13.5px; color:#93A395; }
.hero-badges span { display:inline-flex; gap:7px; align-items:center; }
.hero-badges svg { color:#6FCF97; }

/* the live widget demo */
.demo { background:rgba(16,23,18,.88); border:1px solid rgba(255,255,255,.1);
  border-radius:18px; box-shadow:0 40px 90px -30px rgba(0,0,0,.75);
  -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px);
  display:flex; flex-direction:column; height:460px; max-width:420px; margin-left:auto;
  animation:demoFloat 7s ease-in-out infinite; }
@keyframes demoFloat { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-10px); } }
.demo-head { display:flex; align-items:center; gap:10px; padding:15px 18px;
  border-bottom:1px solid rgba(255,255,255,.08); font-size:14px; font-weight:560; color:#E7EEE8; }
.demo-ava { width:26px; height:26px; border-radius:50%;
  background:linear-gradient(135deg,#2C7A54,#6FCF97); display:grid; place-items:center;
  font-size:12px; color:#0B120D; font-weight:700; }
.demo-live { margin-left:auto; display:inline-flex; align-items:center; gap:6px;
  font-family:var(--mono); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:#6FCF97; }
.demo-live i { width:6px; height:6px; border-radius:50%; background:#6FCF97;
  animation:pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity:.3; } }
.demo-log { flex:1; overflow-y:auto; padding:18px; display:flex; flex-direction:column;
  gap:10px; scrollbar-width:none; }
.demo-log::-webkit-scrollbar { display:none; }
.demo-msg { max-width:86%; padding:10px 14px; border-radius:14px; font-size:14px;
  line-height:1.5; white-space:pre-wrap; }
.demo-msg.u { align-self:flex-end; background:#2C7A54; color:#F2F8F3; border-bottom-right-radius:4px; }
.demo-msg.a { align-self:flex-start; background:rgba(255,255,255,.08); color:#D9E2DA;
  border-bottom-left-radius:4px; }
.demo-src { align-self:flex-start; font-size:11.5px; color:#8ADCAC;
  border:1px solid rgba(138,220,172,.35); border-radius:999px; padding:3px 10px; }
.demo-dots { display:inline-flex; gap:4px; padding:4px 0; }
.demo-dots i { width:5px; height:5px; border-radius:50%; background:#93A395;
  animation:blink 1.2s infinite; }
.demo-dots i:nth-child(2) { animation-delay:.2s; } .demo-dots i:nth-child(3) { animation-delay:.4s; }
@keyframes blink { 0%,60%,100% { opacity:.25; } 30% { opacity:.9; } }
.demo-input { display:flex; gap:8px; padding:13px 16px; border-top:1px solid rgba(255,255,255,.08);
  align-items:center; }
.demo-input span { flex:1; font-size:13.5px; color:#75816F; border:1px solid rgba(255,255,255,.12);
  border-radius:999px; padding:9px 15px; }
.demo-input b { font-size:13px; background:#2C7A54; color:#F2F8F3; border-radius:999px;
  padding:8px 16px; font-weight:560; }

/* stat strip */
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:20px; }
.stat b { display:block; font-family:var(--display); font-weight:600;
  font-size:clamp(30px,3.4vw,42px); letter-spacing:-.02em; color:var(--ink); }
.stat span { font-size:14px; color:var(--ink-3); }

/* install snippet */
.snippet { position:relative; max-width:680px; }
.snippet pre { margin:0; padding:18px 20px; font-size:13.5px; }
.snippet .copy { position:absolute; top:10px; right:10px; }

.cta-panel { position:relative; overflow:hidden; text-align:center; border-radius:22px;
  background:#0B120D; color:#EDF3EE; padding:72px 32px; }
.cta-panel::before { content:""; position:absolute; inset:-30%;
  background:radial-gradient(50% 45% at 50% 60%, rgba(111,207,151,.22), transparent 70%); }
.cta-panel > * { position:relative; }
.cta-panel h2 { color:#F5F9F5; font-size:clamp(30px,3.6vw,44px); }
.cta-panel p { color:#B9C6BB; }

@media (max-width: 920px) {
  .hero .wrap { grid-template-columns:1fr; padding-top:64px; padding-bottom:64px; }
  .demo { margin:0 auto; width:100%; height:420px; }
}
</style>`;

const DEMO_JS = `
(function () {
  var log = document.getElementById('demo-log');
  if (!log) return;
  var SCRIPT = [
    { q: 'Do you ship to Canada?',
      a: 'Yes — standard shipping to Canada takes 5\\u20137 business days and is free over $75. Duties are included at checkout.',
      src: 'Shipping & returns' },
    { q: 'Can I return a custom order?',
      a: 'Custom pieces can be exchanged within 14 days. Refunds apply to unworn standard items only.',
      src: 'Returns policy' },
    { q: 'Do you price match competitors?',
      a: "I couldn't find that on this site. Try the contact page and someone can help.",
      src: null }
  ];
  function el(cls, text) {
    var d = document.createElement('div');
    d.className = cls;
    if (text) d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }
  function renderStatic() {
    SCRIPT.forEach(function (t) {
      el('demo-msg u', t.q);
      el('demo-msg a', t.a);
      if (t.src) el('demo-src', t.src);
    });
  }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { renderStatic(); return; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function typeInto(node, text, cps) {
    var i = 0;
    return new Promise(function (r) {
      var t = setInterval(function () {
        node.textContent += text[i++];
        log.scrollTop = log.scrollHeight;
        if (i >= text.length) { clearInterval(t); r(); }
      }, 1000 / cps);
    });
  }
  async function run() {
    for (;;) {
      log.innerHTML = '';
      for (var k = 0; k < SCRIPT.length; k++) {
        var turn = SCRIPT[k];
        await wait(700);
        await typeInto(el('demo-msg u'), turn.q, 26);
        await wait(450);
        var dots = el('demo-msg a');
        dots.innerHTML = '<span class="demo-dots"><i></i><i></i><i></i></span>';
        await wait(950);
        dots.remove();
        await typeInto(el('demo-msg a'), turn.a, 55);
        if (turn.src) { await wait(250); el('demo-src', turn.src); }
        await wait(1700);
      }
      await wait(2600);
    }
  }
  run();
})();`;

landing.get("/", async (c) =>
  c.html(
    page(
      {
        title: "Groundwork — site chat that can't make things up",
        description:
          "Drop one script tag on your site. Groundwork indexes your pages and answers visitor questions using only what your site actually says.",
        active: "home",
        user: await currentUser(c),
        script: DEMO_JS,
      },
      `
${LANDING_CSS}

<section class="hero">
  <div class="wrap">
    <div>
      <p class="eyebrow">Grounded site chat</p>
      <h1>Chat that only says<br>what <em>your site</em> says.</h1>
      <p class="lede">One script tag. Groundwork reads your website, indexes it, and answers visitors from your own content — with the exact page it came from attached to every answer. And when your site doesn't have the answer, it says so.</p>
      <div class="row" style="margin-top:30px">
        <a class="btn lg" href="/onboard">Add your site — free</a>
        <a class="btn lg ghost" href="/docs">Read the docs</a>
      </div>
      <div class="hero-badges">
        <span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg> Live in ~5 minutes</span>
        <span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg> Under 9 KB on your page</span>
        <span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg> Every answer cited</span>
      </div>
    </div>
    <div class="demo" role="img" aria-label="Animated demo of the Groundwork chat widget answering visitor questions with cited sources">
      <div class="demo-head"><span class="demo-ava">A</span> Atelier Jewellery <span class="demo-live"><i></i> Live demo</span></div>
      <div class="demo-log" id="demo-log"></div>
      <div class="demo-input"><span>Ask about shipping, sizing, returns…</span><b>Send</b></div>
    </div>
  </div>
</section>

<section class="band">
  <div class="wrap stats">
    <div class="stat reveal"><b>6</b><span>independent checks on every answer</span></div>
    <div class="stat reveal d1"><b>&lt;9 KB</b><span>added to your page — isolated, async</span></div>
    <div class="stat reveal d2"><b>~5 min</b><span>from signup to a live widget</span></div>
    <div class="stat reveal d3"><b>$0</b><span>for repeat questions — cached, no model call</span></div>
  </div>
</section>

<section class="band tint" id="guardrails">
  <div class="wrap">
    <p class="eyebrow reveal">Why it doesn't hallucinate</p>
    <h2 class="reveal">Six checks between a question<br>and an answer.</h2>
    <p class="lede reveal" style="margin-bottom:38px">Most site chatbots hand your content to a model and hope. Groundwork treats every layer as something that can fail — and refuses rather than guesses.</p>
    <div class="grid g3">
      <div class="card reveal">
        ${ico('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>')}
        <h3>Answers only from your pages</h3>
        <p>The model is given your content and told to use nothing else. No answering from what it happens to know about your industry.</p>
      </div>
      <div class="card reveal d1">
        ${ico('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>')}
        <h3>Refuses when it doesn't know</h3>
        <p>If nothing on your site is a confident match, it says so and points to your contact page — without ever calling the model. Free, instant, honest.</p>
      </div>
      <div class="card reveal d2">
        ${ico('<path d="M4 4h16v6H4z"/><path d="M4 14h16v6H4z"/>')}
        <h3>Grounding check on every answer</h3>
        <p>Before an answer reaches a visitor, we verify it actually derives from the retrieved text. Answers that drifted are rejected, not shipped.</p>
      </div>
      <div class="card reveal">
        ${ico('<path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/>')}
        <h3>Prompt-injection defence</h3>
        <p>Anyone who can publish on your site — a comment, a review — could otherwise hijack your assistant. We flag those pages at indexing time and structurally separate content from instructions.</p>
      </div>
      <div class="card reveal d1">
        ${ico('<path d="M3 12h4l3 8 4-16 3 8h4"/>')}
        <h3>Every answer is cited</h3>
        <p>Each response carries the pages it drew from, so a visitor — or you — can check it in one click.</p>
      </div>
      <div class="card reveal d2">
        ${ico('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>')}
        <h3>Hard spend ceiling</h3>
        <p>A per-site monthly cap, on by default. A scraped widget cannot run up an unbounded bill.</p>
      </div>
    </div>
    <p class="reveal" style="margin-top:30px;font-size:14.5px;max-width:70ch">
      <strong>An honest note:</strong> no system can guarantee a language model never errs. What Groundwork does is remove the common causes — no source, weak source, hijacked source, drifted answer — and fail loudly rather than confidently. When it isn't sure, it says so.
    </p>
  </div>
</section>

<section class="band">
  <div class="wrap">
    <p class="eyebrow reveal">How it works</p>
    <h2 class="reveal">Four steps, about five minutes.</h2>
    <div class="grid g2" style="margin-top:30px">
      <div class="card reveal"><h3>1 · We read your site</h3><p>Sitemap first, then we follow your links — respecting <code>robots.txt</code>. Navigation, footers and cookie banners are stripped so they don't crowd out real answers.</p></div>
      <div class="card reveal d1"><h3>2 · We build a brief</h3><p>A compact summary of what your company does, your services and your most likely questions — so common asks are answered instantly.</p></div>
      <div class="card reveal d2"><h3>3 · You style the widget</h3><p>Colours, icon, assistant name, greeting, suggested questions. Changes apply without touching your site again.</p></div>
      <div class="card reveal d3"><h3>4 · You paste one tag</h3><p>Under 9&nbsp;KB, loads after your page, isolated so it cannot affect your CSS or layout.</p></div>
    </div>
    <div class="snippet reveal" style="margin-top:34px">
      <pre><code>&lt;script src="https://cdn.groundwork.dev/w.js"
        data-site-key="pk_live_..." async&gt;&lt;/script&gt;</code></pre>
    </div>
  </div>
</section>

<section class="band tint">
  <div class="wrap">
    <p class="eyebrow reveal">Built for cost</p>
    <h2 class="reveal">Repeat questions cost nothing.</h2>
    <div class="grid g3" style="margin-top:28px">
      <div class="card reveal"><h3>Answer cache</h3><p>The same question asked twice replays a stored answer — no model call at all. On FAQ-heavy sites that's a large share of traffic.</p></div>
      <div class="card reveal d1"><h3>Prompt caching</h3><p>The stable part of every request is cached with your provider, billed at a tenth of the normal rate.</p></div>
      <div class="card reveal d2"><h3>Your key or ours</h3><p>Bring your own provider key and pay them directly, or use ours and get billed here. Same product either way.</p></div>
    </div>
  </div>
</section>

<section class="band" style="border-bottom:none">
  <div class="wrap">
    <div class="cta-panel reveal">
      <h2>Point it at your site and see.</h2>
      <p class="lede" style="margin:0 auto 30px;max-width:52ch">Indexing takes under a minute for most sites. You'll get a working widget and a snippet before you decide anything.</p>
      <a class="btn lg" href="/onboard">Add your site — free</a>
    </div>
  </div>
</section>
`,
    ),
  ),
);
