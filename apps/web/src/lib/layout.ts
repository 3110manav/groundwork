import { html, raw } from "./html.js";

/**
 * One design system for the whole site. Palette is a cool slate ground with a
 * single deep-green accent — green because the product's claim is "grounded",
 * and because every other AI product on the internet is purple.
 */
const STYLES = `
:root {
  --bg:        #FBFBFA;
  --surface:   #FFFFFF;
  --surface-2: #F3F4F1;
  --ink:       #14180F;
  --ink-2:     #4A5142;
  --ink-3:     #7C8474;
  --rule:      #E1E4DC;
  --accent:    #1F5D3F;
  --accent-2:  #2C7A54;
  --accent-tint:#E8F2EC;
  --warn:      #8A5A00;
  --danger:    #9C3A3A;
  --radius:    10px;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Mono", Menlo, Consolas, monospace;
  --sans: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --shadow: 0 1px 2px rgba(20,24,15,.04), 0 12px 32px -16px rgba(20,24,15,.16);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg:#0F1210; --surface:#161A17; --surface-2:#1C211D; --ink:#E9EDE6;
    --ink-2:#A9B2A3; --ink-3:#7A8375; --rule:#2A302B;
    --accent:#6FCF97; --accent-2:#8ADCAC; --accent-tint:#16241C;
    --warn:#D9A34A; --danger:#E08585;
    --shadow: 0 1px 2px rgba(0,0,0,.5), 0 12px 32px -16px rgba(0,0,0,.8);
  }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans);
  font-size:16px; line-height:1.6; -webkit-font-smoothing:antialiased; }
a { color: var(--accent); }
.wrap { max-width: 1060px; margin: 0 auto; padding: 0 24px; }
.narrow { max-width: 760px; }

/* nav */
header.nav { border-bottom:1px solid var(--rule); background:var(--surface); position:sticky; top:0; z-index:50; }
header.nav .inner { display:flex; align-items:center; gap:28px; height:60px; }
.brand { display:flex; align-items:center; gap:9px; font-weight:650; letter-spacing:-.02em;
  font-size:17px; color:var(--ink); text-decoration:none; }
.brand .mark { width:22px; height:22px; }
header.nav nav { display:flex; gap:22px; margin-left:auto; align-items:center; }
header.nav nav a:not(.btn) { color:var(--ink-2); text-decoration:none; font-size:14.5px; }
header.nav nav a:not(.btn):hover { color:var(--ink); }

/* buttons */
.btn { display:inline-flex; align-items:center; gap:8px; border:none; cursor:pointer;
  font:inherit; font-size:14.5px; font-weight:550; padding:9px 17px; border-radius:8px;
  background:var(--accent); color:#fff; text-decoration:none; }
.btn:hover { background:var(--accent-2); }
.btn.ghost { background:transparent; color:var(--ink); border:1px solid var(--rule); }
.btn.ghost:hover { background:var(--surface-2); }
.btn:disabled { opacity:.5; cursor:default; }
.btn.lg { font-size:16px; padding:12px 22px; }

/* type */
h1 { font-size:clamp(34px,5vw,52px); line-height:1.05; letter-spacing:-.03em; margin:0 0 20px; text-wrap:balance; }
h2 { font-size:clamp(24px,3vw,32px); line-height:1.15; letter-spacing:-.022em; margin:0 0 14px; text-wrap:balance; }
h3 { font-size:18px; letter-spacing:-.01em; margin:0 0 8px; }
p { margin:0 0 16px; color:var(--ink-2); }
.lede { font-size:19px; color:var(--ink-2); max-width:62ch; }
.eyebrow { font-family:var(--mono); font-size:12px; letter-spacing:.13em; text-transform:uppercase;
  color:var(--accent); margin:0 0 14px; }
code { font-family:var(--mono); font-size:.88em; background:var(--surface-2);
  padding:2px 6px; border-radius:4px; color:var(--ink); }
pre { font-family:var(--mono); font-size:13.5px; line-height:1.7; background:var(--surface);
  border:1px solid var(--rule); border-radius:var(--radius); padding:16px 18px;
  overflow-x:auto; margin:0 0 20px; color:var(--ink-2); }
pre code { background:none; padding:0; font-size:1em; }

/* sections + cards */
section.band { padding:76px 0; border-bottom:1px solid var(--rule); }
section.band.tint { background:var(--surface-2); }
.grid { display:grid; gap:20px; }
.grid.g3 { grid-template-columns:repeat(auto-fit,minmax(268px,1fr)); }
.grid.g2 { grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
.card { background:var(--surface); border:1px solid var(--rule); border-radius:var(--radius); padding:22px; }
.card h3 { margin-bottom:6px; }
.card p { font-size:14.5px; margin:0; }
.card .ico { width:24px; height:24px; color:var(--accent); margin-bottom:12px; display:block; }

/* forms */
label { display:block; font-size:14px; font-weight:550; margin:0 0 6px; color:var(--ink); }
.hint { font-size:13px; color:var(--ink-3); margin:6px 0 0; }
input[type=text], input[type=url], input[type=email], select, textarea {
  width:100%; font:inherit; font-size:15px; padding:10px 12px; border:1px solid var(--rule);
  border-radius:8px; background:var(--surface); color:var(--ink); }
input:focus, select:focus, textarea:focus { outline:2px solid var(--accent); outline-offset:-1px; }
.field { margin-bottom:20px; }
.row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }

/* misc */
.pill { display:inline-block; font-family:var(--mono); font-size:11px; letter-spacing:.07em;
  text-transform:uppercase; padding:3px 8px; border-radius:4px; background:var(--accent-tint); color:var(--accent); }
.pill.warn { background:rgba(138,90,0,.12); color:var(--warn); }
.pill.danger { background:rgba(156,58,58,.12); color:var(--danger); }
table { width:100%; border-collapse:collapse; font-size:14.5px; }
th,td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--rule); vertical-align:top; }
th { font-family:var(--mono); font-size:11.5px; letter-spacing:.08em; text-transform:uppercase;
  color:var(--ink-3); font-weight:500; }
.scroll { overflow-x:auto; }
footer.site { padding:40px 0 60px; color:var(--ink-3); font-size:14px; }
footer.site a:not(.btn) { color:var(--ink-2); text-decoration:none; margin-right:18px; }
.steps { display:flex; gap:8px; margin:0 0 32px; padding:0; list-style:none; flex-wrap:wrap; }
.steps li { font-family:var(--mono); font-size:12px; letter-spacing:.06em; text-transform:uppercase;
  color:var(--ink-3); padding:6px 12px; border-radius:999px; border:1px solid var(--rule); }
.steps li.on { color:var(--accent); border-color:var(--accent); background:var(--accent-tint); }
.steps li.done { color:var(--ink-2); }
@media (prefers-reduced-motion: reduce) { * { transition:none !important; animation:none !important; } }
`;

const MARK = `<svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 20h18"/><path d="M6 20V10l6-5 6 5v10"/><path d="M10 20v-5h4v5"/></svg>`;

export interface PageOpts {
  title: string;
  description?: string;
  /** Extra <script> body appended before </body>. Trusted, authored by us. */
  script?: string;
  active?: string;
  /** Logged-in owner, if any — swaps the nav between Log in/Sign up and Dashboard/Log out. */
  user?: { email: string } | null;
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
<footer class="site"><div class="wrap">
  <a href="/">Groundwork</a><a href="/docs">Docs</a><a href="/onboard">Add your site</a>
  <p style="margin-top:14px;font-size:13px">Answers grounded in your content. Nothing invented.</p>
</div></footer>
${opts.script ? `<script>${opts.script}</script>` : ""}
</body></html>`;
}

export { html, raw };
