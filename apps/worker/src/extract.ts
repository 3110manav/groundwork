import { JSDOM } from "jsdom";
import { createHash } from "node:crypto";

/**
 * Full-page extraction.
 *
 * This file used to run Mozilla Readability, which is a NEWS-ARTICLE extractor:
 * it finds "the article" and discards everything else. On business sites,
 * "everything else" is the product — service grids, pricing tables, FAQ
 * accordions, feature lists, contact strips, footers. Every silent-empty-index
 * bug this project has hit traces back to that one wrong tool choice, and each
 * earlier fix (contact extraction, structured data) was a patch around it.
 *
 * The replacement walks the full DOM and serialises EVERY visible text-bearing
 * element to markdown, preserving document order and heading structure:
 *
 *   - headings -> #/##/### (clamped sensibly)
 *   - tables   -> markdown tables (pricing lives here)
 *   - lists    -> bullets
 *   - definition lists, blockquotes, figures with captions
 *   - links kept inline where the anchor text carries meaning
 *
 * De-boilerplating (nav repeated on every page, cookie banners) is handled
 * downstream by cross-page shingling in stripBoilerplate() — repetition across
 * pages is a much more reliable boilerplate signal than DOM position, and it
 * never deletes something that appears once, which is exactly the mistake
 * Readability made with addresses.
 */

export interface ExtractedPage {
  url: string;
  title: string;
  markdown: string;
  contentHash: string;
}

const SKIP_TAGS = new Set([
  "script", "style", "noscript", "template", "svg", "canvas", "iframe",
  "object", "embed", "video", "audio", "source", "track", "map", "dialog",
]);

const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "main", "header", "footer", "aside",
  "li", "dt", "dd", "blockquote", "figcaption", "address", "form", "fieldset",
]);

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function isHidden(el: Element): boolean {
  const style = (el.getAttribute("style") ?? "").toLowerCase();
  if (/display\s*:\s*none|visibility\s*:\s*hidden/.test(style)) return true;
  if (el.hasAttribute("hidden")) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  return false;
}

function tableToMarkdown(table: Element): string {
  const rows: string[][] = [];
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    const cells = Array.from(tr.querySelectorAll("th,td")).map((c) => clean(c.textContent ?? ""));
    if (cells.some((c) => c.length > 0)) rows.push(cells);
  }
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => [...r, ...Array(width - r.length).fill("")]);
  const lines = [
    `| ${norm[0]!.join(" | ")} |`,
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...norm.slice(1).map((r) => `| ${r.join(" | ")} |`),
  ];
  return lines.join("\n");
}

export function extract(url: string, html: string): ExtractedPage | null {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const title = clean(doc.querySelector("title")?.textContent ?? "") || url;

  const out: string[] = [];
  /** Lines already emitted, to collapse element-level duplicates in one page. */
  const emitted = new Set<string>();

  const push = (line: string) => {
    const l = line.trimEnd();
    if (!l) return;
    // Collapse exact repeats within the page (menus rendered twice for
    // mobile/desktop are the classic case) but allow short labels through.
    const key = l.toLowerCase();
    if (l.length > 30 && emitted.has(key)) return;
    emitted.add(key);
    out.push(l);
  };

  const walk = (node: Node): void => {
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    if (SKIP_TAGS.has(tag) || isHidden(el)) return;

    if (/^h[1-6]$/.test(tag)) {
      const depth = Math.min(Number(tag[1]), 4);
      const text = clean(el.textContent ?? "");
      if (text) push(`\n${"#".repeat(depth)} ${text}\n`);
      return;
    }

    if (tag === "table") {
      const md = tableToMarkdown(el);
      if (md) push(`\n${md}\n`);
      return;
    }

    if (tag === "ul" || tag === "ol") {
      for (const li of Array.from(el.children).filter((c) => c.tagName.toLowerCase() === "li")) {
        const text = clean(li.textContent ?? "");
        if (text && text.length < 500) push(`- ${text}`);
        else if (text) { walk(li); }
      }
      return;
    }

    if (tag === "dl") {
      let dt = "";
      for (const child of Array.from(el.children)) {
        const t = child.tagName.toLowerCase();
        if (t === "dt") dt = clean(child.textContent ?? "");
        if (t === "dd" && dt) push(`- **${dt}**: ${clean(child.textContent ?? "")}`);
      }
      return;
    }

    if (tag === "blockquote") {
      const text = clean(el.textContent ?? "");
      if (text) push(`> ${text}`);
      return;
    }

    if (tag === "img") {
      const alt = clean(el.getAttribute("alt") ?? "");
      // Alt text is content when it is descriptive; skip decorative/empty alts.
      if (alt.length > 12) push(`(image: ${alt})`);
      return;
    }

    // Leaf-ish blocks: emit own text if no element children carry it.
    const hasBlockChildren = Array.from(el.children).some(
      (c) => BLOCK_TAGS.has(c.tagName.toLowerCase()) || /^h[1-6]$|^ul$|^ol$|^table$|^dl$/.test(c.tagName.toLowerCase()),
    );
    if (!hasBlockChildren && BLOCK_TAGS.has(tag)) {
      const text = clean(el.textContent ?? "");
      if (text) push(text);
      return;
    }

    for (const child of Array.from(el.childNodes)) walk(child);
  };

  walk(doc.body ?? doc.documentElement);

  const markdown = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (markdown.length < 80) return null;

  return {
    url,
    title,
    markdown,
    contentHash: createHash("sha256").update(markdown).digest("hex"),
  };
}

/**
 * Boilerplate removal by cross-page shingling — unchanged in approach, but now
 * it is the ONLY de-boilerplating step, so its threshold matters more. A line
 * must appear on >40% of pages to be dropped, and short lines (nav labels) are
 * exempt from protection: they are dropped at a lower bar because single-word
 * repeats are never content.
 */
export function stripBoilerplate(pages: ExtractedPage[], threshold = 0.4): ExtractedPage[] {
  if (pages.length < 4) return pages;

  const lineCounts = new Map<string, number>();
  for (const page of pages) {
    const seen = new Set(page.markdown.split("\n").map((l) => l.trim()).filter((l) => l.length > 4));
    for (const line of seen) lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
  }

  const cutoff = pages.length * threshold;
  const shortCutoff = pages.length * 0.6;
  const boilerplate = new Set(
    [...lineCounts.entries()]
      .filter(([line, n]) => (line.length > 12 ? n > cutoff : n > shortCutoff))
      .map(([line]) => line),
  );

  return pages.map((page) => {
    const kept = page.markdown
      .split("\n")
      .filter((l) => !boilerplate.has(l.trim()))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { ...page, markdown: kept, contentHash: createHash("sha256").update(kept).digest("hex") };
  });
}
