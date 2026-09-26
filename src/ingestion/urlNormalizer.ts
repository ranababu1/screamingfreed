/**
 * URL normalization and deduplication helpers shared by seed ingestion and
 * hyperlink extraction.
 *
 * Normalization rules:
 * - trim whitespace
 * - strip the fragment (`#...`)
 * - lowercase scheme and host (done natively by the WHATWG URL parser)
 * - remove default ports (80 for http, 443 for https)
 * - resolve relative URLs against `base` when provided
 */

/**
 * Normalize a URL. Returns the normalized absolute URL, or null when the
 * input is empty, unparseable, relative without a base, or not http(s).
 */
export function normalizeUrl(input: string, base?: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let url: URL;
  try {
    url = base === undefined ? new URL(trimmed) : new URL(trimmed, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  // The WHATWG URL parser already lowercases scheme and host and drops
  // default ports, so only the fragment needs an explicit fix-up.
  url.hash = '';
  return url.href;
}

/** Deduplicate a list of URLs, preserving first-seen order. */
export function dedupePreservingOrder(urls: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    if (!seen.has(url)) {
      seen.add(url);
      result.push(url);
    }
  }
  return result;
}