import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent } from 'undici';
import { LinkChecker } from '../src/crawling/linkChecker.js';
import type { BrowserFallback, LinkCheckResult, PageFetchResult } from '../src/crawling/types.js';
import type { Dispatcher } from 'undici';

const CHALLENGE =
  '<html><head><title>Just a moment...</title></head><body>' +
  '<script src="/cdn-cgi/challenge-platform/x.js"></script></body></html>';
const CF_HEADERS = { server: 'cloudflare', 'content-type': 'text/html' };

let mockAgent: MockAgent;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
});

afterEach(async () => {
  await mockAgent.close();
});

function createChecker(browserFallback?: BrowserFallback): LinkChecker {
  return new LinkChecker({
    dispatcher: mockAgent as unknown as Dispatcher,
    requestsPerSecond: 1_000,
    timeoutMs: 2_000,
    browserFallback,
  });
}

class FakeBrowser implements BrowserFallback {
  pagesFetched: string[] = [];
  linksChecked: string[] = [];
  constructor(private readonly cookie: string | null = 'cf_clearance=ok') {}
  async fetchPage(url: string): Promise<PageFetchResult> {
    this.pagesFetched.push(url);
    return {
      finalUrl: url,
      httpStatus: 200,
      html: '<article><a href="/x">x</a></article>',
      error: null,
      via: 'BROWSER',
    };
  }
  async checkLink(url: string): Promise<LinkCheckResult> {
    this.linksChecked.push(url);
    return {
      targetUrl: url,
      finalUrl: url,
      httpStatus: 200,
      outcome: '200',
      redirectHops: 0,
      methodUsed: 'BROWSER',
    };
  }
  async cookiesFor(): Promise<string | null> {
    return this.cookie;
  }
  async close(): Promise<void> {}
}

describe('LinkChecker bot protection handling', () => {
  it('sends browser-like headers by default', async () => {
    const pool = mockAgent.get('http://example.com');
    pool
      .intercept({
        method: 'HEAD',
        path: '/ok',
        headers: (headers) =>
          /Chrome\//.test(String(headers['user-agent'])) &&
          String(headers.accept).includes('text/html'),
      })
      .reply(200);

    const result = await createChecker().checkLink('http://example.com/ok');
    expect(result.httpStatus).toBe(200);
  });

  it('retries a HEAD rejected with 403 using GET', async () => {
    const pool = mockAgent.get('http://example.com');
    pool.intercept({ method: 'HEAD', path: '/waf' }).reply(403);
    pool.intercept({ method: 'GET', path: '/waf' }).reply(200, 'hello');

    const result = await createChecker().checkLink('http://example.com/waf');
    expect(result.httpStatus).toBe(200);
    expect(result.methodUsed).toBe('GET');
  });

  it('reports a Cloudflare challenge as bot_protection, not a broken link', async () => {
    const pool = mockAgent.get('http://example.com');
    pool.intercept({ method: 'HEAD', path: '/cf' }).reply(403, '', { headers: CF_HEADERS });
    pool.intercept({ method: 'GET', path: '/cf' }).reply(403, CHALLENGE, { headers: CF_HEADERS });

    const result = await createChecker().checkLink('http://example.com/cf');
    expect(result.outcome).toBe('bot_protection');
    expect(result.httpStatus).toBe(403);
  });

  it('still reports a genuine 404 behind Cloudflare as broken', async () => {
    const pool = mockAgent.get('http://example.com');
    pool.intercept({ method: 'HEAD', path: '/gone' }).reply(404, '', { headers: CF_HEADERS });

    const result = await createChecker().checkLink('http://example.com/gone');
    expect(result.outcome).toBe('404');
  });

  it('marks a challenged seed page as a bot_protection failure without a fallback', async () => {
    const pool = mockAgent.get('http://example.com');
    pool.intercept({ method: 'GET', path: '/post' }).reply(503, CHALLENGE, { headers: CF_HEADERS });

    const page = await createChecker().fetchPage('http://example.com/post');
    expect(page.html).toBeNull();
    expect(page.error).toBe('bot_protection');
    expect(page.httpStatus).toBe(503);
  });

  it('loads a challenged page in the browser and reuses its cookies over HTTP', async () => {
    const browser = new FakeBrowser();
    const pool = mockAgent.get('http://example.com');
    pool.intercept({ method: 'GET', path: '/post' }).reply(403, CHALLENGE, { headers: CF_HEADERS });
    // After the browser earned cf_clearance, HTTP requests carry it and pass.
    pool
      .intercept({
        method: 'HEAD',
        path: '/x',
        headers: (headers) => String(headers.cookie).includes('cf_clearance=ok'),
      })
      .reply(200);

    const checker = createChecker(browser);
    const page = await checker.fetchPage('http://example.com/post');
    expect(page.via).toBe('BROWSER');
    expect(page.html).toContain('<article>');

    const link = await checker.checkLink('http://example.com/x');
    expect(link.httpStatus).toBe(200);
    expect(link.methodUsed).toBe('HEAD');
    expect(browser.linksChecked).toEqual([]);
  });

  it('verifies a challenged link in the browser when cookies do not help', async () => {
    const browser = new FakeBrowser(null);
    const pool = mockAgent.get('http://other.example');
    pool.intercept({ method: 'HEAD', path: '/a' }).reply(403, '', { headers: CF_HEADERS });
    pool.intercept({ method: 'GET', path: '/a' }).reply(403, CHALLENGE, { headers: CF_HEADERS });

    const result = await createChecker(browser).checkLink('http://other.example/a');
    expect(result.httpStatus).toBe(200);
    expect(result.methodUsed).toBe('BROWSER');
    expect(browser.linksChecked).toEqual(['http://other.example/a']);
  });
});
