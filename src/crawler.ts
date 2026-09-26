/**
 * Crawl orchestration: ingest seeds, fetch pages, isolate article bodies,
 * extract and check links, persist results and report.
 *
 * A single shared per-host rate limiter and a single shared undici Agent
 * cover both seed page fetches and link checks; global concurrency is
 * bounded with p-limit. SIGINT stops scheduling new work, lets in-flight
 * requests settle, flushes the database and prints the summary.
 */

import pLimit from 'p-limit';
import { isolateContent } from './extraction/contentIsolator.js';
import { extractLinks } from './extraction/linkExtractor.js';
import { LinkChecker } from './crawling/linkChecker.js';
import { TokenBucketRateLimiter } from './crawling/tokenBucket.js';
import type { ExtractedLink, LinkScope } from './crawling/types.js';
import { loadSeedUrls } from './ingestion/urlLoader.js';
import { normalizeUrl } from './ingestion/urlNormalizer.js';
import { ConsoleReporter } from './reporting/consoleReporter.js';
import { exportCsv } from './reporting/csvExporter.js';
import { SqliteStore } from './storage/sqliteStore.js';

export interface CrawlOptions {
  urls?: string;
  file?: string;
  dbPath: string;
  exportPath?: string;
  requestsPerSecond: number;
  concurrency: number;
  timeoutSeconds: number;
  scopeFilter?: LinkScope;
  verbose: boolean;
}

interface PageResult {
  pageId: number;
  links: ExtractedLink[];
}

interface PendingLinkRef {
  pageId: number;
  anchorText: string;
  scope: LinkScope;
}

/** Runs the full crawl. Returns a process exit code: 0 ok, 1 error, 130 interrupted. */
export async function runCrawl(options: CrawlOptions): Promise<number> {
  const reporter = new ConsoleReporter(options.verbose);

  // --- 1. Ingest and normalize seed URLs -----------------------------------
  const rawSeeds = await loadSeedUrls({ urls: options.urls, file: options.file });
  const seeds: string[] = [];
  const seenSeeds = new Set<string>();
  for (const raw of rawSeeds) {
    const normalized = normalizeUrl(raw);
    if (normalized === null) {
      reporter.warn(`Skipping invalid seed URL: ${raw}`);
      continue;
    }
    if (!seenSeeds.has(normalized)) {
      seenSeeds.add(normalized);
      seeds.push(normalized);
    }
  }
  if (seeds.length === 0) {
    reporter.error(
      'No valid seed URLs to crawl. Provide http(s) URLs via --urls, --file, or stdin.',
    );
    return 1;
  }

  // --- 2. Set up storage, HTTP machinery and UI -----------------------------
  const store = new SqliteStore(options.dbPath);
  const limiter = new TokenBucketRateLimiter(options.requestsPerSecond);
  const checker = new LinkChecker({
    limiter,
    timeoutMs: options.timeoutSeconds * 1000,
    log: (message) => reporter.verbose(message),
  });
  const limit = pLimit(options.concurrency);

  reporter.startBars(seeds.length);
  reporter.info(
    `Auditing ${seeds.length} seed page${seeds.length === 1 ? '' : 's'}...`,
  );

  // --- 3. Graceful shutdown handling -----------------------------------------
  let interrupted = false;
  const onSigint = (): void => {
    if (interrupted) {
      reporter.warn('Forced exit.');
      process.exit(130);
    }
    interrupted = true;
    checker.stop();
    reporter.warn(
      'SIGINT received — finishing in-flight work, then shutting down (Ctrl+C again to force).',
    );
  };
  process.on('SIGINT', onSigint);

  try {
    // --- 4. Phase 1: fetch seed pages and extract article-body links ---------
    const pages = new Map<string, PageResult>();
    await Promise.all(
      seeds.map((seed) =>
        limit(async () => {
          if (checker.isStopped) {
            return;
          }
          const page = await checker.fetchPage(seed);
          let selectorUsed: string | null = null;
          let links: ExtractedLink[] = [];
          if (page.html !== null) {
            const isolated = isolateContent(page.html);
            selectorUsed = isolated.selectorUsed;
            links = extractLinks(isolated.scope, page.finalUrl);
          } else if (page.error !== null) {
            reporter.verbose(`Failed to fetch ${seed}: ${page.error}`);
          }
          const pageId = store.recordPage({
            url: seed,
            httpStatus: page.httpStatus,
            selectorUsed,
            fetchedAt: new Date().toISOString(),
          });
          reporter.pageDone();
          reporter.verbose(
            `[${seed}] selector=${selectorUsed ?? 'n/a'} links=${links.length}`,
          );
          pages.set(seed, { pageId, links });
        }),
      ),
    );

    // --- 5. Phase 2: check every unique target once --------------------------
    const pendingByTarget = new Map<string, PendingLinkRef[]>();
    for (const page of pages.values()) {
      for (const link of page.links) {
        if (options.scopeFilter !== undefined && link.scope !== options.scopeFilter) {
          continue;
        }
        const ref: PendingLinkRef = {
          pageId: page.pageId,
          anchorText: link.anchorText,
          scope: link.scope,
        };
        const refs = pendingByTarget.get(link.targetUrl);
        if (refs === undefined) {
          pendingByTarget.set(link.targetUrl, [ref]);
        } else {
          refs.push(ref);
        }
      }
    }
    reporter.setLinkTotal(pendingByTarget.size);

    await Promise.all(
      [...pendingByTarget.keys()].map((targetUrl) =>
        limit(async () => {
          if (checker.isStopped) {
            return;
          }
          const result = await checker.checkLink(targetUrl);
          reporter.linkChecked(result);
          for (const ref of pendingByTarget.get(targetUrl) ?? []) {
            store.recordLink({
              pageId: ref.pageId,
              targetUrl: result.targetUrl,
              finalUrl: result.finalUrl,
              anchorText: ref.anchorText,
              scope: ref.scope,
              httpStatus: result.httpStatus,
              outcome: result.outcome,
              redirectHops: result.redirectHops,
              methodUsed: result.methodUsed,
              checkedAt: new Date().toISOString(),
            });
          }
        }),
      ),
    );
  } catch (error) {
    // Flush and close the store so everything checked so far stays
    // queryable, then surface the failure.
    store.close();
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
    reporter.stopBars();
    // Always release pooled sockets so the process can exit naturally.
    await checker.dispose();
  }

  // --- 6. Persist, summarize, export ------------------------------------------
  // Flush any buffered link rows so the summary and CSV reflect everything
  // checked so far (the interval/timer flush may not have fired yet).
  store.flush();
  reporter.printSummary({
    totalPages: store.countPages(),
    totalLinks: store.countLinks(),
    outcomeCounts: store.getOutcomeCounts(),
    brokenLinks: store.getBrokenLinks(20),
  });
  if (options.exportPath !== undefined) {
    const exported = exportCsv(store.getAllLinkRows(), options.exportPath);
    reporter.info(
      `Exported ${exported} link row${exported === 1 ? '' : 's'} to ${options.exportPath}`,
    );
  }
  store.close();
  return interrupted ? 130 : 0;
}