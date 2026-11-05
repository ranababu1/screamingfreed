/**
 * Seed URL discovery from XML sitemaps.
 *
 * Accepts a sitemap URL (`.xml`, `.xml.gz`, or a plain-text sitemap) or just
 * a site address. For a site address the sitemap is discovered from
 * `robots.txt` (`Sitemap:` lines), then from the conventional locations
 * (`/sitemap.xml`, `/sitemap_index.xml`, `/wp-sitemap.xml`, ...).
 *
 * Sitemap index files are followed recursively (breadth first, bounded by
 * `maxSitemaps`), and page URLs are collected up to `maxUrls`. Requests use
 * the same browser-like request profile, optional proxy and bot-protection
 * detection as the crawler, so a Cloudflare challenge is reported as such.
 */

import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { Agent, ProxyAgent, fetch } from 'undici';
import type { Dispatcher } from 'undici';
import { isBotChallenge } from '../crawling/botProtection.js';
import { RequestProfile } from '../crawling/requestProfile.js';
import { normalizeUrl } from './urlNormalizer.js';

/** Conventional sitemap locations tried when only a site address is given. */
export const SITEMAP_CANDIDATE_PATHS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/wp-sitemap.xml',
  '/sitemap.txt',
] as const;

export interface SitemapLoadOptions {
  /** User-Agent preset or literal string (default: chrome). */
  userAgent?: string;
  /** Extra headers for every request. */
  headers?: Record<string, string>;
  /** HTTP(S) proxy URL. */
  proxyUrl?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Stop following nested sitemaps after this many have been fetched. */
  maxSitemaps?: number;
  /** Stop collecting page URLs after this many. */
  maxUrls?: number;
  /** Overall wall-clock budget in milliseconds. */
  deadlineMs?: number;
  /** Dispatcher override (tests inject a MockAgent). */
  dispatcher?: Dispatcher;
  log?: (message: string) => void;
}

export interface SitemapFetchInfo {
  url: string;
  httpStatus: number | null;
  /** `urlset` (pages), `index` (nested sitemaps), `text`, or null on failure. */
  kind: 'urlset' | 'index' | 'text' | null;
  /** Page URLs (urlset/text) or child sitemaps (index) found in this file. */
  entries: number;
  error: string | null;
}

export interface SitemapLoadResult {
  /** Deduplicated, normalized page URLs in sitemap order. */
  urls: string[];
  sitemaps: SitemapFetchInfo[];
  /** True when a limit (URLs, sitemaps or time) cut the discovery short. */
  truncated: boolean;
}

interface FetchedDocument {
  url: string;
  status: number;
  body: string;
}

export class SitemapError extends Error {}

