import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent } from 'undici';
import { LinkChecker } from '../src/crawling/linkChecker.js';
import type { Dispatcher } from 'undici';

let mockAgent: MockAgent;

function createChecker(timeoutMs = 2_000): LinkChecker {
  return new LinkChecker({
    dispatcher: mockAgent as unknown as Dispatcher,
    requestsPerSecond: 1_000,
    timeoutMs,
  });
}

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
});

afterEach(async () => {
  await mockAgent.close();
});

describe('LinkChecker HEAD/GET handling', () => {
  it('retries with GET when HEAD answers 405', async () => {
    const pool = mockAgent.get('http://example.com');
    pool.intercept({ method: 'HEAD', path: '/not-allowed' }).reply(405);
    pool.intercept({ method: 'GET', path: '/not-allowed' }).reply(200);

    const result = await createChecker().checkLink('http://example.com/not-allowed');

    expect(result.httpStatus).toBe(200);
    expect(result.outcome).toBe('200');
    expect(result.methodUsed).toBe('GET');
    expect(result.redirectHops).toBe(0);
  });

  it('retries with GET when HEAD answers 501', async () => {
    const pool = mockAgent.get('http://example.com');
    pool.intercept({ method: 'HEAD', path: '/nope' }).reply(501);
    pool.intercept({ method: 'GET', path: '/nope' }).reply(200);

    const result = await createChecker().checkLink('http://example.com/nope');

    expect(result.httpStatus).toBe(200);
    expect(result.methodUsed).toBe('GET');
  });

  it('keeps the HEAD result when the server allows it', async () => {
    const pool = mockAgent.get('http://example.com');
    pool.intercept({ method: 'HEAD', path: '/fine' }).reply(200);

    const result = await createChecker().checkLink('http://example.com/fine');

    expect(result.httpStatus).toBe(200);
    expect(result.methodUsed).toBe('HEAD');
    expect(result.outcome).toBe('200');
    expect(result.finalUrl).toBe('http://example.com/fine');
  });
});

describe('LinkChecker redirect chains', () => {
  it('follows redirects manually and records final status, url and hops', async () => {
    const pool = mockAgent.get('http://example.com');
    pool
      .intercept({ method: 'HEAD', path: '/a' })
      .reply(301, '', { headers: { location: '/b' } });
    pool
      .intercept({ method: 'HEAD', path: '/b' })
      .reply(302, '', { headers: { location: 'https://other.com/c' } });
    const other = mockAgent.get('https://other.com');
    other.intercept({ method: 'HEAD', path: '/c' }).reply(200);

    const result = await createChecker().checkLink('http://example.com/a');

    expect(result.httpStatus).toBe(200);
    expect(result.finalUrl).toBe('https://other.com/c');
    expect(result.redirectHops).toBe(2);
    expect(result.outcome).toBe('200');
  });

  it('reports too_many_redirects after 5 hops', async () => {
    const pool = mockAgent.get('http://example.com');
    pool
      .intercept({ method: 'HEAD', path: '/loop' })
      .reply(302, '', { headers: { location: '/loop' } })
      .persist();

    const result = await createChecker().checkLink('http://example.com/loop');

    expect(result.outcome).toBe('too_many_redirects');
    expect(result.httpStatus).toBeNull();
    expect(result.finalUrl).toBeNull();
    expect(result.redirectHops).toBe(5);
  });
});

describe('LinkChecker timeout categorization', () => {
  it('categorizes a request that never responds as timeout', async () => {
    const pool = mockAgent.get('http://example.com');
    pool
      .intercept({ method: 'HEAD', path: '/slow' })
      .reply(200)
      .delay(5_000); // response arrives long after the request timeout

    const result = await createChecker(50).checkLink('http://example.com/slow');

    expect(result.outcome).toBe('timeout');
    expect(result.httpStatus).toBeNull();
    expect(result.finalUrl).toBeNull();
    expect(result.methodUsed).toBe('HEAD');
  });
});

describe('LinkChecker 429 handling', () => {
  it('honors Retry-After and retries once', async () => {
    const pool = mockAgent.get('http://example.com');
    pool
      .intercept({ method: 'HEAD', path: '/limited' })
      .reply(429, '', { headers: { 'retry-after': '0' } });
    pool.intercept({ method: 'HEAD', path: '/limited' }).reply(200);

    const result = await createChecker().checkLink('http://example.com/limited');

    expect(result.httpStatus).toBe(200);
    expect(result.outcome).toBe('200');
  });
});

describe('LinkChecker fetchPage', () => {
  it('GETs the page and returns its HTML', async () => {
    const pool = mockAgent.get('http://example.com');
    pool.intercept({ method: 'GET', path: '/post' }).reply(
      200,
      '<html><body><main>hello</main></body></html>',
      { headers: { 'content-type': 'text/html; charset=UTF-8' } },
    );

    const page = await createChecker().fetchPage('http://example.com/post');

    expect(page.httpStatus).toBe(200);
    expect(page.error).toBeNull();
    expect(page.html).toContain('hello');
    expect(page.finalUrl).toBe('http://example.com/post');
  });

  it('returns no HTML for non-HTML content', async () => {
    const pool = mockAgent.get('http://example.com');
    pool.intercept({ method: 'GET', path: '/file.pdf' }).reply(200, '%PDF-1.4', {
      headers: { 'content-type': 'application/pdf' },
    });

    const page = await createChecker().fetchPage('http://example.com/file.pdf');

    expect(page.httpStatus).toBe(200);
    expect(page.html).toBeNull();
  });

  it('follows redirects when fetching pages', async () => {
    const pool = mockAgent.get('http://example.com');
    pool
      .intercept({ method: 'GET', path: '/old' })
      .reply(301, '', { headers: { location: '/new' } });
    pool.intercept({ method: 'GET', path: '/new' }).reply(200, '<main>hi</main>', {
      headers: { 'content-type': 'text/html' },
    });

    const page = await createChecker().fetchPage('http://example.com/old');

    expect(page.finalUrl).toBe('http://example.com/new');
    expect(page.httpStatus).toBe(200);
  });
});