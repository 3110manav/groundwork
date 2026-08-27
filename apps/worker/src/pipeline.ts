import { sql, toVectorLiteral } from "@groundwork/db";
import { embedBatch, EMBEDDING_MODEL } from "@groundwork/embeddings";
import { discover, fetchPage, needsRendering } from "./crawl.js";
import { extract, stripBoilerplate, type ExtractedPage } from "./extract.js";
import { chunkPage } from "./chunk.js";
import { generateCorePack } from "./core-pack.js";
import { scanForInjection } from "@groundwork/guards";
import { contactToText, extractContact, mergeContacts, type ContactInfo } from "./contact.js";
import { extractStructured, structuredToText, type StructuredData } from "./structured.js";

/**
 * Embeddings are cached by chunk content hash, so a recrawl of a mostly
 * unchanged site costs almost nothing — only genuinely new text is embedded.
 */
async function embedUncached(
  siteId: string,
  chunks: { contentHash: string; content: string }[],
): Promise<Map<string, number[]>> {
  const hashes = chunks.map((c) => c.contentHash);
  const existing = await sql<{ content_hash: string; embedding: string }[]>`
    SELECT content_hash, embedding::text AS embedding
    FROM chunks
    WHERE site_id = ${siteId} AND content_hash = ANY(${hashes}) AND embedding IS NOT NULL
  `;

  const cache = new Map<string, number[]>();
  for (const row of existing) {
    cache.set(row.content_hash, JSON.parse(row.embedding) as number[]);
  }

  const todo = chunks.filter((c) => !cache.has(c.contentHash));
  const BATCH = 100;
  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    const vectors = await embedBatch(slice.map((c) => c.content));
    vectors.forEach((v, j) => {
      const chunk = slice[j];
      if (chunk) cache.set(chunk.contentHash, v);
    });
  }

  return cache;
}

