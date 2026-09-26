/** Shared types for the crawling pipeline. */

export type HttpMethod = 'HEAD' | 'GET';

export type LinkScope = 'internal' | 'external';

/**
 * Outcome categories for link checks that never produced a usable HTTP
 * response. Successful checks store the numeric status code as a string
 * ("200", "404", ...) instead.
 */
export type NetworkOutcome =
  | 'timeout'
  | 'dns_failure'
  | 'connection_refused'
  | 'connection_reset'
  | 'tls_error'
  | 'too_many_redirects'
  | 'unknown';

/** Result of checking a single target URL. */
export interface LinkCheckResult {
  targetUrl: string;
  finalUrl: string | null;
  httpStatus: number | null;
  /** Numeric HTTP status as a string ("200", "404", ...) or a NetworkOutcome. */
  outcome: string;
  redirectHops: number;
  methodUsed: HttpMethod | null;
}

/** A hyperlink discovered inside an isolated article body. */
export interface ExtractedLink {
  targetUrl: string;
  anchorText: string;
  scope: LinkScope;
}

/** Result of fetching a seed page. */
export interface PageFetchResult {
  /** URL after following redirects (equals the seed URL when none). */
  finalUrl: string;
  httpStatus: number | null;
  /** Page HTML, or null when the fetch failed or the content was not HTML. */
  html: string | null;
  /** Outcome category or message when the fetch failed, otherwise null. */
  error: string | null;
}