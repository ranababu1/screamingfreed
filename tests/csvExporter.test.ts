import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CSV_COLUMNS,
  csvEscape,
  exportCsv,
  rowsToCsv,
} from '../src/reporting/csvExporter.js';
import type { LinkCsvRow } from '../src/reporting/csvExporter.js';

describe('csvEscape', () => {
  it('leaves simple values untouched', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape(301)).toBe('301');
  });

  it('quotes fields containing commas, quotes or newlines', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });

  it('renders null and undefined as empty fields', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });
});

describe('rowsToCsv', () => {
  it('writes the header row and escapes data fields', () => {
    const row: LinkCsvRow = {
      page_url: 'https://example.com/page',
      target_url: 'https://other.com/target',
      final_url: 'https://other.com/final',
      anchor_text: 'Read, "more"',
      scope: 'external',
      http_status: 301,
      outcome: '301',
      redirect_hops: 1,
      method_used: 'HEAD',
      checked_at: '2026-01-01T00:00:00.000Z',
    };
    const csv = rowsToCsv([row]);
    const [header, ...lines] = csv.split('\n');
    expect(header).toBe(CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"Read, ""more"""');
    expect(lines[0]).toContain('https://example.com/page');
  });
});

describe('exportCsv', () => {
  it('writes the file and returns the data row count', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sf-csv-'));
    const outPath = join(dir, 'report.csv');
    const count = exportCsv([], outPath);
    expect(count).toBe(0);
    const content = await readFile(outPath, 'utf8');
    expect(content.trim()).toBe(CSV_COLUMNS.join(','));
    await rm(dir, { recursive: true, force: true });
  });
});