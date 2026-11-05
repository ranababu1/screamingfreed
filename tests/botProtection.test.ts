import { describe, expect, it } from 'vitest';
import { isBotChallenge } from '../src/crawling/botProtection.js';
import {
  BOT_USER_AGENT,
  CHROME_USER_AGENT,
  RequestProfile,
  parseHeaderLines,
} from '../src/crawling/requestProfile.js';

const CF_CHALLENGE_HTML =
  '<!DOCTYPE html><html><head><title>Just a moment...</title></head>' +
  '<body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';

describe('isBotChallenge', () => {
  it('recognizes the explicit cf-mitigated header at any status', () => {
    expect(isBotChallenge(403, { 'cf-mitigated': 'challenge' }, null)).toBe(true);
    expect(isBotChallenge(200, { 'cf-mitigated': 'challenge' }, null)).toBe(true);
  });

  it('recognizes a Cloudflare challenge page body', () => {
    expect(isBotChallenge(403, { server: 'cloudflare' }, CF_CHALLENGE_HTML)).toBe(true);
    expect(isBotChallenge(503, {}, CF_CHALLENGE_HTML)).toBe(true);
  });

  it('treats a bodyless 403 from Cloudflare as a block', () => {
    expect(isBotChallenge(403, { server: 'cloudflare', 'cf-ray': 'abc' }, null)).toBe(true);
  });

  it('does not flag real missing pages or ordinary errors', () => {
    expect(isBotChallenge(404, { server: 'cloudflare' }, '<h1>Not found</h1>')).toBe(false);
    expect(isBotChallenge(403, { server: 'nginx' }, '<h1>Forbidden</h1>')).toBe(false);
    expect(isBotChallenge(403, { server: 'cloudflare' }, '<h1>Forbidden</h1>')).toBe(false);
    expect(isBotChallenge(200, {}, CF_CHALLENGE_HTML)).toBe(false);
  });
});

describe('RequestProfile', () => {
  it('defaults to a browser-like Chrome header set', () => {
    const headers = new RequestProfile().headersFor();
    expect(headers['user-agent']).toBe(CHROME_USER_AGENT);
    expect(headers.accept).toContain('text/html');
    expect(headers['accept-language']).toBeDefined();
    expect(headers['sec-fetch-mode']).toBe('navigate');
    expect(headers['sec-ch-ua']).toContain('Chrome');
  });

  it('supports the bot preset without browser-only headers', () => {
    const headers = new RequestProfile({ userAgent: 'bot' }).headersFor();
    expect(headers['user-agent']).toBe(BOT_USER_AGENT);
    expect(headers['sec-fetch-mode']).toBeUndefined();
  });

  it('applies extra headers and merges jar cookies with a user cookie', () => {
    const profile = new RequestProfile({
      extraHeaders: { 'X-Audit-Key': 'secret', Cookie: 'a=1' },
    });
    const headers = profile.headersFor('cf_clearance=xyz');
    expect(headers['x-audit-key']).toBe('secret');
    expect(headers.cookie).toBe('a=1; cf_clearance=xyz');
  });
});

describe('parseHeaderLines', () => {
  it('parses "Name: value" lines and JSON objects', () => {
    expect(parseHeaderLines('X-One: 1\nX-Two: a:b')).toEqual({ 'x-one': '1', 'x-two': 'a:b' });
    expect(parseHeaderLines(['Cookie: k=v'])).toEqual({ cookie: 'k=v' });
    expect(parseHeaderLines('{"X-Key":"v"}')).toEqual({ 'x-key': 'v' });
    expect(parseHeaderLines(undefined)).toEqual({});
  });

  it('rejects malformed headers', () => {
    expect(() => parseHeaderLines('no separator')).toThrow();
    expect(() => parseHeaderLines('Bad Name: x')).toThrow();
  });
});
