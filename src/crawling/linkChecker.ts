/**
 * Asynchronous link checking.
 *
 * - HEAD first; on 405/501, or when the socket closes without a response,
 *   retry once with GET.
 * - Redirects are followed manually (up to 5 hops) recording the final
 *   status and URL; exceeding the hop budget yields `too_many_redirects`.
 * - On 429, `Retry-After` is honored (capped at 60s) and the check is
 *   retried once; without the header a 5 second backoff is used.
 * - Every request (including redirect hops) goes through the shared
 *   per-host token bucket limiter and a per-request abort timeout.
 */

import { Agent, request } from 'undici';
import type { Dispatcher } from 'undici';
import { TokenBucketRateLimiter } from './tokenBucket.js';
import type {
  HttpMethod,
  LinkCheckResult,
  NetworkOutcome,
  PageFetchResult,
} from './types.js';

export const USER_AGENT = 'ScreamingFreed/1.0 (+https://example.com/bot)';

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;
const DEFAULT_429_BACKOFF_MS = 5_000;
/** Cap Retry-After delays so a hostile header cannot stall the whole crawl. */
const MAX_RETRY_AFTER_MS = 60_000;
const TLS_CODE_PATTERN = /^(ERR_TLS|ERR_SSL)/;
const TLS_CODE_FRAGMENTS = ['CERT', 'SIGNATURE', 'EPROTO'];
const SOCKET_CLOSE_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']);

export interface LinkCheckerOptions {
  /** Shared per-host rate limiter (also used for seed page fetches). */
  limiter?: TokenBucketRateLimiter;
  /** Rate used for an internal limiter when `limiter` is not provided. */
  requestsPerSecond?: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Shared undici dispatcher. Defaults to a pooled Agent, redirects off. */
  dispatcher?: Dispatcher;
  /** Optional verbose logger. */
  log?: (message: string) => void;
}

interface ResponseData {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  bodyText: string | null;
}

type ChainResult =
  | {
      kind: 'response';
      status: number;
      finalUrl: string;
      hops: number;
      method: HttpMethod;
      bodyText: string | null;
      contentType: string | null;
      retryAfterMs: number | null;
    }
  | { kind: 'error'; error: unknown; hops: number; method: HttpMethod }
  | { kind: 'too_many_redirects'; hops: number; method: HttpMethod };

export class LinkChecker {
  private readonly limiter: TokenBucketRateLimiter;
  private readonly dispatcher: Dispatcher;
  private readonly ownsDispatcher: boolean;
  private readonly timeoutMs: number;
  private readonly log: (message: string) => void;
  private stopped = false;
  private disposed = false;
  private readonly shutdownWaiters: Array<() => void> = [];

  constructor(options: LinkCheckerOptions) {
    this.timeoutMs = options.timeoutMs;
    this.log = options.log ?? ((): void => {});
    this.limiter =
      options.limiter ?? new TokenBucketRateLimiter(options.requestsPerSecond ?? 2);
    if (options.dispatcher !== undefined) {
      this.dispatcher = options.dispatcher;
      this.ownsDispatcher = false;
    } else {
      // Pooled shared agent. Automatic redirect following stays disabled
      // (undici never follows redirects unless an interceptor is installed),
      // keeping redirect chains visible for manual traversal.
      this.dispatcher = new Agent();
      this.ownsDispatcher = true;
    }
  }

