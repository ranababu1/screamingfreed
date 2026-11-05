/**
 * Vercel serverless function: fetches a sitemap (or discovers one for a
 * site address) and returns the page URLs it lists, so the browser UI can
 * audit them. Browsers cannot fetch other sites' sitemaps directly (CORS).
 *
 * POST /api/sitemap
 * body: { sitemapUrl: string, requestHeaders?: string }
 * Optional: x-audit-token header when the AUDIT_TOKEN env var is set.
 * Uses the same SCREAMINGFREED_USER_AGENT / _HEADERS / _PROXY variables as
 * /api/audit.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { parseHeaderLines } from '../src/crawling/requestProfile.js';
import { SitemapError, loadSitemap } from '../src/ingestion/sitemapLoader.js';

const MAX_URL_LENGTH = 2_048;
const MAX_REQUEST_HEADERS_LENGTH = 4_096;
const MAX_URLS = 50_000;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST requests are supported.' });
    return;
  }

  const token = process.env.AUDIT_TOKEN;
  if (token !== undefined && token.length > 0) {
    const provided = req.headers['x-audit-token'];
    const providedToken = Array.isArray(provided) ? provided[0] : provided;
    if (providedToken !== token) {
      res.status(401).json({ error: 'Invalid or missing x-audit-token header.' });
      return;
    }
  }

  let body: Record<string, unknown>;
  try {
    body =
      typeof req.body === 'string'
        ? (JSON.parse(req.body) as Record<string, unknown>)
        : ((req.body ?? {}) as Record<string, unknown>);
  } catch {
    res.status(400).json({ error: 'Request body must be valid JSON.' });
    return;
  }

  const sitemapUrl = typeof body.sitemapUrl === 'string' ? body.sitemapUrl.trim() : '';
  if (sitemapUrl.length === 0 || sitemapUrl.length > MAX_URL_LENGTH) {
    res.status(400).json({ error: 'sitemapUrl must be a sitemap URL or site address.' });
    return;
  }

  let headers: Record<string, string>;
  try {
    headers = parseHeaderLines(process.env.SCREAMINGFREED_HEADERS);
    if (typeof body.requestHeaders === 'string' && body.requestHeaders.trim().length > 0) {
      if (body.requestHeaders.length > MAX_REQUEST_HEADERS_LENGTH) {
        res.status(400).json({ error: 'requestHeaders is too long.' });
        return;
      }
      Object.assign(headers, parseHeaderLines(body.requestHeaders));
    }
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Invalid request headers.',
    });
    return;
  }
  for (const name of ['host', 'content-length', 'connection', 'transfer-encoding']) {
    delete headers[name];
  }

  try {
    const result = await loadSitemap(sitemapUrl, {
      userAgent: process.env.SCREAMINGFREED_USER_AGENT,
      headers,
      proxyUrl: process.env.SCREAMINGFREED_PROXY,
      timeoutMs: 15_000,
      maxUrls: MAX_URLS,
      deadlineMs: 45_000,
    });
    res.status(200).json(result);
  } catch (error) {
    const status = error instanceof SitemapError ? 422 : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Could not load the sitemap.',
    });
  }
}
