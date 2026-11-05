/**
 * Real-browser fallback for bot-protected sites (Cloudflare "Just a
 * moment...", Turnstile, and similar WAF challenges).
 *
 * Plain HTTP clients cannot run a JavaScript challenge; a real Chromium can,
 * which is how Screaming Frog's JavaScript rendering mode gets through. Only
 * requests that were actually blocked are sent here, and the cookies the
 * browser earns (e.g. `cf_clearance`) are handed back to the HTTP checker so
 * the remaining requests to that host stay fast. Cloudflare binds clearance
 * cookies to the IP and User-Agent, so the browser uses the same UA (and the
 * same proxy) as the HTTP checker.
 *
 * Playwright is an optional dependency, imported lazily only when the
 * fallback is enabled:
 *   npm install playwright && npx playwright install chromium
 *
 * In `headful` mode a visible browser window opens and challenges are given
 * up to two minutes, so an interactive check (a Turnstile checkbox) can be
 * completed by hand.
 */

import { createRequire } from 'node:module';
import pLimit from 'p-limit';
import { BOT_PROTECTION_OUTCOME, isBotChallenge } from './botProtection.js';
import type { BrowserFallback, LinkCheckResult, PageFetchResult } from './types.js';

export interface BrowserFallbackOptions {
  /** Must match the HTTP checker's UA so clearance cookies stay valid. */
  userAgent: string;
  /** Show the browser window and wait longer, for manual challenge solving. */
  headful?: boolean;
  /** Navigation timeout per page in milliseconds. */
  timeoutMs: number;
  /** Proxy URL, so the browser exits from the same IP as the HTTP checker. */
  proxyUrl?: string;
  /** Maximum simultaneously open browser tabs. */
  maxTabs?: number;
  log?: (message: string) => void;
}

