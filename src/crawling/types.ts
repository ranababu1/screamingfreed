/** Shared types for the crawling pipeline. */

export type HttpMethod = 'HEAD' | 'GET';

/** How a result was obtained: a plain HTTP request or a real (headless) browser. */
export type CheckMethod = HttpMethod | 'BROWSER';

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
  | 'bot_protection'
  | 'unknown';

/** Result of checking a single target URL. */
export interface LinkCheckResult {
  targetUrl: string;
  finalUrl: string | null;
  httpStatus: number | null;
  /** Numeric HTTP status as a string ("200", "404", ...) or a NetworkOutcome. */
  outcome: string;
  redirectHops: number;
  methodUsed: CheckMethod | null;
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
  /** How the HTML was obtained (`BROWSER` after the browser fallback). */
  via?: CheckMethod;
}

/**
 * A real-browser fallback for responses blocked by bot protection
 * (implemented with Playwright in `browserFallback.ts`).
 */
export interface BrowserFallback {
  /** Load a page like a visitor would and return its rendered HTML. */
  fetchPage(url: string): Promise<PageFetchResult>;
  /** Navigate to a link target and report the final HTTP status. */
  checkLink(url: string): Promise<LinkCheckResult>;
  /**
   * Cookies the browser earned for a host (e.g. Cloudflare's
   * `cf_clearance`), as a Cookie header value, so plain HTTP requests from
   * the same IP and User-Agent can reuse the clearance.
   */
  cookiesFor(host: string): Promise<string | null>;
  close(): Promise<void>;
}