  /** Request a graceful stop: interrupt backoff waits so in-flight checks finish fast. */
  stop(): void {
    this.stopped = true;
    for (const resolve of this.shutdownWaiters) {
      resolve();
    }
    this.shutdownWaiters.length = 0;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Release the underlying dispatcher when this instance owns it. Idempotent. */
  async dispose(): Promise<void> {
    if (this.ownsDispatcher && !this.disposed) {
      this.disposed = true;
      await this.dispatcher.close();
    }
  }

  /** Check a single target URL with the full HEAD/GET and retry logic. */
  async checkLink(targetUrl: string): Promise<LinkCheckResult> {
    let method: HttpMethod = 'HEAD';
    let result = await this.followChain(targetUrl, method, false);
    if (result.kind === 'error' && isSocketCloseError(result.error)) {
      this.log(`Socket closed without a response for ${targetUrl}; retrying with GET`);
      method = 'GET';
      result = await this.followChain(targetUrl, method, false);
    } else if (
      result.kind === 'response' &&
      (result.status === 405 || result.status === 501)
    ) {
      this.log(`HEAD not allowed (${result.status}) for ${targetUrl}; retrying with GET`);
      method = 'GET';
      result = await this.followChain(targetUrl, method, false);
    }
    if (result.kind === 'response' && result.status === 429) {
      const waitMs = result.retryAfterMs ?? DEFAULT_429_BACKOFF_MS;
      this.log(`429 for ${targetUrl}; waiting ${waitMs} ms before one retry`);
      await this.waitOrAbort(waitMs);
      if (!this.stopped) {
        result = await this.followChain(targetUrl, method, false);
      }
    }
    return this.toLinkCheckResult(targetUrl, result);
  }

  /** GET a seed page (following redirects), returning its HTML when available. */
  async fetchPage(url: string): Promise<PageFetchResult> {
    const result = await this.followChain(url, 'GET', true);
    if (result.kind === 'response') {
      const contentType = result.contentType ?? '';
      if (result.bodyText !== null && !contentType.toLowerCase().includes('html')) {
        this.log(`Skipping non-HTML content at ${url} (content-type: ${contentType || 'unknown'})`);
        return {
          finalUrl: result.finalUrl,
          httpStatus: result.status,
          html: null,
          error: null,
        };
      }
      return {
        finalUrl: result.finalUrl,
        httpStatus: result.status,
        html: result.bodyText,
        error: null,
      };
    }
    if (result.kind === 'too_many_redirects') {
      return { finalUrl: url, httpStatus: null, html: null, error: 'too_many_redirects' };
    }
    return {
      finalUrl: url,
      httpStatus: null,
      html: null,
      error: categorizeError(result.error),
    };
  }

  /** Follow redirects manually, at most MAX_REDIRECT_HOPS hops. */
  private async followChain(
    startUrl: string,
    initialMethod: HttpMethod,
    collectBody: boolean,
  ): Promise<ChainResult> {
    let currentUrl = startUrl;
    let method = initialMethod;
    let hops = 0;
    for (;;) {
      let response: ResponseData;
      try {
        response = await this.requestOnce(currentUrl, method, collectBody);
      } catch (error) {
        return { kind: 'error', error, hops, method };
      }
      const { statusCode, headers } = response;
      const location = headerString(headers.location);
      if (REDIRECT_STATUSES.has(statusCode) && location !== null && location.length > 0) {
        if (hops >= MAX_REDIRECT_HOPS) {
          this.log(`Too many redirects for ${startUrl} (>${MAX_REDIRECT_HOPS} hops)`);
          return { kind: 'too_many_redirects', hops, method };
        }
        let next: URL;
        try {
          next = new URL(location, currentUrl);
        } catch {
          return {
            kind: 'error',
            error: new Error(`Invalid redirect target "${location}"`),
            hops,
            method,
          };
        }
        if (statusCode === 303 && method === 'HEAD') {
          method = 'GET';
        }
        currentUrl = next.href;
        hops += 1;
        continue;
      }
      // Final response (also when a redirect status lacks a Location header).
      const contentType = headerString(headers['content-type']);
      const retryAfterMs =
        statusCode === 429 ? parseRetryAfter(headers['retry-after']) : null;
      return {
        kind: 'response',
        status: statusCode,
        finalUrl: currentUrl,
        hops,
        method,
        bodyText: response.bodyText,
        contentType,
        retryAfterMs,
      };
    }
  }

  private async requestOnce(
    url: string,
    method: HttpMethod,
    collectBody: boolean,
  ): Promise<ResponseData> {
    await this.limiter.acquire(new URL(url).host);
    const response = await request(url, {
      method,
      dispatcher: this.dispatcher,
      headers: { 'user-agent': USER_AGENT },
      // Per-request timeout; undici does not follow redirects by default,
      // which keeps every hop of a redirect chain visible.
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let bodyText: string | null = null;
    if (collectBody) {
      bodyText = await response.body.text();
    } else {
      // Drain the body so the pooled socket can be reused.
      await response.body.dump();
    }
    return { statusCode: response.statusCode, headers: response.headers, bodyText };
  }

  private toLinkCheckResult(targetUrl: string, result: ChainResult): LinkCheckResult {
    if (result.kind === 'response') {
      return {
        targetUrl,
        finalUrl: result.finalUrl,
        httpStatus: result.status,
        outcome: String(result.status),
        redirectHops: result.hops,
        methodUsed: result.method,
      };
    }
    if (result.kind === 'too_many_redirects') {
      return {
        targetUrl,
        finalUrl: null,
        httpStatus: null,
        outcome: 'too_many_redirects',
        redirectHops: result.hops,
        methodUsed: result.method,
      };
    }
    return {
      targetUrl,
      finalUrl: null,
      httpStatus: null,
      outcome: categorizeError(result.error),
      redirectHops: result.hops,
      methodUsed: result.method,
    };
  }

  /** Wait for `ms`, or resolve early when a graceful stop was requested. */
  private async waitOrAbort(ms: number): Promise<void> {
    if (ms <= 0 || this.stopped) {
      return;
    }
    await Promise.race([
      sleep(ms),
      new Promise<void>((resolve) => {
        this.shutdownWaiters.push(resolve);
      }),
    ]);
  }
}

/** Map a single HTTP header value to a string, or null when absent. */
function headerString(value: string | string[] | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * Parse a `Retry-After` header (delay-seconds or HTTP-date) into
 * milliseconds. Returns null when the header is absent or unparseable.
 * Values are clamped to [0, MAX_RETRY_AFTER_MS].
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  nowMs: number = Date.now(),
): number | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || raw.length === 0) {
    return null;
  }
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    return clampMs(Number.parseInt(value, 10) * 1000);
  }
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) {
    return null;
  }
  return clampMs(dateMs - nowMs);
}

