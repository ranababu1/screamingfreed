/**
 * In-memory batch audit engine for environments without a writable
 * filesystem or a long-lived process (e.g. Vercel serverless functions).
 *
 * Reuses the same ingestion, extraction and crawling modules as the CLI,
 * but collects results in memory instead of SQLite and honors a soft
 * wall-clock deadline: once the budget runs out no new work is scheduled,
 * in-flight requests settle, and the caller is told which seeds were
 * processed, partially processed or never started so it can retry.
 */

import pLimit from 'p-limit';
import { isolateContent } from '../extraction/contentIsolator.js';
import { extractLinks } from '../extraction/linkExtractor.js';
import { LinkChecker } from '../crawling/linkChecker.js';
import { TokenBucketRateLimiter } from '../crawling/tokenBucket.js';
import { normalizeUrl } from '../ingestion/urlNormalizer.js';
import type {
  ExtractedLink,
  LinkCheckResult,
  LinkScope,
} from '../crawling/types.js';
import type { Dispatcher } from 'undici';

export interface BatchAuditOptions {
  /** Raw seed URLs for this batch (normalized and deduplicated here). */
  seedUrls: string[];
  /** Targets already checked in earlier batches; they are skipped. */
  skipTargets?: string[];
  requestsPerSecond: number;
  concurrency: number;
  timeoutSeconds: number;
  scopeFilter?: LinkScope;
  /** Soft wall-clock budget (ms) for scheduling new work. */
  deadlineMs: number;
  /** Shared dispatcher override (tests inject a MockAgent here). */
  dispatcher?: Dispatcher;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface AuditedPage {
  url: string;
  httpStatus: number | null;
  selectorUsed: string | null;
  fetchedAt: string;
}

export interface AuditedLink {
  pageUrl: string;
  targetUrl: string;
  finalUrl: string | null;
  anchorText: string;
  scope: LinkScope;
  httpStatus: number | null;
  outcome: string;
  redirectHops: number;
  methodUsed: string | null;
  checkedAt: string;
}

export interface OutcomeCount {
  outcome: string;
  count: number;
}

export interface BrokenLink {
  targetUrl: string;
  httpStatus: number | null;
  outcome: string;
  occurrences: number;
  examplePage: string;
}

export interface BatchAuditSummary {
  totalPages: number;
  totalLinks: number;
  outcomeCounts: OutcomeCount[];
  brokenLinks: BrokenLink[];
}

export interface BatchAuditResult {
  pages: AuditedPage[];
  links: AuditedLink[];
  /** Seeds whose page was fetched. */
  processedSeeds: string[];
  /** Seeds whose page was fetched but whose links were only partly checked. */
  partialSeeds: string[];
  /** Seeds never fetched because the deadline ran out. */
  unprocessedSeeds: string[];
  /** Input entries that were not valid absolute http(s) URLs. */
  invalidSeeds: string[];
  summary: BatchAuditSummary;
}

export async function runAuditBatch(
  options: BatchAuditOptions,
): Promise<BatchAuditResult> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const timeLeft = (): number => options.deadlineMs - (now() - startedAt);

  // --- Normalize and deduplicate seeds ------------------------------------
  const seeds: string[] = [];
  const seenSeeds = new Set<string>();
  const invalidSeeds: string[] = [];
  for (const raw of options.seedUrls) {
    const normalized = normalizeUrl(raw);
    if (normalized === null) {
      if (raw.trim().length > 0) {
        invalidSeeds.push(raw);
      }
      continue;
    }
    if (!seenSeeds.has(normalized)) {
      seenSeeds.add(normalized);
      seeds.push(normalized);
    }
  }

  const skipTargets = new Set(options.skipTargets ?? []);
  const limiter = new TokenBucketRateLimiter(options.requestsPerSecond);
  const checker = new LinkChecker({
    limiter,
    timeoutMs: options.timeoutSeconds * 1000,
    dispatcher: options.dispatcher,
  });
  const limit = pLimit(options.concurrency);

  const linksPerPage = new Map<string, ExtractedLink[]>();
  const auditedPages: AuditedPage[] = [];
  const processedSeeds: string[] = [];
  const unprocessedSeeds: string[] = [];

