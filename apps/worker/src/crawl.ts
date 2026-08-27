import { XMLParser } from "fast-xml-parser";
import { renderPage } from "./render.js";

export interface FetchedPage {
  url: string;
  html: string;
  /** True when we had to spin up a headless browser to get usable content. */
  rendered: boolean;
}

const USER_AGENT = "groundwork-crawler/0.1 (+https://yourapp.com/crawler)";
const DEFAULT_MAX_PAGES = 200;

const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|txt|pdf|zip|mp4|webm|woff2?|ttf)$/i;

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "follow" });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("html") && !type.includes("xml")) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Plain fetch first, headless render only if the result looks JS-dependent.
 *
 * DISCOVERY has to go through here too, not just page fetching: on a
 * client-rendered site the un-rendered shell contains no links either, so BFS
 * finds exactly one page. That is precisely what happened on the first
 * JS-rendered site we met — 1 page discovered, 0 indexed.
 */
async function getHtml(url: string): Promise<{ html: string; rendered: boolean } | null> {
  const plain = await fetchText(url);
  if (plain && !needsRendering(plain)) return { html: plain, rendered: false };

  const rendered = await renderPage(url, USER_AGENT);
  if (rendered) return { html: rendered, rendered: true };
  // Renderer unavailable or failed: fall back to the shell so the crawl still
  // makes progress, and let the caller warn about it.
  return plain ? { html: plain, rendered: false } : null;
}

/** Hosts differing only by `www.` are the same site for crawl purposes. */
function sameSite(a: string, b: string): boolean {
  return a.replace(/^www\./, "") === b.replace(/^www\./, "");
}

/**
 * Collapse a URL to one canonical form.
 *
 * Without this, `www.example.com/x` and `example.com/x` are crawled, embedded
 * and indexed as two separate pages — doubling embedding spend and, worse,
 * returning the same content twice in every top-k, which crowds out genuinely
 * different chunks. Observed on the first real crawl: 4 pages indexed as 8.
 */
export function canonicalize(raw: string, canonicalHost: string): string {
  const u = new URL(raw);
  u.hash = "";
  u.hostname = canonicalHost;
  u.protocol = "https:";
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  // Tracking params change nothing about the content.
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|ref$|source$)/i.test(k)) u.searchParams.delete(k);
  }
  return u.toString();
}

export interface Robots {
  disallow: string[];
  sitemaps: string[];
}

/**
 * Minimal robots.txt parser: the `User-agent: *` group's Disallow rules plus
 * any Sitemap declarations. We are a guest on someone else's server — honouring
 * Disallow is not optional, and the previous version read only the Sitemap
 * lines while ignoring the rules entirely.
 */
export function parseRobots(txt: string): Robots {
  const disallow: string[] = [];
  const sitemaps: string[] = [];
  let inStar = false;

  for (const raw of txt.split("\n")) {
    const line = raw.split("#")[0]!.trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey!.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "sitemap") { sitemaps.push(value); continue; }
    if (key === "user-agent") { inStar = value === "*"; continue; }
    if (inStar && key === "disallow" && value) disallow.push(value);
  }
  return { disallow, sitemaps };
}

export function isAllowed(pathname: string, robots: Robots): boolean {
  return !robots.disallow.some((rule) => pathname.startsWith(rule));
}

async function readRobots(origin: string): Promise<Robots> {
  const txt = await fetchText(`${origin}/robots.txt`);
  return txt ? parseRobots(txt) : { disallow: [], sitemaps: [] };
}

async function readSitemaps(urls: string[]): Promise<string[]> {
  const parser = new XMLParser();
  const found: string[] = [];
  for (const sm of urls) {
    const xml = await fetchText(sm);
    if (!xml) continue;
    try {
      const doc = parser.parse(xml) as Record<string, any>;
      const entries = doc.urlset?.url ?? doc.sitemapindex?.sitemap ?? [];
      for (const e of Array.isArray(entries) ? entries : [entries]) {
        const loc = typeof e === "string" ? e : e?.loc;
        if (typeof loc === "string") found.push(loc);
      }
    } catch {
      /* malformed sitemap — BFS still covers us */
    }
  }
  return found;
}

function extractLinks(html: string, base: string, robots: Robots): string[] {
  const origin = new URL(base);
  const out = new Set<string>();
  for (const m of html.matchAll(/href="([^"]+)"/gi)) {
    const href = m[1]!;
    if (href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("#")) continue;
    let u: URL;
    try { u = new URL(href, base); } catch { continue; }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    if (!sameSite(u.hostname, origin.hostname)) continue;
    if (ASSET_RE.test(u.pathname)) continue;
    if (!isAllowed(u.pathname, robots)) continue;
    u.hash = "";
    out.add(u.toString());
  }
  return [...out];
}

/**
 * Discover URLs: sitemap entries SEED the crawl, they do not define it.
 *
 * Real sitemaps are routinely incomplete — this was found the hard way against
 * a site whose sitemap listed exactly one URL while the site had several real
 * pages. Treating the sitemap as authoritative silently indexed 1/5th of that
 * site with no error anywhere. So: seed from sitemap + homepage, then BFS the
 * same origin under robots rules, bounded by maxPages.
 */
export async function discover(origin: string, maxPages = DEFAULT_MAX_PAGES): Promise<string[]> {
  const robots = await readRobots(origin);
  // Whichever host form the caller registered wins; everything collapses to it.
  const canonicalHost = new URL(origin).hostname;
  const seeds = [origin, ...(await readSitemaps([`${origin}/sitemap.xml`, ...robots.sitemaps]))];

  const seen = new Set<string>();
  const queue: string[] = [];

  const enqueue = (raw: string) => {
    let u: URL;
    try { u = new URL(raw); } catch { return; }
    if (!sameSite(u.hostname, canonicalHost)) return;
    if (!isAllowed(u.pathname, robots)) return;
    const canon = canonicalize(u.toString(), canonicalHost);
    if (seen.has(canon)) return;
    seen.add(canon);
    queue.push(canon);
  };

  for (const s of seeds) enqueue(s);

  const ordered: string[] = [];
  while (queue.length > 0 && ordered.length < maxPages) {
    const url = queue.shift()!;
    ordered.push(url);
    const got = await getHtml(url);
    if (!got) continue;
    if (seen.size < maxPages * 3) for (const link of extractLinks(got.html, url, robots)) enqueue(link);
  }

  return ordered;
}

/**
 * A browser render costs 50–100x a plain fetch, so it must stay the exception.
 * Signal for "this page needs JS": almost no text relative to markup, or an
 * empty root node next to a large bundle.
 */
export function needsRendering(html: string): boolean {
  const textLength = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;

  const ratio = textLength / Math.max(html.length, 1);
  const spaFrame = /<div id="(root|app|__next)"[^>]*>\s*<\/div>/i.test(html);
  return ratio < 0.03 || spaFrame;
}

export async function fetchPage(url: string): Promise<FetchedPage | null> {
  const got = await getHtml(url);
  if (!got) return null;
  return { url, html: got.html, rendered: got.rendered };
}

export { closeRenderer } from "./render.js";
