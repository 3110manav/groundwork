import { createHash } from "node:crypto";
import type { ExtractedPage } from "./extract.js";

export interface Chunk {
  url: string;
  breadcrumb: string;
  content: string;
  tokenCount: number;
  contentHash: string;
}

const TARGET_TOKENS = 420;
const MIN_TOKENS = 120;
const OVERLAP_RATIO = 0.15;

const estimateTokens = (s: string) => Math.ceil(s.length / 3.8);

interface Section {
  heading: string[];
  body: string[];
}

function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let stack: string[] = [];
  let current: Section = { heading: [], body: [] };

  for (const line of markdown.split("\n")) {
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      if (current.body.length) sections.push(current);
      const depth = h[1]!.length;
      stack = stack.slice(0, depth - 1);
      stack[depth - 1] = h[2]!.trim();
      current = { heading: stack.filter(Boolean), body: [] };
    } else if (line.trim()) {
      current.body.push(line);
    }
  }
  if (current.body.length) sections.push(current);
  return sections;
}

/**
 * Structure-aware chunking that PACKS sections up to the target size.
 *
 * The obvious implementation — flush on every heading change — is wrong on the
 * sites this product actually meets. Marketing pages are heading-dense: one
 * real page produced 27 sections averaging 85 tokens against a 420 target, so
 * retrieval handed the model five shredded fragments (~425 tokens of context)
 * instead of five coherent ones (~2,000). Answers were correspondingly thin,
 * and it read like a weak model rather than a chunking bug.
 *
 * So sections accumulate until the buffer reaches the target. Each section's
 * heading is kept inline in the body, so packing several together does not
 * lose the structure the headings carried; the breadcrumb tracks the first
 * section in the buffer.
 */
export function chunkPage(page: ExtractedPage, siteName: string): Chunk[] {
  const sections = splitSections(page.markdown);

  // Page titles usually already carry the site name ("Acme | Pricing"), and
  // repeating it wastes tokens in every retrieved chunk.
  //
  // The separator MUST be whitespace-delimited: an earlier version matched a
  // bare hyphen and turned the brand "Mark-tech-eers" into "Mark | tech-eers".
  const title = page.title.replace(/\s+[|–—-]\s+/g, " | ").trim();
  const hasSiteName = title.toLowerCase().includes(siteName.toLowerCase());
  const titlePart = hasSiteName ? title : `${siteName} | ${title}`;

  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  let bufferHeading: string[] | null = null;

  const push = (content: string, heading: string[]) => {
    const trimmed = content.trim();
    if (trimmed.length < 60) return;
    const breadcrumb = [titlePart, ...heading].filter(Boolean).join(" > ");
    chunks.push({
      url: page.url,
      breadcrumb,
      content: trimmed,
      tokenCount: estimateTokens(trimmed),
      contentHash: createHash("sha256").update(`${breadcrumb}\n${trimmed}`).digest("hex"),
    });
  };

  const flush = () => {
    if (buffer.length === 0) return;
    push(buffer.join("\n"), bufferHeading ?? []);
    // Carry a tail forward so an answer spanning a boundary keeps its lead-in.
    const overlap = Math.max(1, Math.ceil(buffer.length * OVERLAP_RATIO));
    buffer = buffer.slice(-overlap);
    bufferHeading = null;
  };

  for (const section of sections) {
    if (bufferHeading === null) bufferHeading = section.heading;

    // Keep the heading inline so packed sections stay readable to the model.
    const headingLine = section.heading.length
      ? `## ${section.heading[section.heading.length - 1]}`
      : null;
    if (headingLine) buffer.push(headingLine);

    for (const line of section.body) {
      buffer.push(line);
      if (estimateTokens(buffer.join("\n")) >= TARGET_TOKENS) flush();
    }

    // Only break early if we already have a substantial chunk — this is the
    // line that used to fire on every single heading.
    if (estimateTokens(buffer.join("\n")) >= TARGET_TOKENS) flush();
  }

  // Whatever is left: emit it, unless it is a scrap smaller than MIN_TOKENS and
  // we can fold it into the previous chunk instead.
  const tail = buffer.join("\n").trim();
  if (tail.length > 0) {
    const last = chunks[chunks.length - 1];
    if (estimateTokens(tail) < MIN_TOKENS && last) {
      const merged = `${last.content}\n${tail}`;
      last.content = merged;
      last.tokenCount = estimateTokens(merged);
      last.contentHash = createHash("sha256").update(`${last.breadcrumb}\n${merged}`).digest("hex");
    } else {
      push(tail, bufferHeading ?? []);
    }
  }

  return chunks;
}
