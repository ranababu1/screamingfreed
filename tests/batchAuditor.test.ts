import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent } from 'undici';
import {
  runAuditBatch,
} from '../src/audit/batchAuditor.js';
import type { Dispatcher } from 'undici';

let mockAgent: MockAgent;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
});

afterEach(async () => {
  await mockAgent.close();
});

function runBatch(overrides: Record<string, unknown> = {}) {
  return runAuditBatch({
    seedUrls: ['http://example.com/post'],
    requestsPerSecond: 1_000,
    concurrency: 10,
    timeoutSeconds: 2,
    deadlineMs: 60_000,
    dispatcher: mockAgent as unknown as Dispatcher,
    ...overrides,
  });
}

function mockPageWithLinks(): void {
  const pool = mockAgent.get('http://example.com');
  pool.intercept({ method: 'GET', path: '/post' }).reply(
    200,
    `<html><body><div class="entry-content">
       <a href="/ok">OK</a>
       <a href="/missing">Missing</a>
       <a href="mailto:hi@example.com">Mail</a>
     </div></body></html>`,
    { headers: { 'content-type': 'text/html' } },
  );
  pool.intercept({ method: 'HEAD', path: '/ok' }).reply(200);
  pool.intercept({ method: 'HEAD', path: '/missing' }).reply(404);
}

describe('runAuditBatch', () => {
  it('audits a page and its links and returns in-memory results', async () => {
    mockPageWithLinks();

    const result = await runBatch();

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({
      url: 'http://example.com/post',
      httpStatus: 200,
      selectorUsed: '.entry-content',
    });
    expect(result.links).toHaveLength(2);
    const outcomes = new Map(
      result.links.map((link) => [link.targetUrl, link.outcome]),
    );
    expect(outcomes.get('http://example.com/ok')).toBe('200');
    expect(outcomes.get('http://example.com/missing')).toBe('404');
    expect(result.processedSeeds).toEqual(['http://example.com/post']);
    expect(result.partialSeeds).toEqual([]);
    expect(result.unprocessedSeeds).toEqual([]);
    expect(result.summary.totalPages).toBe(1);
    expect(result.summary.totalLinks).toBe(2);
    expect(result.summary.outcomeCounts).toEqual([
      { outcome: '200', count: 1 },
      { outcome: '404', count: 1 },
    ]);
    expect(result.summary.brokenLinks).toHaveLength(1);
    expect(result.summary.brokenLinks[0]).toMatchObject({
      targetUrl: 'http://example.com/missing',
      httpStatus: 404,
      outcome: '404',
      occurrences: 1,
      examplePage: 'http://example.com/post',
    });
  });

  it('normalizes and deduplicates seeds and reports invalid ones', async () => {
    const pool = mockAgent.get('http://example.com');
    pool
      .intercept({ method: 'GET', path: '/one/' })
      .reply(200, '<html><body><main><a href="/two">two</a></main></body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    pool.intercept({ method: 'HEAD', path: '/two' }).reply(200);

    const result = await runBatch({
      seedUrls: [
        'http://example.com/one/',
        'http://EXAMPLE.com/one/',   // same URL after host lowercasing
        'not a url',
        'ftp://example.com/x',
      ],
    });

    expect(result.processedSeeds).toEqual(['http://example.com/one/']);
    expect(result.unprocessedSeeds).toEqual([]);
    expect(result.invalidSeeds).toEqual(['not a url', 'ftp://example.com/x']);
  });

  it('applies the scope filter to the links checked', async () => {
    const pool = mockAgent.get('http://example.com');
    pool.intercept({ method: 'GET', path: '/post' }).reply(
      200,
      '<html><body><main><a href="/internal">in</a><a href="https://other.com/x">out</a></main></body></html>',
      { headers: { 'content-type': 'text/html' } },
    );
    pool.intercept({ method: 'HEAD', path: '/internal' }).reply(200);
    const other = mockAgent.get('https://other.com');
    other.intercept({ method: 'HEAD', path: '/x' }).reply(200);

    const result = await runBatch({ scopeFilter: 'external' });

    expect(result.links.map((link) => link.targetUrl)).toEqual([
      'https://other.com/x',
    ]);
    expect(result.processedSeeds).toEqual(['http://example.com/post']);
    expect(result.partialSeeds).toEqual([]);
  });

  it('stops scheduling work once the deadline is exhausted', async () => {
    const pool = mockAgent.get('http://example.com');
    pool.intercept({ method: 'GET', path: '/post' }).reply(200, '<main>x</main>', {
      headers: { 'content-type': 'text/html' },
    });

    const result = await runBatch({
      deadlineMs: 0,
      now: () => 1_000,
    });

    expect(result.unprocessedSeeds).toEqual(['http://example.com/post']);
    expect(result.pages).toHaveLength(0);
    expect(result.links).toHaveLength(0);
    expect(result.processedSeeds).toEqual([]);
  });

  it('skips targets the caller already checked in earlier batches', async () => {
    mockPageWithLinks();

    const result = await runBatch({
      skipTargets: ['http://example.com/ok'],
    });

    const outcomes = new Map(
      result.links.map((link) => [link.targetUrl, link.outcome]),
    );
    expect(outcomes.has('http://example.com/ok')).toBe(false);
    expect(outcomes.get('http://example.com/missing')).toBe('404');
    expect(result.partialSeeds).toEqual([]);
    expect(result.processedSeeds).toEqual(['http://example.com/post']);
  });
});