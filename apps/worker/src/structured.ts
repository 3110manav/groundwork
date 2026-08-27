import { JSDOM } from "jsdom";

/**
 * Structured-data harvest: schema.org JSON-LD and microdata.
 *
 * This is the highest-quality text on most commercial sites and it was being
 * ignored entirely. Products with prices, FAQ pairs, opening hours, service
 * catalogues, breadcrumbs — all machine-authored, all exact, all invisible to
 * a prose extractor because it lives in <script> tags.
 */

export interface FaqPair { q: string; a: string; }
export interface ProductInfo {
  name: string;
  description?: string;
  price?: string;
  brand?: string;
  category?: string;
  sku?: string;
  availability?: string;
}

export interface StructuredData {
  faqs: FaqPair[];
  products: ProductInfo[];
  services: string[];
  breadcrumbs: string[];
  organisation: { name?: string; description?: string; founded?: string; areaServed?: string[] };
}

const clean = (s: unknown): string =>
  typeof s === "string" ? s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";

function typesOf(o: Record<string, unknown>): string[] {
  const t = o["@type"];
  if (typeof t === "string") return [t.toLowerCase()];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase());
  return [];
}

function priceOf(o: Record<string, unknown>): string | undefined {
  const offers = o.offers as Record<string, unknown> | Record<string, unknown>[] | undefined;
  const first = Array.isArray(offers) ? offers[0] : offers;
  if (!first || typeof first !== "object") return undefined;
  const p = clean(first.price) || clean((first as any).lowPrice);
  const cur = clean(first.priceCurrency);
  if (!p) return undefined;
  return cur ? `${p} ${cur}` : p;
}

function walk(node: unknown, out: StructuredData, depth = 0): void {
  if (depth > 8) return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, out, depth + 1));
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  const types = typesOf(o);

  // FAQPage / QAPage — a direct question-answer index, exactly what we want.
  if (types.includes("question") && o.acceptedAnswer) {
    const q = clean(o.name) || clean(o.text);
    const a = clean((o.acceptedAnswer as Record<string, unknown>)?.text);
    if (q && a) out.faqs.push({ q, a });
  }

  if (types.some((t) => ["product", "individualproduct", "productmodel"].includes(t))) {
    const name = clean(o.name);
    if (name) {
      out.products.push({
        name,
        description: clean(o.description) || undefined,
        price: priceOf(o),
        brand: clean((o.brand as any)?.name ?? o.brand) || undefined,
        category: clean(o.category) || undefined,
        sku: clean(o.sku) || undefined,
        availability: clean((o.offers as any)?.availability).split("/").pop() || undefined,
      });
    }
  }

  if (types.some((t) => ["service", "offercatalog"].includes(t))) {
    const n = clean(o.name);
    if (n) out.services.push(n);
  }

  if (types.includes("breadcrumblist") && Array.isArray(o.itemListElement)) {
    for (const el of o.itemListElement) {
      const n = clean((el as any)?.name ?? (el as any)?.item?.name);
      if (n) out.breadcrumbs.push(n);
    }
  }

  if (types.some((t) => ["organization", "localbusiness", "store", "corporation"].includes(t))) {
    out.organisation.name ||= clean(o.name) || undefined;
    out.organisation.description ||= clean(o.description) || undefined;
    out.organisation.founded ||= clean(o.foundingDate) || undefined;
    const area = o.areaServed;
    if (Array.isArray(area)) out.organisation.areaServed = area.map(clean).filter(Boolean);
    else if (clean(area)) out.organisation.areaServed = [clean(area)];
  }

  for (const v of Object.values(o)) if (v && typeof v === "object") walk(v, out, depth + 1);
}

/** Visible FAQ accordions — very common, and rarely marked up as FAQPage. */
function domFaqs(doc: Document): FaqPair[] {
  const out: FaqPair[] = [];
  const qEls = Array.from(doc.querySelectorAll("summary, [class*=question i], [class*=faq i] h3, [class*=faq i] h4, [class*=accordion i] button"));
  for (const q of qEls) {
    const question = clean(q.textContent);
    if (question.length < 8 || question.length > 200) continue;
    if (!/\?$|^(what|how|why|when|where|who|can|do|does|is|are|will)\b/i.test(question)) continue;
    const holder = q.closest("details, li, div, section");
    const answer = clean(holder?.textContent).replace(question, "").trim();
    if (answer.length > 20 && answer.length < 1500) out.push({ q: question, a: answer });
  }
  return out;
}

export function extractStructured(html: string, url: string): StructuredData {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const out: StructuredData = { faqs: [], products: [], services: [], breadcrumbs: [], organisation: {} };

  for (const el of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try { walk(JSON.parse(el.textContent ?? ""), out); } catch { /* malformed is common */ }
  }
  out.faqs.push(...domFaqs(doc));

  // Dedupe
  const seenQ = new Set<string>();
  out.faqs = out.faqs.filter((f) => !seenQ.has(f.q.toLowerCase()) && seenQ.add(f.q.toLowerCase())).slice(0, 60);
  const seenP = new Set<string>();
  out.products = out.products.filter((p) => !seenP.has(p.name.toLowerCase()) && seenP.add(p.name.toLowerCase())).slice(0, 200);
  out.services = [...new Set(out.services)].slice(0, 60);
  out.breadcrumbs = [...new Set(out.breadcrumbs)].slice(0, 20);
  return out;
}

export function structuredToText(s: StructuredData): string[] {
  const blocks: string[] = [];
  if (s.faqs.length) {
    blocks.push("## Frequently asked questions\n" + s.faqs.map((f) => `Q: ${f.q}\nA: ${f.a}`).join("\n\n"));
  }
  if (s.products.length) {
    blocks.push(
      "## Products and offerings\n" +
        s.products
          .map((p) =>
            [p.name, p.price && `price ${p.price}`, p.brand && `brand ${p.brand}`,
             p.category && `category ${p.category}`, p.availability, p.description]
              .filter(Boolean).join(" — "),
          )
          .join("\n"),
    );
  }
  if (s.services.length) blocks.push("## Services\n" + s.services.join("\n"));
  return blocks;
}
