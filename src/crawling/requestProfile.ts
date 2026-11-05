/**
 * Request identity: which User-Agent and headers outgoing requests carry.
 *
 * Cloudflare and most WAFs / security plugins (Akamai, Sucuri, Wordfence,
 * Imperva...) block or challenge requests that do not look like a browser:
 * a bot-style User-Agent, missing `Accept`/`Accept-Language` headers, or no
 * `Sec-Fetch-*` metadata. By default ScreamingFreed therefore sends the same
 * header set a current desktop Chrome sends for a top-level navigation,
 * like Screaming Frog's "Chrome" user-agent preset. The old identifying bot
 * UA remains available as the `bot` preset.
 */

export const BOT_USER_AGENT = 'ScreamingFreed/1.0 (+https://example.com/bot)';

export const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const CHROME_MAJOR = '141';

/** Named User-Agent presets accepted by `--user-agent` / SCREAMINGFREED_USER_AGENT. */
export const USER_AGENT_PRESETS: Readonly<Record<string, string>> = {
  chrome: CHROME_USER_AGENT,
  bot: BOT_USER_AGENT,
};

export interface RequestProfileOptions {
  /** A preset name (`chrome`, `bot`) or a literal User-Agent string. */
  userAgent?: string;
  /** Extra headers added to every request (override the defaults). */
  extraHeaders?: Record<string, string>;
}

export class RequestProfile {
  readonly userAgent: string;
  private readonly browserLike: boolean;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: RequestProfileOptions = {}) {
    this.userAgent = resolveUserAgent(options.userAgent);
    this.browserLike = /Mozilla\/5\.0/.test(this.userAgent);
    this.extraHeaders = {};
    for (const [name, value] of Object.entries(options.extraHeaders ?? {})) {
      this.extraHeaders[name.toLowerCase()] = value;
    }
  }

  /**
   * Build the header set for one request. `cookie` (from the per-host
   * cookie jar) is merged with any user-supplied Cookie header.
   */
  headersFor(cookie?: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,' +
        'image/avif,image/webp,image/apng,*/*;q=0.8',
    };
    headers['accept-language'] = 'en-US,en;q=0.9';
    if (this.browserLike) {
      headers['cache-control'] = 'no-cache';
      headers.pragma = 'no-cache';
      if (/Chrome\//.test(this.userAgent)) {
        headers['sec-ch-ua'] =
          `"Google Chrome";v="${CHROME_MAJOR}", "Not?A_Brand";v="8", ` +
          `"Chromium";v="${CHROME_MAJOR}"`;
        headers['sec-ch-ua-mobile'] = '?0';
        headers['sec-ch-ua-platform'] = '"Windows"';
      }
      // Top-level navigation metadata, as for a URL typed in the address bar.
      headers['sec-fetch-dest'] = 'document';
      headers['sec-fetch-mode'] = 'navigate';
      headers['sec-fetch-site'] = 'none';
      headers['sec-fetch-user'] = '?1';
      headers['upgrade-insecure-requests'] = '1';
    }
    Object.assign(headers, this.extraHeaders);
    if (cookie !== undefined && cookie !== null && cookie.length > 0) {
      headers.cookie =
        headers.cookie !== undefined && headers.cookie.length > 0
          ? `${headers.cookie}; ${cookie}`
          : cookie;
    }
    return headers;
  }
}

/** Map a preset name to its UA string; any other non-empty value is used verbatim. */
export function resolveUserAgent(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    return CHROME_USER_AGENT;
  }
  const preset = USER_AGENT_PRESETS[value.trim().toLowerCase()];
  return preset ?? value.trim();
}

/**
 * Parse `Name: value` header lines (as given to `--header`, or newline
 * separated in an environment variable). A JSON object is accepted too.
 * Throws on malformed entries so typos do not silently drop a header.
 */
export function parseHeaderLines(input: string | string[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (input === undefined) {
    return headers;
  }
  if (typeof input === 'string' && input.trim().startsWith('{')) {
    const parsed = JSON.parse(input) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Header JSON must be an object of name/value strings');
    }
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new Error(`Header "${name}" must have a string value`);
      }
      headers[name.toLowerCase()] = value;
    }
    return headers;
  }
  const lines = (Array.isArray(input) ? input : input.split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of lines) {
    const separator = line.indexOf(':');
    const name = separator > 0 ? line.slice(0, separator).trim() : '';
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      throw new Error(`Invalid header "${line}"; expected "Name: value"`);
    }
    headers[name.toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}
