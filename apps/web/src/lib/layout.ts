import { html, raw } from "./html.js";

/**
 * One design system for the whole site. Palette is a cool slate ground with a
 * single deep-green accent — green because the product's claim is "grounded",
 * and because every other AI product on the internet is purple.
 *
 * Type is editorial: Fraunces (a warm display serif) for headings, Inter for
 * body and UI. Both load from Google Fonts with full system fallback stacks —
 * the page must be perfectly readable if the font request never resolves.
 *
 * Class names below are a contract: dashboard, onboarding, docs and provider
 * pages are all built on .band/.wrap/.card/.btn/.field/.pill/.steps — restyle
 * them freely, never remove or rename them.
 */
const STYLES = `
:root {
  --bg:        #FBFBF9;
  --surface:   #FFFFFF;
  --surface-2: #F3F4F0;
  --ink:       #141811;
  --ink-2:     #48503F;
  --ink-3:     #79816F;
  --rule:      #E3E6DD;
  --accent:    #1F5D3F;
  --accent-2:  #2C7A54;
  --accent-tint:#E8F2EC;
  --warn:      #8A5A00;
  --danger:    #9C3A3A;
  --radius:    12px;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Mono", Menlo, Consolas, monospace;
  --sans: "Inter", ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --display: "Fraunces", "Iowan Old Style", Georgia, "Times New Roman", serif;
  --shadow: 0 1px 2px rgba(20,24,15,.05), 0 16px 40px -20px rgba(20,24,15,.18);
  --shadow-lg: 0 2px 4px rgba(20,24,15,.06), 0 32px 80px -32px rgba(20,24,15,.28);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg:#0E110F; --surface:#151A16; --surface-2:#1B211C; --ink:#E9EDE6;
    --ink-2:#A9B2A3; --ink-3:#7A8375; --rule:#282F29;
    --accent:#6FCF97; --accent-2:#8ADCAC; --accent-tint:#16241C;
    --warn:#D9A34A; --danger:#E08585;
    --shadow: 0 1px 2px rgba(0,0,0,.5), 0 16px 40px -20px rgba(0,0,0,.8);
    --shadow-lg: 0 2px 4px rgba(0,0,0,.5), 0 32px 80px -32px rgba(0,0,0,.9);
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans);
  font-size:16px; line-height:1.6; -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
a { color: var(--accent); }
::selection { background:var(--accent); color:#fff; }
.wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
.narrow { max-width: 760px; }

/* nav */
header.nav { border-bottom:1px solid var(--rule); position:sticky; top:0; z-index:50;
  background:color-mix(in srgb, var(--surface) 82%, transparent);
  -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px); }
@supports not (background:color-mix(in srgb, red 50%, blue)) { header.nav { background:var(--surface); } }
header.nav .inner { display:flex; align-items:center; gap:28px; height:61px; }
.brand { display:flex; align-items:center; gap:9px; font-weight:650; letter-spacing:-.02em;
  font-size:17px; color:var(--ink); text-decoration:none; }
.brand .mark { width:22px; height:22px; color:var(--accent); }
header.nav nav { display:flex; gap:22px; margin-left:auto; align-items:center; }
header.nav nav a:not(.btn) { color:var(--ink-2); text-decoration:none; font-size:14.5px;
  transition:color .15s ease; }
header.nav nav a:not(.btn):hover { color:var(--ink); }

/* buttons */
.btn { display:inline-flex; align-items:center; gap:8px; border:none; cursor:pointer;
  font:inherit; font-size:14.5px; font-weight:560; padding:10px 19px; border-radius:999px;
  background:var(--accent); color:#fff; text-decoration:none;
  transition:background .15s ease, transform .15s ease, box-shadow .15s ease; }
.btn:hover { background:var(--accent-2); transform:translateY(-1px);
  box-shadow:0 8px 24px -10px rgba(31,93,63,.55); }
.btn:active { transform:translateY(0); }
.btn:focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
.btn.ghost { background:transparent; color:var(--ink); border:1px solid var(--rule); box-shadow:none; }
.btn.ghost:hover { background:var(--surface-2); border-color:var(--ink-3); box-shadow:none; }
.btn:disabled { opacity:.5; cursor:default; transform:none; box-shadow:none; }
.btn.lg { font-size:16px; padding:13px 26px; }
.btn.danger { background:var(--danger); }
.btn.danger:hover { background:#B04848; box-shadow:0 8px 24px -10px rgba(156,58,58,.55); }

/* type */
h1, h2 { font-family:var(--display); font-weight:600; font-variation-settings:"opsz" 60; }
h1 { font-size:clamp(36px,5vw,56px); line-height:1.04; letter-spacing:-.02em; margin:0 0 20px; text-wrap:balance; }
h2 { font-size:clamp(26px,3.2vw,36px); line-height:1.12; letter-spacing:-.015em; margin:0 0 14px; text-wrap:balance; }
h3 { font-size:18px; letter-spacing:-.01em; margin:0 0 8px; font-weight:620; }
p { margin:0 0 16px; color:var(--ink-2); }
.lede { font-size:19px; line-height:1.65; color:var(--ink-2); max-width:62ch; }
.eyebrow { font-family:var(--mono); font-size:12px; letter-spacing:.14em; text-transform:uppercase;
  color:var(--accent); margin:0 0 14px; }
code { font-family:var(--mono); font-size:.88em; background:var(--surface-2);
  padding:2px 6px; border-radius:4px; color:var(--ink); }
pre { font-family:var(--mono); font-size:13.5px; line-height:1.7; background:var(--surface);
  border:1px solid var(--rule); border-radius:var(--radius); padding:16px 18px;
  overflow-x:auto; margin:0 0 20px; color:var(--ink-2); box-shadow:var(--shadow); }
pre code { background:none; padding:0; font-size:1em; }

/* sections + cards */
section.band { padding:88px 0; border-bottom:1px solid var(--rule); }
section.band.tint { background:var(--surface-2); }
.grid { display:grid; gap:20px; }
.grid.g3 { grid-template-columns:repeat(auto-fit,minmax(268px,1fr)); }
.grid.g2 { grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
.card { background:var(--surface); border:1px solid var(--rule); border-radius:var(--radius);
  padding:24px; transition:transform .2s ease, box-shadow .2s ease, border-color .2s ease; }
.card:hover { transform:translateY(-2px); box-shadow:var(--shadow); }
.card h3 { margin-bottom:6px; }
.card p { font-size:14.5px; margin:0; }
.card .ico { width:26px; height:26px; color:var(--accent); margin-bottom:14px; display:block; }

/* forms */
label { display:block; font-size:14px; font-weight:560; margin:0 0 6px; color:var(--ink); }
.hint { font-size:13px; color:var(--ink-3); margin:6px 0 0; }
input[type=text], input[type=url], input[type=email], input[type=password], select, textarea {
  width:100%; font:inherit; font-size:15px; padding:11px 14px; border:1px solid var(--rule);
  border-radius:10px; background:var(--surface); color:var(--ink);
  transition:border-color .15s ease, box-shadow .15s ease; }
input:focus, select:focus, textarea:focus { outline:none; border-color:var(--accent);
  box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
.field { margin-bottom:20px; }
.row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }

/* misc */
.pill { display:inline-block; font-family:var(--mono); font-size:11px; letter-spacing:.07em;
  text-transform:uppercase; padding:3px 9px; border-radius:999px; background:var(--accent-tint); color:var(--accent); }
.pill.warn { background:rgba(138,90,0,.12); color:var(--warn); }
.pill.danger { background:rgba(156,58,58,.12); color:var(--danger); }
table { width:100%; border-collapse:collapse; font-size:14.5px; }
th,td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--rule); vertical-align:top; }
th { font-family:var(--mono); font-size:11.5px; letter-spacing:.08em; text-transform:uppercase;
  color:var(--ink-3); font-weight:500; }
.scroll { overflow-x:auto; }
footer.site { padding:48px 0 64px; color:var(--ink-3); font-size:14px; }
footer.site .cols { display:flex; justify-content:space-between; gap:24px; flex-wrap:wrap; align-items:flex-start; }
footer.site a:not(.btn) { color:var(--ink-2); text-decoration:none; margin-right:18px; }
footer.site a:not(.btn):hover { color:var(--ink); }
.steps { display:flex; gap:8px; margin:0 0 32px; padding:0; list-style:none; flex-wrap:wrap; }
.steps li { font-family:var(--mono); font-size:12px; letter-spacing:.06em; text-transform:uppercase;
  color:var(--ink-3); padding:6px 12px; border-radius:999px; border:1px solid var(--rule); }
.steps li.on { color:var(--accent); border-color:var(--accent); background:var(--accent-tint); }
.steps li.done { color:var(--ink-2); }

/* scroll reveal — elements with .reveal fade/rise in when .in is added by JS.
   Harmless without JS: the base state is fully visible unless JS tags the
   root with .js first, so no-script visitors never see a blank page. */
.js .reveal { opacity:0; transform:translateY(18px);
  transition:opacity .6s cubic-bezier(.2,.6,.2,1), transform .6s cubic-bezier(.2,.6,.2,1); }
.js .reveal.in { opacity:1; transform:none; }
.js .reveal.d1 { transition-delay:.08s; } .js .reveal.d2 { transition-delay:.16s; }
.js .reveal.d3 { transition-delay:.24s; } .js .reveal.d4 { transition-delay:.32s; }

@media (prefers-reduced-motion: reduce) { * { transition:none !important; animation:none !important; }
  html { scroll-behavior:auto; } .js .reveal { opacity:1; transform:none; } }
`;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,640&family=Inter:wght@400;500;560;650&display=swap" rel="stylesheet">`;