export async function loadSitemap(
  input: string,
  options: SitemapLoadOptions = {},
): Promise<SitemapLoadResult> {
  const startUrl = toAbsoluteUrl(input);
  if (startUrl === null) {
    throw new SitemapError(`"${input}" is not a valid http(s) URL or domain`);
  }
  const maxSitemaps = options.maxSitemaps ?? 200;
  const maxUrls = options.maxUrls ?? 50_000;
  const deadline = Date.now() + (options.deadlineMs ?? 45_000);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const log = options.log ?? ((): void => {});
  const profile = new RequestProfile({
    userAgent: options.userAgent,
    extraHeaders: options.headers,
  });
  let ownedDispatcher: Dispatcher | null = null;
  let dispatcher = options.dispatcher;
  if (dispatcher === undefined) {
    ownedDispatcher =
      options.proxyUrl !== undefined && options.proxyUrl.length > 0
        ? new ProxyAgent(options.proxyUrl)
        : new Agent();
    dispatcher = ownedDispatcher;
  }

  // Cache per run: discovery may probe a file the crawl then reads again.
  const cache = new Map<string, Promise<FetchedDocument>>();
  const get = (url: string): Promise<FetchedDocument> => {
    let pending = cache.get(url);
    if (pending === undefined) {
      pending = getUncached(url);
      cache.set(url, pending);
    }
    return pending;
  };
  const getUncached = async (url: string): Promise<FetchedDocument> => {
    const response = await fetch(url, {
      dispatcher,
      headers: profile.headersFor(),
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    // `.xml.gz` files arrive as gzip payloads (not Content-Encoding).
    const isGzip = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    const body = (isGzip ? gunzipSync(buffer) : buffer).toString('utf8');
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    if (isBotChallenge(response.status, headers, body)) {
      throw new SitemapError(`blocked by bot protection (HTTP ${response.status})`);
    }
    return { url: response.url || url, status: response.status, body };
  };

  try {
    let roots = looksLikeSitemap(startUrl)
      ? [startUrl]
      : await discoverSitemaps(startUrl, get, log);
    // A bare domain was assumed to be https; some sites only serve http.
    const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim());
    if (roots.length === 0 && !hadScheme) {
      roots = await discoverSitemaps(startUrl.replace(/^https:/, 'http:'), get, log);
    }
    if (roots.length === 0) {
      throw new SitemapError(
        `No sitemap found for ${new URL(startUrl).origin} (checked robots.txt and ` +
          `${SITEMAP_CANDIDATE_PATHS.join(', ')}). Enter the sitemap URL directly.`,
      );
    }

    const urls: string[] = [];
    const seenUrls = new Set<string>();
    const seenSitemaps = new Set<string>(roots);
    const sitemaps: SitemapFetchInfo[] = [];
    let queue = [...roots];
    let truncated = false;
    const limit = pLimit(4);

    while (queue.length > 0) {
      if (Date.now() >= deadline || sitemaps.length >= maxSitemaps || urls.length >= maxUrls) {
        truncated = true;
        break;
      }
      const batch = queue.splice(0, Math.min(queue.length, maxSitemaps - sitemaps.length));
      const next: string[] = [];
      const results = await Promise.all(
        batch.map((sitemapUrl) => limit(() => fetchOne(sitemapUrl, get))),
      );
      for (const { info, pages, children } of results) {
        sitemaps.push(info);
        for (const child of children) {
          if (!seenSitemaps.has(child)) {
            seenSitemaps.add(child);
            next.push(child);
          }
        }
        for (const page of pages) {
          if (urls.length >= maxUrls) {
            truncated = true;
            break;
          }
          if (!seenUrls.has(page)) {
            seenUrls.add(page);
            urls.push(page);
          }
        }
      }
      queue = next.concat(queue);
    }
    if (queue.length > 0) {
      truncated = true;
    }
    log(`Sitemap: ${urls.length} URLs from ${sitemaps.length} sitemap file(s)`);
    if (urls.length === 0) {
      const failure = sitemaps.find((info) => info.error !== null);
      if (failure !== undefined && sitemaps.every((info) => info.error !== null)) {
        throw new SitemapError(`Could not read ${failure.url}: ${failure.error}`);
      }
    }
    return { urls, sitemaps, truncated };
  } finally {
    await ownedDispatcher?.close();
  }
}

async function fetchOne(
  sitemapUrl: string,
  get: (url: string) => Promise<FetchedDocument>,
): Promise<{ info: SitemapFetchInfo; pages: string[]; children: string[] }> {
  try {
    const doc = await get(sitemapUrl);
    if (doc.status >= 400) {
      return {
        info: { url: sitemapUrl, httpStatus: doc.status, kind: null, entries: 0, error: `HTTP ${doc.status}` },
        pages: [],
        children: [],
      };
    }
    const parsed = parseSitemap(doc.body, doc.url);
    return {
      info: {
        url: sitemapUrl,
        httpStatus: doc.status,
        kind: parsed.kind,
        entries: parsed.kind === 'index' ? parsed.children.length : parsed.pages.length,
        error: parsed.kind === null ? 'not a sitemap (no <url> or <sitemap> entries)' : null,
      },
      pages: parsed.pages,
      children: parsed.children,
    };
  } catch (error) {
    return {
      info: { url: sitemapUrl, httpStatus: null, kind: null, entries: 0, error: describeError(error) },
      pages: [],
      children: [],
    };
  }
}

/** Parse sitemap XML (urlset or sitemapindex) or a plain-text URL list. */
export function parseSitemap(
  body: string,
  baseUrl: string,
): { kind: SitemapFetchInfo['kind']; pages: string[]; children: string[] } {
  const trimmed = body.replace(/^\uFEFF/, '').trimStart();
  if (trimmed.startsWith('<')) {
    const $ = cheerio.load(trimmed, { xml: true });
    const locs = (selector: string): string[] =>
      $(selector)
        .map((_, node) => $(node).text().trim())
        .get()
        .map((loc) => normalizeUrl(loc, baseUrl))
        .filter((loc): loc is string => loc !== null);
    // Namespaced documents (<ns:urlset>) are matched by local name too.
    const children = locs('sitemapindex > sitemap > loc, sitemap > loc');
    const pages = locs('urlset > url > loc, url > loc');
    if (children.length > 0 && pages.length === 0) {
      return { kind: 'index', pages: [], children };
    }
    if (pages.length > 0) {
      return { kind: 'urlset', pages, children };
    }
    return { kind: null, pages: [], children: [] };
  }
  const pages = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line))
    .map((line) => normalizeUrl(line))
    .filter((line): line is string => line !== null);
  return { kind: pages.length > 0 ? 'text' : null, pages, children: [] };
}

