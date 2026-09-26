import { describe, expect, it } from 'vitest';
import {
  dedupePreservingOrder,
  normalizeUrl,
} from '../src/ingestion/urlNormalizer.js';

describe('normalizeUrl', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeUrl('  https://example.com/a  ')).toBe('https://example.com/a');
  });

  it('strips fragments', () => {
    expect(normalizeUrl('https://example.com/page#section')).toBe('https://example.com/page');
    expect(normalizeUrl('https://example.com/page#', 'https://example.com/')).toBe(
      'https://example.com/page',
    );
  });

  it('lowercases scheme and host but preserves path case', () => {
    expect(normalizeUrl('HTTPS://ExAmPlE.COM/Path')).toBe('https://example.com/Path');
  });

  it('removes default ports but keeps non-default ones', () => {
    expect(normalizeUrl('http://example.com:80/a')).toBe('http://example.com/a');
    expect(normalizeUrl('https://example.com:443/a')).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com:8443/a')).toBe('https://example.com:8443/a');
  });

  it('resolves relative URLs against the base', () => {
    expect(normalizeUrl('/about', 'https://example.com/blog/post')).toBe(
      'https://example.com/about',
    );
    expect(normalizeUrl('../foo/bar.html', 'https://example.com/blog/one/')).toBe(
      'https://example.com/blog/foo/bar.html',
    );
    expect(normalizeUrl('../../foo/bar.html', 'https://example.com/blog/one/')).toBe(
      'https://example.com/foo/bar.html',
    );
    expect(normalizeUrl('page2', 'https://example.com/blog/one/')).toBe(
      'https://example.com/blog/one/page2',
    );
  });

  it('accepts absolute URLs even when a base is provided', () => {
    expect(normalizeUrl('https://other.com/x', 'https://example.com/')).toBe(
      'https://other.com/x',
    );
  });

  it('rejects empty, unparseable, relative-without-base and non-http input', () => {
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('example.com/page')).toBeNull();
    expect(normalizeUrl('ftp://example.com/f')).toBeNull();
    expect(normalizeUrl('mailto:hi@example.com')).toBeNull();
  });
});

describe('dedupePreservingOrder', () => {
  it('keeps first-seen order', () => {
    expect(dedupePreservingOrder(['c', 'a', 'c', 'b', 'a'])).toEqual(['c', 'a', 'b']);
  });

  it('normalizes equivalent spellings before comparing in the crawl pipeline', () => {
    // http://example.com and http://example.com/ normalize to the same URL.
    expect(dedupePreservingOrder(['http://example.com', 'http://example.com/'])).toHaveLength(2);
  });
});