  try {
    // --- Phase 1: fetch seed pages and extract article-body links ---------
    await Promise.all(
      seeds.map((seed) =>
        limit(async () => {
          if (timeLeft() <= 0) {
            unprocessedSeeds.push(seed);
            return;
          }
          const page = await checker.fetchPage(seed);
          let selectorUsed: string | null = null;
          let links: ExtractedLink[] = [];
          if (page.html !== null) {
            const isolated = isolateContent(page.html);
            selectorUsed = isolated.selectorUsed;
            links = extractLinks(isolated.scope, page.finalUrl);
          }
          auditedPages.push({
            url: seed,
            httpStatus: page.httpStatus,
            selectorUsed,
            fetchedAt: new Date().toISOString(),
          });
          processedSeeds.push(seed);
          linksPerPage.set(seed, links);
        }),
      ),
    );

    // --- Phase 2: check every unique target once --------------------------
    interface PendingRef {
      pageUrl: string;
      anchorText: string;
      scope: LinkScope;
    }
    const pendingByTarget = new Map<string, PendingRef[]>();
    const targetsBySeed = new Map<string, string[]>();
    for (const [seed, links] of linksPerPage) {
      const seedTargets: string[] = [];
      for (const link of links) {
        if (options.scopeFilter !== undefined && link.scope !== options.scopeFilter) {
          continue;
        }
        const ref: PendingRef = {
          pageUrl: seed,
          anchorText: link.anchorText,
          scope: link.scope,
        };
        const refs = pendingByTarget.get(link.targetUrl);
        if (refs === undefined) {
          pendingByTarget.set(link.targetUrl, [ref]);
        } else {
          refs.push(ref);
        }
        if (!seedTargets.includes(link.targetUrl)) {
          seedTargets.push(link.targetUrl);
        }
      }
      targetsBySeed.set(seed, seedTargets);
    }

    const results = new Map<string, LinkCheckResult>();
    await Promise.all(
      [...pendingByTarget.keys()].map((targetUrl) =>
        limit(async () => {
          if (timeLeft() <= 0 || skipTargets.has(targetUrl)) {
            return;
          }
          results.set(targetUrl, await checker.checkLink(targetUrl));
        }),
      ),
    );

    const auditedLinks: AuditedLink[] = [];
    for (const [targetUrl, refs] of pendingByTarget) {
      const result = results.get(targetUrl);
      if (result === undefined) {
        continue; // deadline hit, or the client already has this target
      }
      for (const ref of refs) {
        auditedLinks.push({
          pageUrl: ref.pageUrl,
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
    }

    const partialSeeds = processedSeeds.filter((seed) => {
      const targets = targetsBySeed.get(seed) ?? [];
      return targets.some(
        (target) => !results.has(target) && !skipTargets.has(target),
      );
    });

    return {
      pages: auditedPages,
      links: auditedLinks,
      processedSeeds,
      partialSeeds,
      unprocessedSeeds,
      invalidSeeds,
      summary: buildSummary(auditedPages, auditedLinks),
    };
  } finally {
    await checker.dispose();
  }
}

function buildSummary(
  pages: AuditedPage[],
  links: AuditedLink[],
): BatchAuditSummary {
  const counts = new Map<string, number>();
  for (const link of links) {
    counts.set(link.outcome, (counts.get(link.outcome) ?? 0) + 1);
  }
  const outcomeCounts = [...counts.entries()]
    .map(([outcome, count]) => ({ outcome, count }))
    .sort((a, b) => b.count - a.count || a.outcome.localeCompare(b.outcome));

  const broken = new Map<string, BrokenLink>();
  for (const link of links) {
    if (link.httpStatus !== null && link.httpStatus < 400) {
      continue;
    }
    const existing = broken.get(link.targetUrl);
    if (existing === undefined) {
      broken.set(link.targetUrl, {
        targetUrl: link.targetUrl,
        httpStatus: link.httpStatus,
        outcome: link.outcome,
        occurrences: 1,
        examplePage: link.pageUrl,
      });
    } else {
      existing.occurrences += 1;
      if (link.pageUrl < existing.examplePage) {
        existing.examplePage = link.pageUrl;
      }
    }
  }
  const brokenLinks = [...broken.values()]
    .sort(
      (a, b) => b.occurrences - a.occurrences || a.targetUrl.localeCompare(b.targetUrl),
    )
    .slice(0, 20);

  return {
    totalPages: pages.length,
    totalLinks: links.length,
    outcomeCounts,
    brokenLinks,
  };
}