export async function runCrawl(
  siteId: string,
  origin: string,
  siteName: string,
  maxPages = 200,
): Promise<void> {
  const jobRows = await sql<{ id: string }[]>`
    INSERT INTO crawl_jobs (site_id, status, started_at)
    VALUES (${siteId}, 'running', now()) RETURNING id
  `;
  const jobId = jobRows[0]!.id;

  try {
    const urls = await discover(origin, maxPages);
    await sql`UPDATE crawl_jobs SET pages_found = ${urls.length} WHERE id = ${jobId}`;

    // Fetch with a small concurrency window — be a good citizen on someone
    // else's server; we are not in a hurry, this is an async job.
    const extracted: ExtractedPage[] = [];
    const contacts: (ContactInfo | null)[] = [];
    const structured: StructuredData[] = [];
    const stillShell: string[] = [];
    let renderedCount = 0;
    // Rendering is far heavier than fetching, so keep the window small.
    const CONCURRENCY = 3;
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      const batch = await Promise.all(
        urls.slice(i, i + CONCURRENCY).map(async (url) => {
          const page = await fetchPage(url);
          if (!page) return null;
          if (page.rendered) renderedCount++;
          else if (needsRendering(page.html)) stillShell.push(url);
          // Pull contact details from the FULL DOM before Readability discards
          // the header/footer/contact strip they live in.
          contacts.push(extractContact(page.html, page.url));
          structured.push(extractStructured(page.html, page.url));
          return extract(page.url, page.html);
        }),
      );
      extracted.push(...batch.filter((p): p is ExtractedPage => p !== null));
    }
    if (renderedCount > 0) console.log(`  rendered ${renderedCount} JS-dependent page(s)`);
    if (stillShell.length > 0) {
      // Loud, not silent: a quietly thin index is the worst failure here.
      console.warn(`  WARNING: ${stillShell.length} page(s) needed JS but could not be rendered:`);
      for (const u of stillShell.slice(0, 5)) console.warn(`    ${u}`);
    }

    if (extracted.length === 0) {
      throw new Error(
        `no readable content on any of the ${urls.length} page(s) crawled. ` +
          (stillShell.length > 0
            ? "The site appears to require JavaScript and could not be rendered — check that Chrome is installed or set CHROME_PATH."
            : "The pages may be image-only, blocked, or behind a login."),
      );
    }

    const cleaned = stripBoilerplate(extracted);

    // Structured data (FAQ pairs, product/price rows, service lists) becomes
    // its own synthetic page. It is machine-authored and exact — the highest
    // quality text on the site — and chunking it separately means an FAQ answer
    // retrieves as a clean Q/A pair rather than diluted into surrounding prose.
    const mergedStructured: StructuredData = {
      faqs: [], products: [], services: [], breadcrumbs: [], organisation: {},
    };
    for (const sd of structured) {
      mergedStructured.faqs.push(...sd.faqs);
      mergedStructured.products.push(...sd.products);
      mergedStructured.services.push(...sd.services);
      Object.assign(mergedStructured.organisation, sd.organisation);
    }
    const seenFaq = new Set<string>();
    mergedStructured.faqs = mergedStructured.faqs.filter(
      (f) => !seenFaq.has(f.q.toLowerCase()) && seenFaq.add(f.q.toLowerCase()),
    );
    const seenProd = new Set<string>();
    mergedStructured.products = mergedStructured.products.filter(
      (pr) => !seenProd.has(pr.name.toLowerCase()) && seenProd.add(pr.name.toLowerCase()),
    );
    for (const block of structuredToText(mergedStructured)) {
      cleaned.push({
        url: origin,
        title: block.startsWith("## Frequently") ? "FAQ" : block.startsWith("## Products") ? "Products & pricing" : "Services",
        markdown: block,
        contentHash: `structured-${block.slice(0, 24)}-${siteId}`,
      });
    }

    // Chunk everything before embedding so the hash cache can dedupe in one pass.
    const allChunks = cleaned.flatMap((page) =>
      chunkPage(page, siteName).map((c) => ({ ...c, pageUrl: page.url, page })),
    );
    const embeddings = await embedUncached(siteId, allChunks);

    const contact = mergeContacts(contacts);
    const contactVec = contact
      ? (await embedBatch([contactToText(contact, siteName)]))[0]!
      : [];
    if (contact) {
      console.log(
        `  contact: ${contact.addresses.length} address, ${contact.phones.length} phone, ${contact.emails.length} email`,
      );
    } else {
      console.warn("  WARNING: no contact details found — 'where are you?' will not be answerable");
    }

    const flagged: string[] = [];

    await sql.begin(async (tx) => {
      // Replace the index atomically. Bumping index_version in the same
      // transaction invalidates the semantic answer cache without a delete pass.
      await tx`DELETE FROM chunks WHERE site_id = ${siteId} AND source = 'crawl'`;
      // Drop pages that are no longer reachable, otherwise URLs that were
      // renamed, removed, or (as happened here) de-duplicated by
      // canonicalisation linger forever as stale rows.
      const liveUrls = cleaned.map((pg) => pg.url);
      await tx`DELETE FROM pages WHERE site_id = ${siteId} AND url <> ALL(${liveUrls})`;

      for (const page of cleaned) {
        await tx`
          INSERT INTO pages (site_id, url, title, content_hash)
          VALUES (${siteId}, ${page.url}, ${page.title}, ${page.contentHash})
          ON CONFLICT (site_id, url) DO UPDATE
            SET title = EXCLUDED.title,
                content_hash = EXCLUDED.content_hash,
                fetched_at = now()
        `;
      }

      for (const chunk of allChunks) {
        const vec = embeddings.get(chunk.contentHash);
        if (!vec) continue;
        // Crawled text is untrusted; flag obvious injection attempts at ingest
        // so retrieval can exclude them without a per-request scan.
        const verdict = scanForInjection(chunk.content);
        if (verdict.risk) flagged.push(`${chunk.url} :: ${verdict.reason}`);
        await tx`
          INSERT INTO chunks (
            site_id, source, breadcrumb, url, content, token_count,
            content_hash, embedding, embedding_model, injection_risk, injection_reason
          ) VALUES (
            ${siteId}, 'crawl', ${chunk.breadcrumb}, ${chunk.url}, ${chunk.content},
            ${chunk.tokenCount}, ${chunk.contentHash},
            ${toVectorLiteral(vec)}::halfvec, ${EMBEDDING_MODEL},
            ${verdict.risk}, ${verdict.reason ?? null}
          )
        `;
      }

      // Contact details as their own chunk, with priority so a "where are you"
      // question reaches it ahead of ordinary marketing prose.
      if (contact) {
        const body = contactToText(contact, siteName);
        await tx`
          INSERT INTO chunks (
            site_id, source, priority, breadcrumb, url, content, token_count,
            content_hash, embedding, embedding_model
          ) VALUES (
            ${siteId}, 'crawl', 3, ${`${siteName} | Contact & location`}, ${origin},
            ${body}, ${Math.ceil(body.length / 3.8)}, ${`contact-${siteId}`},
            ${toVectorLiteral(contactVec)}::halfvec, ${EMBEDDING_MODEL}
          )
        `;
      }

      await tx`UPDATE sites SET index_version = index_version + 1 WHERE id = ${siteId}`;
    });

    if (flagged.length > 0) {
      console.warn(`  WARNING: ${flagged.length} chunk(s) flagged as possible prompt injection and excluded from retrieval:`);
      for (const f of flagged.slice(0, 5)) console.warn(`    ${f}`);
    }

    // Core pack last: it summarises the cleaned corpus, so it must run after
    // boilerplate removal or it will faithfully summarise the nav menu.
    let pack: { content: string; model: string } | null = null;
    try {
      pack = await generateCorePack(
      contact
        ? [
            ...cleaned,
            {
              url: origin,
              title: "Contact and location",
              markdown: contactToText(contact, siteName),
              contentHash: `contact-${siteId}`,
            },
          ]
        : cleaned,
        siteName,
      );
    } catch (err) {
      // The index is already committed at this point — pages fetched, chunks
      // embedded, all the paid work done. The core pack is an ENHANCEMENT
      // (it answers common questions without retrieval); losing it degrades
      // quality but does not break chat. Failing the whole crawl here threw
      // away a perfectly good index over one optional call, which is exactly
      // what a quota-exhausted key caused.
      console.warn(
        `  WARNING: core pack generation failed — index is still usable, answers will be slightly weaker.`,
      );
      console.warn(`    ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }

    if (pack) {
      await sql`
        INSERT INTO core_packs (site_id, content, token_count, model_used)
        VALUES (${siteId}, ${pack.content}, ${Math.ceil(pack.content.length / 3.8)}, ${pack.model})
        ON CONFLICT (site_id) DO UPDATE
          SET content = EXCLUDED.content,
              token_count = EXCLUDED.token_count,
              model_used = EXCLUDED.model_used,
              generated_at = now()
      `;
    }

    await sql`
      UPDATE crawl_jobs
      SET status = 'succeeded', pages_indexed = ${cleaned.length}, finished_at = now()
      WHERE id = ${jobId}
    `;
    // Coverage report: every crawl states what it captured, so a thin index
    // announces itself here instead of surfacing as a bad answer later.
    const totalTokens = allChunks.reduce((n, ch) => n + ch.tokenCount, 0);
    console.log(`crawl ${siteId}: ${cleaned.length} pages -> ${allChunks.length} chunks, ${totalTokens} tokens`);
    console.log(
      `  coverage: faqs=${mergedStructured.faqs.length} products=${mergedStructured.products.length} ` +
        `services=${mergedStructured.services.length} contact=${contact ? "yes" : "NO"} ` +
        `rendered=${renderedCount} unrendered-shells=${stillShell.length}`,
    );
    if (totalTokens < 800) {
      console.warn(
        `  WARNING: only ${totalTokens} tokens indexed for the whole site — answers will be weak. ` +
          `Check the coverage line above for what is missing.`,
      );
    }
  } catch (err) {
    await sql`
      UPDATE crawl_jobs SET status = 'failed', error = ${String(err)}, finished_at = now()
      WHERE id = ${jobId}
    `;
    throw err;
  }
}
