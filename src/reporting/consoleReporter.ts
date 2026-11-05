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
import type {
  BrokenLinkRow,
  FailedPageRow,
  OutcomeCount,
} from '../storage/sqliteStore.js';

export interface AuditSummary {
  totalPages: number;
  totalLinks: number;
  outcomeCounts: OutcomeCount[];
  brokenLinks: BrokenLinkRow[];
  failedPageCount: number;
  failedPages: FailedPageRow[];
  /** Link rows a bot-protection layer refused (unverified, not broken). */
  blockedLinkCount?: number;
  browserFallbackEnabled?: boolean;
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
    if (summary.failedPageCount > 0) {
      this.warn(
        `  ${summary.failedPageCount} page(s) could not be fetched or had no ` +
          'recognizable article body — their links were never checked ' +
          '(often a firewall/bot-protection block; check the status codes below).',
      );
      console.table(summary.failedPages);
      this.info('');
    }
    const blockedPages = summary.failedPages.filter(
      (page) => page.reason === 'bot_protection',
    ).length;
    const blockedLinks = summary.blockedLinkCount ?? 0;
    if (blockedPages > 0 || blockedLinks > 0) {
      this.warn(
        `  Bot protection (e.g. Cloudflare) blocked ${blockedPages} page(s) and ` +
          `${blockedLinks} link check(s). Blocked links are listed as ` +
          '"bot_protection" (unverified), not as broken.',
      );
      for (const hint of botProtectionHints(summary.browserFallbackEnabled === true)) {
        this.warn(`    - ${hint}`);
      }
      this.info('');
    }
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

/** Ways around a bot-protection block, most effective first. */
export function botProtectionHints(browserFallbackEnabled: boolean): string[] {
  const hints: string[] = [];
  if (browserFallbackEnabled) {
    hints.push(
      'Retry with --render headful to solve interactive challenges in a visible browser window.',
    );
  } else {
    hints.push(
      'Enable the real-browser fallback: npm install playwright && ' +
        'npx playwright install chromium (then it is used automatically, or force --render headful).',
    );
  }
  hints.push(
    'For your own site: add a Cloudflare WAF "Skip" rule for a secret header and pass it ' +
      'with --header "X-Audit-Key: <secret>" (or allowlist your IP).',
  );
  hints.push(
    'Run from a residential/office IP (datacenter IPs score as bots) or route through ' +
      '--proxy http://user:pass@host:port.',
  );
  hints.push(
    'Reuse a browser session: copy the cf_clearance cookie and your browser\'s exact ' +
      'User-Agent into --cookie and --user-agent (same IP required).',
  );
  return hints;
}

/** One console line per checked link, color coded by result class. */
function formatLinkLine(result: LinkCheckResult): string {
  const status =
    result.outcome === 'bot_protection'
      ? `blocked ${result.httpStatus ?? ''}`.trim()
      : result.httpStatus !== null
        ? String(result.httpStatus)
        : result.outcome;
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
  if (result.outcome === 'bot_protection') {
    return chalk.blue;
  }
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