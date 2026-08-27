import { JSDOM } from "jsdom";

/**
 * Contact and location extraction.
 *
 * Readability keeps the "article" and discards header, footer, nav and contact
 * strips — which is exactly where every business puts its address, phone and
 * email. The result was that the single most common question a visitor asks
 * ("where are you?" / "how do I reach you?") was systematically deleted at
 * index time, on every site, while the page itself plainly contained it.
 *
 * So contact details are extracted separately, from the DOM before Readability
 * touches it, and written as their own high-priority chunk. Four sources in
 * descending order of trustworthiness:
 *
 *   1. JSON-LD (schema.org Organization / LocalBusiness) — structured, exact.
 *   2. tel: and mailto: links — unambiguous by construction.
 *   3. <address> elements.
 *   4. Text near a contact heading — the fallback, since plenty of sites (this
 *      one included) publish an address as plain text under "Our Location".
 */

export interface ContactInfo {
  phones: string[];
  emails: string[];
  addresses: string[];
  social: string[];
  hours: string[];
}

const CONTACT_HEADING =
  /^(our\s+)?(location|address|contact|find\s+us|visit\s+us|reach\s+us|showroom|store|office|get\s+in\s+touch)/i;

const ADDRESS_HINT =
  /\b(shop\s*no|plot\s*no|flat\s*no|suite|floor|road|rd\.?|street|st\.?|avenue|ave\.?|lane|marg|nagar|sector|block|opp\.?|opposite|near|building|complex|industrial\s+area|po\s*box)\b/i;

const POSTCODE = /\b(\d{6}|\d{5}(-\d{4})?|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.map(clean).filter(Boolean))];
}

/** schema.org PostalAddress → one line. */
function flattenAddress(a: unknown): string | null {
  if (typeof a === "string") return clean(a);
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  const parts = [
    o.streetAddress, o.addressLocality, o.addressRegion, o.postalCode, o.addressCountry,
  ]
    .map((p) => (typeof p === "string" ? p : typeof p === "object" && p ? String((p as any).name ?? "") : ""))
    .filter(Boolean);
  return parts.length ? clean(parts.join(", ")) : null;
}

function walkJsonLd(node: unknown, out: ContactInfo): void {
  if (Array.isArray(node)) return node.forEach((n) => walkJsonLd(n, out));
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;

  if (typeof o.telephone === "string") out.phones.push(o.telephone);
  if (typeof o.email === "string") out.emails.push(o.email.replace(/^mailto:/i, ""));
  if (o.address) {
    const a = flattenAddress(o.address);
    if (a) out.addresses.push(a);
  }
  if (Array.isArray(o.sameAs)) out.social.push(...o.sameAs.filter((s): s is string => typeof s === "string"));
  if (typeof o.openingHours === "string") out.hours.push(o.openingHours);
  if (Array.isArray(o.openingHours)) out.hours.push(...o.openingHours.filter((h): h is string => typeof h === "string"));

  for (const v of Object.values(o)) if (v && typeof v === "object") walkJsonLd(v, out);
}

export function extractContact(html: string, url: string): ContactInfo | null {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const out: ContactInfo = { phones: [], emails: [], addresses: [], social: [], hours: [] };

  // 1. JSON-LD
  for (const el of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      walkJsonLd(JSON.parse(el.textContent ?? ""), out);
    } catch {
      /* malformed structured data is common; the other sources still apply */
    }
  }

  // 2. tel: / mailto: — unambiguous
  for (const a of Array.from(doc.querySelectorAll('a[href^="tel:"]')))
    out.phones.push(decodeURIComponent((a.getAttribute("href") ?? "").slice(4)));
  for (const a of Array.from(doc.querySelectorAll('a[href^="mailto:"]')))
    out.emails.push(decodeURIComponent((a.getAttribute("href") ?? "").slice(7)).split("?")[0]!);

  // 3. <address>
  for (const a of Array.from(doc.querySelectorAll("address"))) {
    const t = clean(a.textContent ?? "");
    if (t.length > 10) out.addresses.push(t);
  }

  // 4. Text following a contact-ish heading or label. This is the one that
  //    catches sites with no structured data — the common case.
  const candidates = Array.from(doc.querySelectorAll("h1,h2,h3,h4,h5,h6,p,span,div,li,strong,b"));
  for (let i = 0; i < candidates.length; i++) {
    const label = clean(candidates[i]!.textContent ?? "");
    if (label.length > 60 || !CONTACT_HEADING.test(label)) continue;
    // Look at the next few text nodes for something address-shaped.
    for (let j = i + 1; j < Math.min(i + 8, candidates.length); j++) {
      const t = clean(candidates[j]!.textContent ?? "");
      if (t.length < 15 || t.length > 300) continue;
      if (ADDRESS_HINT.test(t) || POSTCODE.test(t)) {
        out.addresses.push(t);
        break;
      }
    }
  }

  // 5. Social profiles
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const h = a.getAttribute("href") ?? "";
    if (/^https?:\/\/(www\.)?(instagram|facebook|linkedin|twitter|x|youtube|wa\.me|api\.whatsapp)\.com\//i.test(h))
      out.social.push(h.split("?")[0]!);
  }

  const result: ContactInfo = {
    phones: uniq(out.phones).slice(0, 5),
    emails: uniq(out.emails).slice(0, 5),
    // Longest first: the fuller string is almost always the better address.
    addresses: uniq(out.addresses).sort((a, b) => b.length - a.length).slice(0, 3),
    social: uniq(out.social).slice(0, 8),
    hours: uniq(out.hours).slice(0, 7),
  };

  const found =
    result.phones.length + result.emails.length + result.addresses.length + result.hours.length;
  return found > 0 ? result : null;
}

/** Merge across pages — contact details are usually repeated site-wide. */
export function mergeContacts(all: (ContactInfo | null)[]): ContactInfo | null {
  const merged: ContactInfo = { phones: [], emails: [], addresses: [], social: [], hours: [] };
  for (const c of all) {
    if (!c) continue;
    merged.phones.push(...c.phones);
    merged.emails.push(...c.emails);
    merged.addresses.push(...c.addresses);
    merged.social.push(...c.social);
    merged.hours.push(...c.hours);
  }
  const out: ContactInfo = {
    phones: uniq(merged.phones).slice(0, 5),
    emails: uniq(merged.emails).slice(0, 5),
    addresses: uniq(merged.addresses).sort((a, b) => b.length - a.length).slice(0, 3),
    social: uniq(merged.social).slice(0, 8),
    hours: uniq(merged.hours).slice(0, 7),
  };
  const n = out.phones.length + out.emails.length + out.addresses.length + out.hours.length;
  return n > 0 ? out : null;
}

/** Render as a chunk body. Plain labelled lines retrieve well and read well. */
export function contactToText(c: ContactInfo, siteName: string): string {
  const lines = [`Contact and location details for ${siteName}.`];
  if (c.addresses.length) lines.push(`Address: ${c.addresses.join(" | ")}`);
  if (c.phones.length) lines.push(`Phone: ${c.phones.join(", ")}`);
  if (c.emails.length) lines.push(`Email: ${c.emails.join(", ")}`);
  if (c.hours.length) lines.push(`Opening hours: ${c.hours.join("; ")}`);
  if (c.social.length) lines.push(`Social: ${c.social.join(", ")}`);
  return lines.join("\n");
}
