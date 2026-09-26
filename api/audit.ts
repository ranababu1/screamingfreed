/**
 * Vercel serverless function: audits one small batch of seed URLs and
 * returns the results as JSON. The browser UI drives long audits by
 * calling this endpoint once per batch (see app.js).
 *
 * POST /api/audit
 * body: { seedUrls: string[], skipTargets?: string[], requestsPerSecond?,
 *         concurrency?, timeoutSeconds?, scopeFilter?, deadlineMs? }
 * Optional: x-audit-token header when the AUDIT_TOKEN env var is set.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runAuditBatch } from '../src/audit/batchAuditor.js';
import type { LinkScope } from '../src/crawling/types.js';

const MAX_SEEDS_PER_REQUEST = 12;
const MAX_VALUE_LENGTH = 2_048;
const MAX_SKIP_TARGETS = 5_000;

interface AuditRequestBody {
  [key: string]: unknown;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function parseStringArray(value: unknown, maxLength: number): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return null;
    }
    const trimmed = entry.trim().slice(0, maxLength);
    if (trimmed.length > 0) {
      result.push(trimmed);
    }
  }
  return result;
}

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

  let body: AuditRequestBody;
  if (typeof req.body === 'string' && req.body.length > 0) {
    try {
      body = JSON.parse(req.body) as AuditRequestBody;
    } catch {
      res.status(400).json({ error: 'Request body must be valid JSON.' });
      return;
    }
  } else if (typeof req.body === 'object' && req.body !== null) {
    body = req.body as AuditRequestBody;
  } else {
    res.status(400).json({ error: 'Request body must be JSON.' });
    return;
  }

  const seedUrls = parseStringArray(body.seedUrls, MAX_VALUE_LENGTH);
  if (seedUrls === null || seedUrls.length === 0) {
    res.status(400).json({ error: 'seedUrls must be a non-empty array of URL strings.' });
    return;
  }
  if (seedUrls.length > MAX_SEEDS_PER_REQUEST) {
    res
      .status(400)
      .json({ error: `At most ${MAX_SEEDS_PER_REQUEST} seed URLs per request; batch client-side.` });
    return;
  }

  let skipTargets: string[] = [];
  if (body.skipTargets !== undefined) {
    const parsed = parseStringArray(body.skipTargets, MAX_VALUE_LENGTH);
    if (parsed === null) {
      res.status(400).json({ error: 'skipTargets must be an array of strings.' });
      return;
    }
    skipTargets = parsed.slice(0, MAX_SKIP_TARGETS);
  }

  let scopeFilter: LinkScope | undefined;
  const scopeValue = body.scopeFilter;
  if (scopeValue === 'internal' || scopeValue === 'external') {
    scopeFilter = scopeValue;
  } else if (scopeValue !== undefined && scopeValue !== null && scopeValue !== '') {
    res.status(400).json({ error: 'scopeFilter must be "internal" or "external".' });
    return;
  }

  try {
    const result = await runAuditBatch({
      seedUrls,
      skipTargets,
      requestsPerSecond: clampNumber(body.requestsPerSecond, 2, 0.1, 20),
      concurrency: clampNumber(body.concurrency, 10, 1, 10),
      timeoutSeconds: clampNumber(body.timeoutSeconds, 10, 1, 15),
      scopeFilter,
      deadlineMs: clampNumber(body.deadlineMs, 35_000, 1_000, 40_000),
    });
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Audit batch failed.',
    });
  }
}