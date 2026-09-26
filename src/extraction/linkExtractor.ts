/**
 * Hyperlink extraction and classification inside an isolated article body.
 */

import { getDomain } from 'tldts';
import type { AnyNode } from 'domhandler';
import type { Cheerio } from 'cheerio';
import { normalizeUrl } from '../ingestion/urlNormalizer.js';
import type { ExtractedLink } from '../crawling/types.js';

/** Schemes that are never crawlable hyperlinks. */
const NON_CRAWLABLE_SCHEMES = ['mailto:', 'tel:', 'javascript:', 'data:', 'sms:'] as const;

/**
 * Extract crawlable hyperlinks from `<a>` elements strictly inside `scope`.
 *
 * Non-crawlable schemes and fragment-only hrefs are discarded, hrefs are
 * normalized (resolving relative references against `pageUrl`), classified as
 * internal/external via registrable domain comparison, and deduplicated per
 * parent page preserving first-seen order.
 */
export function extractLinks(scope: Cheerio<AnyNode>, pageUrl: string): ExtractedLink[] {
  const pageUrlParsed = new URL(pageUrl);
  const pageDomain = getDomain(pageUrlParsed.hostname);
  const links: ExtractedLink[] = [];
  const seen = new Set<string>();

  const anchors = scope.find('a[href]');
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors.eq(index);
    const rawHref = (anchor.attr('href') ?? '').trim();
    if (!isCrawlableHref(rawHref)) {
      continue;
    }
    const targetUrl = normalizeUrl(rawHref, pageUrl);
    if (targetUrl === null || seen.has(targetUrl)) {
      continue;
    }
    seen.add(targetUrl);
    const target = new URL(targetUrl);
    links.push({
      targetUrl,
      anchorText: collapseWhitespace(anchor.text()),
      scope: isInternalTarget(target, pageUrlParsed, pageDomain)
        ? 'internal'
        : 'external',
    });
  }
  return links;
}

/**
 * Fragment-only hrefs (`#`, `#section`) point at the parent page itself, so
 * like empty and non-crawlable hrefs they are not audited as hyperlinks.
 */
function isCrawlableHref(href: string): boolean {
  if (href.length === 0 || href.startsWith('#')) {
    return false;
  }
  const lowercased = href.toLowerCase();
  return !NON_CRAWLABLE_SCHEMES.some((scheme) => lowercased.startsWith(scheme));
}

/**
 * A link is internal when its registrable domain (per tldts) matches the
 * page's registrable domain. Hosts without one (localhost, IPs, intranet
 * names) fall back to an exact host comparison, which is port-sensitive.
 */
function isInternalTarget(target: URL, page: URL, pageDomain: string | null): boolean {
  const targetDomain = getDomain(target.hostname);
  if (pageDomain !== null && targetDomain !== null) {
    return pageDomain === targetDomain;
  }
  return target.host === page.host;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}