function clampMs(ms: number): number {
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/**
 * Walk an error and its `cause` chain and classify it into an outcome
 * category. Undici/Node wrap network errors in layers, so every node of
 * the chain contributes its `code` and `name`.
 */
export function categorizeError(error: unknown): NetworkOutcome {
  const names: string[] = [];
  const codes: string[] = [];
  for (const node of errorChain(error)) {
    if (typeof node === 'object' && node !== null) {
      const name = (node as { name?: unknown }).name;
      const code = (node as { code?: unknown }).code;
      if (typeof name === 'string') {
        names.push(name);
      }
      if (typeof code === 'string') {
        codes.push(code);
      }
    }
  }
  // Requests are only ever aborted by the per-request timeout signal.
  if (
    names.includes('TimeoutError') ||
    names.includes('AbortError') ||
    codes.includes('ABORT_ERR') ||
    codes.includes('UND_ERR_ABORT') ||
    codes.includes('UND_ERR_ABORT_TIMEOUT') ||
    codes.includes('UND_ERR_HEADERS_TIMEOUT') ||
    codes.includes('UND_ERR_BODY_TIMEOUT')
  ) {
    return 'timeout';
  }
  if (codes.includes('ENOTFOUND') || codes.includes('EAI_AGAIN')) {
    return 'dns_failure';
  }
  if (codes.includes('ECONNREFUSED')) {
    return 'connection_refused';
  }
  if (codes.includes('ECONNRESET') || codes.includes('EPIPE') || codes.includes('UND_ERR_SOCKET')) {
    return 'connection_reset';
  }
  if (
    codes.some(
      (code) =>
        TLS_CODE_PATTERN.test(code) ||
        TLS_CODE_FRAGMENTS.some((fragment) => code.includes(fragment)),
    )
  ) {
    return 'tls_error';
  }
  return 'unknown';
}

/** True when the error looks like the socket closed before a response arrived. */
export function isSocketCloseError(error: unknown): boolean {
  return errorChain(error).some((node) => {
    const code = (node as { code?: unknown }).code;
    return typeof code === 'string' && SOCKET_CLOSE_CODES.has(code);
  });
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && chain.length < 10) {
    if (chain.includes(current)) {
      break;
    }
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}