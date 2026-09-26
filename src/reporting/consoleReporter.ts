/**
 * Console reporting: color-coded per-link lines, progress bars and the
 * final summary table.
 *
 * Progress bars (cli-progress) render only on a TTY; on non-interactive
 * terminals the tool prints plain per-link lines and the summary instead.
 */

import chalk from 'chalk';
import cliProgress from 'cli-progress';
import type { LinkCheckResult } from '../crawling/types.js';
import type { BrokenLinkRow, OutcomeCount } from '../storage/sqliteStore.js';

export interface AuditSummary {
  totalPages: number;
  totalLinks: number;
  outcomeCounts: OutcomeCount[];
  brokenLinks: BrokenLinkRow[];
}

export class ConsoleReporter {
  private readonly useBars: boolean;
  private multiBar: cliProgress.MultiBar | null = null;
  private pageBar: cliProgress.Bar | null = null;
  private linkBar: cliProgress.Bar | null = null;

  constructor(private readonly verboseEnabled: boolean) {
    this.useBars = process.stderr.isTTY === true;
  }

  info(message: string): void {
    process.stdout.write(`${message}\n`);
  }

  warn(message: string): void {
    process.stderr.write(`${chalk.yellow(message)}\n`);
  }

  error(message: string): void {
    process.stderr.write(`${chalk.red(message)}\n`);
  }

  verbose(message: string): void {
    if (this.verboseEnabled) {
      process.stderr.write(`${chalk.gray(message)}\n`);
    }
  }

  startBars(totalPages: number): void {
    if (!this.useBars) {
      return;
    }
    this.multiBar = new cliProgress.MultiBar(
      {
        format: '{name} |{bar}| {value}/{total}',
        clearOnComplete: false,
        hideCursor: true,
      },
      cliProgress.Presets.shades_classic,
    );
    this.pageBar = this.multiBar.create(totalPages, 0, { name: 'Pages' });
    this.linkBar = this.multiBar.create(0, 0, { name: 'Links' });
  }

  setLinkTotal(total: number): void {
    this.linkBar?.setTotal(total);
  }

  pageDone(): void {
    this.pageBar?.increment();
  }

  linkChecked(result: LinkCheckResult): void {
    this.writeLine(formatLinkLine(result));
    this.linkBar?.increment();
  }

  private writeLine(line: string): void {
    if (this.multiBar !== null) {
      this.multiBar.log(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }

  stopBars(): void {
    this.multiBar?.stop();
    this.multiBar = null;
    this.pageBar = null;
    this.linkBar = null;
  }

  printSummary(summary: AuditSummary): void {
    this.info('');
    this.info(chalk.bold('ScreamingFreed audit summary'));
    this.info(`  Pages audited: ${chalk.cyan(String(summary.totalPages))}`);
    this.info(`  Links checked: ${chalk.cyan(String(summary.totalLinks))}`);
    this.info('');
    if (summary.outcomeCounts.length === 0) {
      this.info('  No links were checked.');
    } else {
      this.info(chalk.bold('Outcome breakdown:'));
      console.table(summary.outcomeCounts);
    }
    this.info('');
    if (summary.brokenLinks.length === 0) {
      this.info(chalk.green('  No broken links found.'));
    } else {
      this.info(chalk.bold(`Broken links (top ${summary.brokenLinks.length}):`));
      console.table(summary.brokenLinks);
    }
    this.info('');
  }
}

/** One console line per checked link, color coded by result class. */
function formatLinkLine(result: LinkCheckResult): string {
  const status =
    result.httpStatus !== null ? String(result.httpStatus) : result.outcome;
  const parts = [colorFor(result)(status.padEnd(14)), result.targetUrl];
  if (result.finalUrl !== null && result.finalUrl !== result.targetUrl) {
    parts.push(chalk.gray(`-> ${result.finalUrl}`));
  }
  if (result.redirectHops > 0) {
    parts.push(
      chalk.gray(
        `(${result.redirectHops} redirect${result.redirectHops === 1 ? '' : 's'})`,
      ),
    );
  }
  return parts.join(' ');
}

/** green 2xx, yellow 3xx, red 4xx/5xx, magenta network errors. */
function colorFor(result: LinkCheckResult): (text: string) => string {
  if (result.httpStatus === null) {
    return chalk.magenta;
  }
  if (result.httpStatus < 300) {
    return chalk.green;
  }
  if (result.httpStatus < 400) {
    return chalk.yellow;
  }
  return chalk.red;
}