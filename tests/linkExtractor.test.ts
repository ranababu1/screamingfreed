import { describe, expect, it } from 'vitest';
import { isolateContent } from '../src/extraction/contentIsolator.js';
import { extractLinks } from '../src/extraction/linkExtractor.js';
import type { ExtractedLink } from '../src/crawling/types.js';

function linksFrom(html: string, pageUrl: string): ExtractedLink[] {
  const isolated = isolateContent(html);
  return extractLinks(isolated.scope, pageUrl);
}

describe('extractLinks', () => {
  it('filters non-crawlable schemes and fragment-only hrefs', () => {
    const html = `<html><body><main>
      <a href="https://example.com/ok">OK</a>
      <a href="mailto:hi@example.com">Mail</a>
      <a href="tel:+15551234567">Phone</a>
      <a href="javascript:void(0)">JS</a>
      <a href="data:text/plain,hi">Data</a>
      <a href="sms:+15551234567">SMS</a>
      <a href="">Empty</a>
      <a href="#top">Anchor</a>
      <a>Missing href</a>
    </main></body></html>`;
    const links = linksFrom(html, 'https://example.com/page');
    expect(links.map((link) => link.targetUrl)).toEqual(['https://example.com/ok']);
  });

  it('normalizes relative and fragment-carrying hrefs against the page URL', () => {
    const html = `<html><body><main>
      <a href="/about">About</a>
      <a href="../other">Other</a>
      <a href="https://example.com/page#section">Same page</a>
    </main></body></html>`;
    const links = linksFrom(html, 'https://example.com/blog/post/one');
    expect(links.map((link) => link.targetUrl)).toEqual([
      'https://example.com/about',
      'https://example.com/blog/other',
      'https://example.com/page',
    ]);
  });

  it('classifies internal vs external via registrable domain (www and subdomains)', () => {
    const html = `<html><body><main>
      <a href="https://www.example.com/x">www</a>
      <a href="https://example.com/y">apex</a>
      <a href="https://blog.example.com/z">subdomain</a>
      <a href="https://other.com/a">other</a>
      <a href="https://example.co.uk/b">similar tld</a>
      <a href="https://notexample.com/c">lookalike</a>
    </main></body></html>`;
    const links = linksFrom(html, 'https://www.example.com/blog/post');
    expect(links.map((link) => link.scope)).toEqual([
      'internal',
      'internal',
      'internal',
      'external',
      'external',
      'external',
    ]);
  });

  it('treats hosts without a registrable domain by exact host comparison', () => {
    const html = `<html><body><main>
      <a href="https://localhost:3000/b">same port</a>
      <a href="https://localhost:4000/c">different port</a>
      <a href="https://127.0.0.1:3000/d">ip</a>
    </main></body></html>`;
    const links = linksFrom(html, 'https://localhost:3000/a');
    expect(links.map((link) => link.scope)).toEqual(['internal', 'external', 'external']);
  });

  it('deduplicates per parent page keeping the first anchor text', () => {
    const html = `<html><body><main>
      <a href="https://example.com/dup">First</a>
      <a href="https://example.com/dup">Second</a>
      <a href="/dup2">Third</a>
      <a href="https://example.com/dup2">Fourth</a>
    </main></body></html>`;
    const links = linksFrom(html, 'https://example.com/page');
    expect(links).toHaveLength(2);
    expect(links[0].anchorText).toBe('First');
    expect(links[1].anchorText).toBe('Third');
  });

  it('collapses whitespace in anchor text', () => {
    const html = `<html><body><main>
      <a href="/text">\n    Hello\n    world  </a>
    </main></body></html>`;
    const links = linksFrom(html, 'https://example.com/page');
    expect(links[0].anchorText).toBe('Hello world');
  });
});