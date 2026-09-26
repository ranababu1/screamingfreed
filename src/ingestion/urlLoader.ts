/**
 * Seed URL loading from the three supported sources, in order of precedence:
 *
 * 1. `--urls`   comma or newline separated list
 * 2. `--file`   path to a `.txt` or `.csv` file, one URL per line
 *               (for `.csv` only the first column is used)
 * 3. stdin      when neither of the above is provided
 *
 * This module only parses raw strings; normalization, validation and
 * deduplication happen in `urlNormalizer` during the crawl setup.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

export interface SeedSource {
  urls?: string;
  file?: string;
}

/** Load raw seed URLs from the highest-precedence available source. */
export async function loadSeedUrls(source: SeedSource): Promise<string[]> {
  if (source.urls !== undefined && source.urls.trim().length > 0) {
    return parseUrlList(source.urls);
  }
  if (source.file !== undefined && source.file.trim().length > 0) {
    return loadFromFile(source.file.trim());
  }
  return readStdin();
}

/** Split a comma or newline separated URL list into trimmed entries. */
export function parseUrlList(input: string): string[] {
  return input
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function loadFromFile(filePath: string): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(
      `Unable to read seed file "${filePath}": ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const isCsv = extname(filePath).toLowerCase() === '.csv';
  const urls: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    urls.push(isCsv ? firstCsvColumn(line) : line);
  }
  return urls;
}

/** Take the first comma-separated column of a CSV line and strip quotes. */
function firstCsvColumn(line: string): string {
  const column = (line.split(',')[0] ?? '').trim();
  if (column.length >= 2 && column.startsWith('"') && column.endsWith('"')) {
    return column.slice(1, -1);
  }
  return column;
}

async function readStdin(): Promise<string[]> {
  if (process.stdin.isTTY === true) {
    throw new Error(
      'No seed URLs provided. Pass --urls <list> or --file <path>, or pipe URLs through stdin.',
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return parseUrlList(Buffer.concat(chunks).toString('utf8'));
}