// Minimal structural types for the parts of Playwright used here, so the
// package stays optional at compile time too.
interface PwRequest {
  isNavigationRequest(): boolean;
  redirectedFrom(): PwRequest | null;
}
interface PwResponse {
  status(): number;
  headers(): Record<string, string>;
  url(): string;
  frame(): unknown;
  request(): PwRequest;
}
interface PwPage {
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<PwResponse | null>;
  on(event: 'response', handler: (response: PwResponse) => void): void;
  mainFrame(): unknown;
  content(): Promise<string>;
  url(): string;
  waitForTimeout(ms: number): Promise<void>;
  close(): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  cookies(urls: string[]): Promise<Array<{ name: string; value: string }>>;
  addInitScript(script: string): Promise<void>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(options: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwModule {
  chromium: { launch(options: Record<string, unknown>): Promise<PwBrowser> };
}

const POLL_INTERVAL_MS = 1_000;
const HEADLESS_CHALLENGE_WAIT_MS = 20_000;
const HEADFUL_CHALLENGE_WAIT_MS = 120_000;

/** Install instructions shown when Playwright is missing. */
export const PLAYWRIGHT_MISSING_MESSAGE =
  'The browser fallback needs Playwright. Install it with:\n' +
  '  npm install playwright && npx playwright install chromium';

export async function loadPlaywright(): Promise<PwModule> {
  // A variable specifier keeps TypeScript and bundlers from requiring the
  // optional package at build time.
  const specifier = 'playwright';
  try {
    return (await import(specifier)) as PwModule;
  } catch {
    // ESM resolution ignores NODE_PATH; CommonJS resolution also finds a
    // globally installed Playwright when NODE_PATH points at it.
    try {
      return createRequire(import.meta.url)(specifier) as PwModule;
    } catch {
      throw new Error(PLAYWRIGHT_MISSING_MESSAGE);
    }
  }
}

export class PlaywrightFallback implements BrowserFallback {
  private contextPromise: Promise<{ browser: PwBrowser; context: PwContext }> | null = null;
  private readonly tabs: ReturnType<typeof pLimit>;
  private readonly log: (message: string) => void;

  constructor(private readonly options: BrowserFallbackOptions) {
    this.tabs = pLimit(options.maxTabs ?? (options.headful === true ? 1 : 3));
    this.log = options.log ?? ((): void => {});
  }

  /** Fail fast at startup when Playwright or its Chromium is not installed. */
  async ensureAvailable(): Promise<void> {
    await this.context();
  }

  async fetchPage(url: string): Promise<PageFetchResult> {
    return this.tabs(async () => {
      const visit = await this.visit(url);
      if (visit.challenged) {
        return {
          finalUrl: visit.finalUrl,
          httpStatus: visit.status,
          html: null,
          error: BOT_PROTECTION_OUTCOME,
          via: 'BROWSER',
        };
      }
      return {
        finalUrl: visit.finalUrl,
        httpStatus: visit.status,
        html: visit.html,
        error: null,
        via: 'BROWSER',
      };
    });
  }

  async checkLink(url: string): Promise<LinkCheckResult> {
    return this.tabs(async () => {
      const visit = await this.visit(url);
      return {
        targetUrl: url,
        finalUrl: visit.finalUrl,
        httpStatus: visit.status,
        outcome: visit.challenged
          ? BOT_PROTECTION_OUTCOME
          : visit.status === null
            ? 'unknown'
            : String(visit.status),
        redirectHops: visit.hops,
        methodUsed: 'BROWSER',
      };
    });
  }

  async cookiesFor(host: string): Promise<string | null> {
    if (this.contextPromise === null) {
      return null;
    }
    const { context } = await this.contextPromise;
    const cookies = await context.cookies([`https://${host}/`, `http://${host}/`]);
    if (cookies.length === 0) {
      return null;
    }
    const unique = new Map(cookies.map((cookie) => [cookie.name, cookie.value]));
    return [...unique].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async close(): Promise<void> {
    if (this.contextPromise === null) {
      return;
    }
    const pending = this.contextPromise;
    this.contextPromise = null;
    try {
      const { browser } = await pending;
      await browser.close();
    } catch {
      // Launch failed earlier; nothing to close.
    }
  }

  private context(): Promise<{ browser: PwBrowser; context: PwContext }> {
    if (this.contextPromise === null) {
      this.contextPromise = (async () => {
        const playwright = await loadPlaywright();
        const headful = this.options.headful === true;
        this.log(`Launching ${headful ? 'visible' : 'headless'} Chromium for blocked requests`);
        const browser = await playwright.chromium.launch({
          headless: !headful,
          args: ['--disable-blink-features=AutomationControlled'],
          ...(this.options.proxyUrl !== undefined && this.options.proxyUrl.length > 0
            ? { proxy: proxyOption(this.options.proxyUrl) }
            : {}),
        });
        const context = await browser.newContext({
          userAgent: this.options.userAgent,
          locale: 'en-US',
          viewport: { width: 1366, height: 768 },
          acceptDownloads: false,
        });
        // Hide the most common automation tell-tale.
        await context.addInitScript(
          "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });",
        );
        return { browser, context };
      })();
      // Do not cache a failed launch forever; surface it to every caller.
      this.contextPromise.catch(() => {
        this.contextPromise = null;
      });
    }
    return this.contextPromise;
  }

  /** Navigate, wait for any challenge to clear, and report what was reached. */
  private async visit(url: string): Promise<{
    finalUrl: string;
    status: number | null;
    html: string | null;
    hops: number;
    challenged: boolean;
  }> {
    const { context } = await this.context();
    const page = await context.newPage();
    // Track the latest main-frame document response: after a challenge
    // passes, the page navigates again to the real resource.
    const tracked: { last: PwResponse | null } = { last: null };
    page.on('response', (response) => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        tracked.last = response;
      }
    });
    try {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.options.timeoutMs });
      } catch (error) {
        const message = String(error);
        // Non-HTML targets (PDF, zip...) start a download instead of a page.
        const response = tracked.last;
        if (/Download is starting|ERR_ABORTED/i.test(message) && response !== null) {
          return {
            finalUrl: response.url(),
            status: response.status(),
            html: null,
            hops: countRedirects(response),
            challenged: false,
          };
        }
        throw error;
      }
      const waitBudget =
        this.options.headful === true ? HEADFUL_CHALLENGE_WAIT_MS : HEADLESS_CHALLENGE_WAIT_MS;
      const deadline = Date.now() + waitBudget;
      let html = await safeContent(page);
      let challenged = this.isChallenged(tracked.last, html);
      if (challenged) {
        this.log(`Waiting for the bot-protection challenge on ${url} to clear...`);
      }
      while (challenged && Date.now() < deadline) {
        await page.waitForTimeout(POLL_INTERVAL_MS);
        html = await safeContent(page);
        challenged = this.isChallenged(tracked.last, html);
      }
      const finalResponse = tracked.last;
      return {
        finalUrl: page.url(),
        status: finalResponse === null ? null : finalResponse.status(),
        html,
        hops: finalResponse === null ? 0 : countRedirects(finalResponse),
        challenged,
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private isChallenged(response: PwResponse | null, html: string | null): boolean {
    const status = response === null ? 200 : response.status();
    const headers = response === null ? {} : response.headers();
    // The rendered DOM may still carry challenge markup with a 200 status
    // after JavaScript replaced the document, so check the markup at a
    // block status and the explicit Cloudflare marker / title in any case.
    if (isBotChallenge(status, headers, html)) {
      return true;
    }
    return html !== null && /<title>\s*Just a moment\.\.\.\s*<\/title>/i.test(html);
  }
}

async function safeContent(page: PwPage): Promise<string | null> {
  try {
    return await page.content();
  } catch {
    // The page is mid-navigation (e.g. the challenge just redirected).
    return null;
  }
}

function countRedirects(response: PwResponse): number {
  let hops = 0;
  let request = response.request().redirectedFrom();
  while (request !== null && hops < 20) {
    hops += 1;
    request = request.redirectedFrom();
  }
  return hops;
}

/** Translate a proxy URL with optional credentials into Playwright's shape. */
function proxyOption(proxyUrl: string): { server: string; username?: string; password?: string } {
  const parsed = new URL(proxyUrl);
  const server = `${parsed.protocol}//${parsed.host}`;
  if (parsed.username.length === 0) {
    return { server };
  }
  return {
    server,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}
