/**
 * CSV export of the `links` table joined with the parent page URL.
 * Fields are escaped per RFC 4180 (no CSV library needed).
 */

import { writeFileSync } from 'node:fs';

export interface LinkCsvRow {
  page_url: string;
  target_url: string;
  final_url: string | null;
  anchor_text: string;
  scope: string;
  http_status: number | null;
  outcome: string;
  redirect_hops: number;
  method_used: string | null;
  checked_at: string;
}

export const CSV_COLUMNS = [
  'page_url',
  'target_url',
  'final_url',
  'anchor_text',
  'scope',
  'http_status',
  'outcome',
  'redirect_hops',
  'method_used',
  'checked_at',
] as const;

/** Escape a single CSV field per RFC 4180. */
export function csvEscape(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Render rows (including the header line) as CSV text. */
export function rowsToCsv(rows: LinkCsvRow[]): string {
  const lines: string[] = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((column) => csvEscape(row[column])).join(','));
  }
  return lines.join('\n');
}

/** Write all rows to `outPath`. Returns the number of data rows written. */
export function exportCsv(rows: LinkCsvRow[], outPath: string): number {
  writeFileSync(outPath, `${rowsToCsv(rows)}\n`, 'utf8');
  return rows.length;
}