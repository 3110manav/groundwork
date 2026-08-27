import { Hono } from "hono";
import { page } from "../lib/layout.js";
import { currentUser } from "../lib/auth.js";

export const docs = new Hono();

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

docs.get("/docs", async (c) =>
  c.html(
    page(
      { title: "Groundwork — Documentation", description: "Install Groundwork on your website.", active: "Docs", user: await currentUser(c) },
      `
<section class="band">
  <div class="wrap narrow">
    <p class="eyebrow">Documentation</p>
    <h1 style="font-size:clamp(30px,4vw,42px)">Integrate Groundwork</h1>
    <p class="lede">Everything below assumes you've already added your site and have a publishable key (<code>pk_live_…</code>). If not, <a href="/onboard">start here</a>.</p>

    <h2 style="margin-top:52px">Install</h2>
    <p>Paste this immediately before <code>&lt;/body&gt;</code> on every page you want the widget on.</p>
    <pre><code>${esc('<script src="https://cdn.groundwork.dev/w.js"\n        data-site-key="pk_live_your_key"\n        async></script>')}</code></pre>
    <p>That's the whole integration. The tag loads a ~525&nbsp;byte loader, which fetches your configuration and lazy-loads the widget once the page is idle — so it never competes with your own content for load time.</p>

    <h3 style="margin-top:34px">Attributes</h3>
    <div class="scroll"><table>
      <thead><tr><th>Attribute</th><th>Required</th><th>Purpose</th></tr></thead>
      <tbody>
        <tr><td><code>data-site-key</code></td><td>Yes</td><td>Your publishable key. Safe to expose — it only works from your verified domains.</td></tr>
        <tr><td><code>data-api-base</code></td><td>No</td><td>Override the API origin. Only needed for self-hosted deployments.</td></tr>
      </tbody>
    </table></div>

    <h2 style="margin-top:52px">Framework notes</h2>
    <h3>Next.js</h3>
    <pre><code>${esc('// app/layout.tsx\nimport Script from "next/script";\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>\n        {children}\n        <Script\n          src="https://cdn.groundwork.dev/w.js"\n          data-site-key="pk_live_your_key"\n          strategy="lazyOnload"\n        />\n      </body>\n    </html>\n  );\n}')}</code></pre>
    <h3>Shopify</h3>
    <p>Online Store → Themes → Edit code → <code>layout/theme.liquid</code>, paste before <code>&lt;/body&gt;</code>.</p>
    <h3>WordPress</h3>
    <p>Appearance → Theme File Editor → <code>footer.php</code>, or any "insert scripts in footer" plugin.</p>
    <h3>Webflow / Squarespace / Wix</h3>
    <p>Site settings → Custom code → Footer.</p>

    <h2 style="margin-top:52px">JavaScript API</h2>
    <p>The widget exposes <code>window.Groundwork</code>. Calls made before it finishes loading are queued, so you can call it immediately after the tag.</p>
    <pre><code>${esc('Groundwork.open();              // open the panel\nGroundwork.close();             // close it\nGroundwork.sendMessage("Do you ship to Canada?");\n\nGroundwork.on("message", (m) => analytics.track("chat_message", m));\nGroundwork.on("lead", (l) => crm.capture(l));')}</code></pre>

    <h2 style="margin-top:52px">Restricting chat to logged-in users</h2>
    <p><strong>Optional.</strong> Most sites don't need this — a public marketing site is protected by domain verification, rate limits and your spend cap. Turn it on when chat should only work for authenticated users, for example inside a customer dashboard.</p>
    <p>When enabled, your <em>server</em> signs the user's ID with your site secret and passes the signature to the widget. The secret never reaches the browser.</p>
    <pre><code>${esc('// your backend — never in client-side code\nimport { createHmac } from "node:crypto";\n\nconst signature = createHmac("sha256", process.env.GROUNDWORK_IDENTITY_SECRET)\n  .update(user.id)\n  .digest("hex");\n\n// render into the page for the widget to pick up\nres.render("app", { groundworkUserId: user.id, groundworkSig: signature });')}</code></pre>
    <pre><code>${esc('// client\nGroundwork.setUser({ id: groundworkUserId, hmac: groundworkSig });')}</code></pre>
    <p class="hint">Signatures are compared in constant time. A request with a missing, malformed or forged signature is rejected before any retrieval happens.</p>

    <h2 style="margin-top:52px">Keeping the index current</h2>
    <p>Re-index whenever your content changes materially. Pages that haven't changed cost nothing to re-index — we hash content and reuse existing embeddings.</p>
    <p>Re-indexing also clears the answer cache, so corrected content can't be served from a stale answer.</p>

    <h2 style="margin-top:52px">When it says "I don't know"</h2>
    <p>That's deliberate. If nothing on your site confidently matches the question, Groundwork declines instead of guessing. Two things help:</p>
    <ul>
      <li><strong>Check the unanswered-questions report.</strong> It's the list of things visitors want that your site doesn't say — usually more valuable than the chat itself.</li>
      <li><strong>Add the answer to your site,</strong> then re-index. The assistant improves because your site did.</li>
    </ul>

    <h2 style="margin-top:52px">Privacy</h2>
    <ul>
      <li>Your provider key is encrypted at rest and only ever used server-side.</li>
      <li>The publishable key is safe in your page source — it only works from your verified domains.</li>
      <li>Conversations are stored so you can review them. Nothing is used to train models.</li>
    </ul>
  </div>
</section>
`,
    ),
  ),
);