const REVEAL_JS = `document.documentElement.classList.add('js');
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  var io = new IntersectionObserver(function(es){ es.forEach(function(e){
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }); }, { threshold:.12 });
  document.querySelectorAll('.reveal').forEach(function(el){ io.observe(el); });
  // Failsafe: reveal is decoration and must never be able to blank the page.
  // Backgrounded tabs, print, and throttled webviews can starve the observer.
  setTimeout(function(){ document.querySelectorAll('.reveal:not(.in)').forEach(function(el){ el.classList.add('in'); }); }, 4000);
} else { document.querySelectorAll('.reveal').forEach(function(el){ el.classList.add('in'); }); }`;

const MARK = `<svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20h18"/><path d="M6 20V10l6-5 6 5v10"/><path d="M10 20v-5h4v5"/></svg>`;

export interface PageOpts {
  title: string;
  description?: string;
  /** Extra <script> body appended before </body>. Trusted, authored by us. */
  script?: string;
  active?: string;
  /** Logged-in owner, if any — swaps the nav between Log in/Sign up and Dashboard/Log out. */
  user?: { email: string } | null;
  /** Full-bleed pages (auth) — keeps the nav, drops the marketing footer. */
  bare?: boolean;
}

export function page(opts: PageOpts, body: string): string {
  const nav = (href: string, label: string) =>
    `<a href="${href}"${opts.active === label ? ' style="color:var(--ink)"' : ""}>${label}</a>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${opts.title}</title>
<meta name="description" content="${opts.description ?? ""}">
<meta name="color-scheme" content="light dark">
${FONTS}
<style>${STYLES}</style>
</head><body>
<header class="nav"><div class="wrap inner">
  <a class="brand" href="/">${MARK} Groundwork</a>
  <nav>
    ${nav("/docs", "Docs")}
    ${nav("/#guardrails", "Guardrails")}
    ${
      opts.user
        ? `<a href="/dashboard">Dashboard</a>
           <form method="post" action="/logout" style="margin:0"><button class="btn ghost" type="submit">Log out</button></form>`
        : `<a href="/login">Log in</a>
           <a class="btn" href="/signup">Add your site</a>`
    }
  </nav>
</div></header>
${body}
${
  opts.bare
    ? ""
    : `<footer class="site"><div class="wrap cols">
  <div>
    <a class="brand" href="/" style="font-size:15px">${MARK} Groundwork</a>
    <p style="margin-top:12px;font-size:13px;max-width:34ch">Answers grounded in your content. Nothing invented.</p>
  </div>
  <div style="padding-top:4px">
    <a href="/docs">Docs</a><a href="/#guardrails">Guardrails</a><a href="/onboard">Add your site</a><a href="/login">Log in</a>
  </div>
</div></footer>`
}
<script>${REVEAL_JS}${opts.script ?? ""}</script>
</body></html>`;
}

export { html, raw };
