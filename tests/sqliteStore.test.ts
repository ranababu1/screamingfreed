import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/storage/sqliteStore.js';
import type { LinkRecord } from '../src/storage/sqliteStore.js';

const FETCHED_AT = '2026-01-01T00:00:00.000Z';

let dir: string;
let store: SqliteStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sf-store-'));
  vi.useFakeTimers();
  store = new SqliteStore(join(dir, 'session.db'));
});

afterEach(async () => {
  store.close();
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

function makeLink(pageId: number, path: string, overrides: Partial<LinkRecord> = {}): LinkRecord {
  return {
    pageId,
    targetUrl: `https://example.com${path}`,
    finalUrl: null,
    anchorText: `link ${path}`,
    scope: 'internal',
    httpStatus: 200,
    outcome: '200',
    redirectHops: 0,
    methodUsed: 'HEAD',
    checkedAt: FETCHED_AT,
    ...overrides,
  };
}

describe('SqliteStore pages', () => {
  it('creates the schema and upserts pages by URL', () => {
    const id1 = store.recordPage({
      url: 'https://example.com/a',
      httpStatus: 200,
      selectorUsed: '.entry-content',
      fetchedAt: FETCHED_AT,
    });
    expect(id1).toBeGreaterThan(0);

    const id2 = store.recordPage({
      url: 'https://example.com/a',
      httpStatus: 500,
      selectorUsed: null,
      fetchedAt: FETCHED_AT,
    });
    expect(id2).toBe(id1); // same URL -> same row
    expect(store.countPages()).toBe(1);
  });
});

describe('SqliteStore link batching', () => {
  it('flushes as soon as 50 rows are buffered', () => {
    const pageId = store.recordPage({
      url: 'https://example.com/page',
      httpStatus: 200,
      selectorUsed: 'main',
      fetchedAt: FETCHED_AT,
    });
    for (let index = 0; index < 50; index += 1) {
      store.recordLink(makeLink(pageId, `/${index}`));
    }
    expect(store.countLinks()).toBe(50); // auto-flushed at batch size

    store.recordLink(makeLink(pageId, '/extra'));
    expect(store.countLinks()).toBe(50); // still buffered

    store.flush();
    expect(store.countLinks()).toBe(51);
  });

  it('flushes buffered rows every 2 seconds', () => {
    const pageId = store.recordPage({
      url: 'https://example.com/page',
      httpStatus: 200,
      selectorUsed: 'main',
      fetchedAt: FETCHED_AT,
    });
    store.recordLink(makeLink(pageId, '/one'));
    expect(store.countLinks()).toBe(0); // buffered, not yet written

    vi.advanceTimersByTime(2_000);
    expect(store.countLinks()).toBe(1);
  });

  it('flushes remaining rows on close', () => {
    const otherPath = join(dir, 'other.db');
    const other = new SqliteStore(otherPath);
    const pageId = other.recordPage({
      url: 'https://example.com/page',
      httpStatus: 200,
      selectorUsed: 'main',
      fetchedAt: FETCHED_AT,
    });
    other.recordLink(makeLink(pageId, '/one'));
    other.close();

    const reopened = new SqliteStore(otherPath);
    expect(reopened.countLinks()).toBe(1);
    reopened.close();
  });
});

describe('SqliteStore reporting queries', () => {
  it('aggregates outcome counts, broken links and CSV rows', () => {
    const pageId = store.recordPage({
      url: 'https://example.com/page',
      httpStatus: 200,
      selectorUsed: 'main',
      fetchedAt: FETCHED_AT,
    });
    store.recordLink(makeLink(pageId, '/broken-a', { httpStatus: 404, outcome: '404' }));
    store.recordLink(makeLink(pageId, '/broken-a', { httpStatus: 404, outcome: '404' }));
    store.recordLink(makeLink(pageId, '/ok'));
    store.recordLink(
      makeLink(pageId, '/dead', { httpStatus: null, outcome: 'timeout', scope: 'external' }),
    );
    store.flush();

    expect(store.getOutcomeCounts()).toEqual([
      { outcome: '404', count: 2 },
      { outcome: '200', count: 1 },
      { outcome: 'timeout', count: 1 },
    ]);

    const broken = store.getBrokenLinks(20);
    expect(broken).toHaveLength(2);
    expect(broken[0]).toMatchObject({
      target_url: 'https://example.com/broken-a',
      http_status: 404,
      outcome: '404',
      occurrences: 2,
      example_page: 'https://example.com/page',
    });

    const rows = store.getAllLinkRows();
    expect(rows).toHaveLength(4);
    expect(rows[0].page_url).toBe('https://example.com/page');
    expect(rows[0].target_url).toBe('https://example.com/broken-a');
  });
});