async function discoverSitemaps(
  siteUrl: string,
  get: (url: string) => Promise<FetchedDocument>,
  log: (message: string) => void,
): Promise<string[]> {
  const origin = new URL(siteUrl).origin;
  try {
    const robots = await get(`${origin}/robots.txt`);
    if (robots.status < 400) {
      const declared = robots.body
        .split(/\r?\n/)
        .map((line) => /^\s*sitemap\s*:\s*(\S+)/i.exec(line)?.[1])
        .filter((value): value is string => value !== undefined)
        .map((value) => normalizeUrl(value, origin))
        .filter((value): value is string => value !== null);
      if (declared.length > 0) {
        log(`robots.txt declares ${declared.length} sitemap(s)`);
        return [...new Set(declared)];
      }
    }
  } catch (error) {
    if (error instanceof SitemapError) {
      throw error;
    }
    log(`Could not read robots.txt: ${describeError(error)}`);
  }
  for (const path of SITEMAP_CANDIDATE_PATHS) {
    const candidate = `${origin}${path}`;
    try {
      const doc = await get(candidate);
      if (doc.status < 400 && parseSitemap(doc.body, doc.url).kind !== null) {
        log(`Found sitemap at ${candidate}`);
        return [candidate];
      }
    } catch (error) {
      if (error instanceof SitemapError) {
        throw error;
      }
    }
  }
  return [];
}

/** True when the URL itself points at a sitemap rather than a site page. */
function looksLikeSitemap(url: string): boolean {
  const path = new URL(url).pathname.toLowerCase();
  return /\.(xml|xml\.gz|txt)$/.test(path) || path.includes('sitemap');
}

/** Accept full URLs or bare domains ("example.com/blog"). */
function toAbsoluteUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return normalizeUrl(withScheme);
}

function describeError(error: unknown): string {
  if (error instanceof SitemapError) {
    return error.message;
  }
  const chain: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && chain.length < 4) {
    const code = (current as { code?: unknown }).code;
    chain.push(typeof code === 'string' ? code : current.message);
    current = current.cause;
  }
  if (chain.some((part) => /timeout|aborted/i.test(part))) {
    return 'timeout';
  }
  return chain.find((part) => /^E[A-Z]+$|^UND_ERR/.test(part)) ?? chain[0] ?? 'unknown error';
}
