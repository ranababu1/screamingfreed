import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent } from 'undici';
import type { Dispatcher } from 'undici';
import { loadSitemap, parseSitemap } from '../src/ingestion/sitemapLoader.js';

let mockAgent: MockAgent;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
});

afterEach(async () => {
  await mockAgent.close();
});

const load = (input: string, extra: Record<string, unknown> = {}) =>
  loadSitemap(input, { dispatcher: mockAgent as unknown as Dispatcher, ...extra });

const urlset = (...paths: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>
   <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
           xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
   ${paths.map((p) => `<url><loc>https://example.com${p}</loc><image:image><image:loc>https://example.com/i.png</image:loc></image:image></url>`).join('')}
   </urlset>`;

describe('parseSitemap', () => {
  it('reads urlsets, indexes and text sitemaps', () => {
    expect(parseSitemap(urlset('/a', '/b'), 'https://example.com/s.xml')).toEqual({
      kind: 'urlset',
      pages: ['https://example.com/a', 'https://example.com/b'],
      children: [],
    });
    const index = parseSitemap(
      '<sitemapindex><sitemap><loc>https://example.com/post-sitemap.xml</loc></sitemap></sitemapindex>',
      'https://example.com/sitemap_index.xml',
    );
    expect(index.kind).toBe('index');
    expect(index.children).toEqual(['https://example.com/post-sitemap.xml']);
    expect(parseSitemap('https://example.com/x\nnot a url\n', 'https://example.com/s.txt').pages)
      .toEqual(['https://example.com/x']);
    expect(parseSitemap('<html><body>hi</body></html>', 'https://example.com/').kind).toBeNull();
  });
});

describe('loadSitemap', () => {
  it('follows a sitemap index, gunzips .xml.gz children and dedupes URLs', async () => {
    const pool = mockAgent.get('https://example.com');
    pool.intercept({ path: '/sitemap_index.xml' }).reply(
      200,
      `<sitemapindex>
         <sitemap><loc>https://example.com/posts.xml</loc></sitemap>
         <sitemap><loc>https://example.com/pages.xml.gz</loc></sitemap>
       </sitemapindex>`,
    );
    pool.intercept({ path: '/posts.xml' }).reply(200, urlset('/p1', '/p2', '/shared'));
    pool.intercept({ path: '/pages.xml.gz' }).reply(200, gzipSync(urlset('/about', '/shared')));

    const result = await load('https://example.com/sitemap_index.xml');

    expect(result.urls).toEqual([
      'https://example.com/p1',
      'https://example.com/p2',
      'https://example.com/shared',
      'https://example.com/about',
    ]);
    expect(result.sitemaps.map((s) => [s.kind, s.entries])).toEqual([
      ['index', 2],
      ['urlset', 3],
      ['urlset', 2],
    ]);
    expect(result.truncated).toBe(false);
  });

  it('discovers the sitemap from robots.txt for a bare domain', async () => {
    const pool = mockAgent.get('https://example.com');
    pool.intercept({ path: '/robots.txt' }).reply(
      200,
      'User-agent: *\nDisallow: /wp-admin/\nSitemap: https://example.com/custom-map.xml\n',
    );
    pool.intercept({ path: '/custom-map.xml' }).reply(200, urlset('/one'));

    const result = await load('example.com');
    expect(result.urls).toEqual(['https://example.com/one']);
  });

  it('falls back to the conventional locations when robots.txt has none', async () => {
    const pool = mockAgent.get('https://example.com');
    pool.intercept({ path: '/robots.txt' }).reply(404, '');
    pool.intercept({ path: '/sitemap.xml' }).reply(404, '');
    // Fetched once: the discovery probe's response is reused.
    pool.intercept({ path: '/sitemap_index.xml' }).reply(200, urlset('/found'));

    const result = await load('https://example.com/');
    expect(result.urls).toEqual(['https://example.com/found']);
  });

  it('reports a Cloudflare challenge instead of an empty result', async () => {
    const pool = mockAgent.get('https://example.com');
    pool.intercept({ path: '/sitemap.xml' }).reply(
      403,
      '<html><head><title>Just a moment...</title></head></html>',
      { headers: { 'cf-mitigated': 'challenge', server: 'cloudflare' } },
    );

    await expect(load('https://example.com/sitemap.xml')).rejects.toThrow(/bot protection/);
  });

  it('stops at maxUrls and marks the result as truncated', async () => {
    const pool = mockAgent.get('https://example.com');
    pool.intercept({ path: '/sitemap.xml' }).reply(200, urlset('/1', '/2', '/3'));

    const result = await load('https://example.com/sitemap.xml', { maxUrls: 2 });
    expect(result.urls).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
