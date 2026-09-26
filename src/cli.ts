#!/usr/bin/env node
/**
 * ScreamingFreed CLI — commander wiring only; all logic lives in the
 * ingestion, extraction, crawling, storage and reporting modules plus the
 * orchestrator in `crawler.ts`.
 */

import { Command } from 'commander';
import { runCrawl } from './crawler.js';
import type { LinkScope } from './crawling/types.js';

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer, received "${value}"`);
  }
  return parsed;
}

function parsePositiveNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive number, received "${value}"`);
  }
  return parsed;
}

const program = new Command();

program
  .name('screamingfreed')
  .description('Audit hyperlinks inside the article body of WordPress pages.')
  .version('1.0.0')
  .option('-u, --urls <urls>', 'comma or newline separated seed URLs (takes precedence over --file)')
  .option('-f, --file <path>', 'path to a .txt or .csv file with seed URLs (one per line, first CSV column used)')
  .option('--rps <rate>', 'maximum requests per second per host', '2')
  .option('--concurrency <n>', 'maximum concurrent requests overall', '10')
  .option('--timeout <seconds>', 'per-request timeout in seconds', '15')
  .option('--db <path>', 'SQLite session database path', 'ScreamingFreedSession.db')
  .option('--export <path>', 'write all link results to a CSV file when the audit finishes')
  .option('--internal-only', 'only check internal links')
  .option('--external-only', 'only check external links')
  .option('--verbose', 'print verbose diagnostics')
  .action(async (options) => {
    if (options.internalOnly && options.externalOnly) {
      throw new Error('--internal-only and --external-only are mutually exclusive');
    }
    let scopeFilter: LinkScope | undefined;
    if (options.internalOnly) {
      scopeFilter = 'internal';
    }
    if (options.externalOnly) {
      scopeFilter = 'external';
    }
    const exitCode = await runCrawl({
      urls: options.urls,
      file: options.file,
      dbPath: options.db,
      exportPath: options.export,
      requestsPerSecond: parsePositiveNumber(options.rps, '--rps'),
      concurrency: parsePositiveInt(options.concurrency, '--concurrency'),
      timeoutSeconds: parsePositiveInt(options.timeout, '--timeout'),
      scopeFilter,
      verbose: options.verbose === true,
    });
    // Set the code and let the event loop drain naturally: calling
    // process.exit() while pooled sockets are tearing down can crash on
    // Windows (exit code 0xC0000409), and every handle is closed by the
    // time runCrawl resolves.
    process.exitCode = exitCode;
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
});