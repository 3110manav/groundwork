import { chromium, type Browser } from "playwright-core";

/**
 * Headless rendering, for pages whose content only exists after JavaScript runs.
 *
 * This was a TODO for a long time and the cost of leaving it a stub was
 * concrete: a real customer site (a marble supplier on a JS-rendered stack)
 * indexed **zero pages**. Detection had always worked — `needsRendering()`
 * flagged it correctly — but the fetch path returned the un-rendered shell
 * anyway, extraction found nothing above the floor, and the failure only
 * surfaced two stages later when the core-pack model reported that the pages
 * it had been handed were empty.
 *
 * Deliberate choices:
 *  - `playwright-core` + the SYSTEM Chrome, so there is no 300MB browser
 *    download in the install path.
 *  - One browser reused across pages, a fresh context per page. Launching a
 *    browser per page is roughly a second of pure overhead each.
 *  - Images, fonts, media and stylesheets are aborted. We want the DOM's text,
 *    and blocking them is the single biggest speed win.
 *  - Every failure degrades to "no rendered HTML" rather than throwing, so one
 *    bad page cannot fail an entire crawl.
 */

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean) as string[];

const NAV_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS ?? 20_000);
const BLOCKED = new Set(["image", "media", "font", "stylesheet"]);

let browser: Browser | null = null;
let launchFailed = false;

async function getBrowser(): Promise<Browser | null> {
  if (browser) return browser;
  if (launchFailed) return null;

  const { existsSync } = await import("node:fs");
  const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));

  try {
    browser = await chromium.launch({
      // Fall back to whatever Playwright can find if no system Chrome exists.
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    browser.on("disconnected", () => { browser = null; });
    console.log(`  renderer: using ${executablePath ?? "playwright chrome channel"}`);
    return browser;
  } catch (err) {
    launchFailed = true;
    console.warn(
      `  renderer UNAVAILABLE (${err instanceof Error ? err.message.split("\n")[0] : err}). ` +
        `JS-rendered pages will index as shells. Install Chrome or set CHROME_PATH.`,
    );
    return null;
  }
}

export async function renderPage(url: string, userAgent: string): Promise<string | null> {
  const b = await getBrowser();
  if (!b) return null;

  const context = await b.newContext({ userAgent, viewport: { width: 1280, height: 900 } });
  try {
    const pageCtx = await context.newPage();
    await pageCtx.route("**/*", (route) => {
      if (BLOCKED.has(route.request().resourceType())) return route.abort();
      return route.continue();
    });

    await pageCtx.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    // `networkidle` is the honest signal that a client-rendered page has
    // settled, but plenty of sites keep a socket open forever — so treat a
    // timeout here as "good enough" rather than a failure.
    await pageCtx.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
    return await pageCtx.content();
  } catch (err) {
    console.warn(`  render failed ${url}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    return null;
  } finally {
    await context.close().catch(() => {});
  }
}

export async function closeRenderer(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}
