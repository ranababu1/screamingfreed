/**
 * SQLite persistence for crawl sessions.
 *
 * Pages are written immediately (link rows reference them via foreign key);
 * link results are buffered and flushed inside a single transaction every
 * 50 rows or every 2 seconds, whichever comes first.
 */

import Database from 'better-sqlite3';
import type { LinkCsvRow } from '../reporting/csvExporter.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    http_status INTEGER,
    selector_used TEXT,
    fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY,
    page_id INTEGER NOT NULL REFERENCES pages(id),
    target_url TEXT NOT NULL,
    final_url TEXT,
    anchor_text TEXT,
    scope TEXT NOT NULL CHECK (scope IN ('internal','external')),
    http_status INTEGER,
    outcome TEXT NOT NULL,
    redirect_hops INTEGER DEFAULT 0,
    method_used TEXT,
    checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_links_status ON links(http_status);
CREATE INDEX IF NOT EXISTS idx_links_page ON links(page_id);
`;

const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 2_000;

export interface PageRecord {
  url: string;
  httpStatus: number | null;
  selectorUsed: string | null;
  fetchedAt: string;
}

export interface LinkRecord {
  pageId: number;
  targetUrl: string;
  finalUrl: string | null;
  anchorText: string;
  scope: string;
  httpStatus: number | null;
  outcome: string;
  redirectHops: number;
  methodUsed: string | null;
  checkedAt: string;
}

export interface OutcomeCount {
  outcome: string;
  count: number;
}

export interface BrokenLinkRow {
  target_url: string;
  http_status: number | null;
  outcome: string;
  occurrences: number;
  example_page: string;
}

export class SqliteStore {
  private readonly db: Database.Database;
  private readonly upsertPageStatement: Database.Statement;
  private readonly selectPageIdStatement: Database.Statement;
  private readonly insertLinkStatement: Database.Statement;
  private readonly insertLinksTransaction: (rows: LinkRecord[]) => void;
  private readonly pendingLinks: LinkRecord[] = [];
  private readonly flushTimer: NodeJS.Timeout;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.upsertPageStatement = this.db.prepare(
      `INSERT INTO pages (url, http_status, selector_used, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         http_status = excluded.http_status,
         selector_used = excluded.selector_used,
         fetched_at = excluded.fetched_at`,
    );
    this.selectPageIdStatement = this.db.prepare(
      'SELECT id FROM pages WHERE url = ?',
    );
    this.insertLinkStatement = this.db.prepare(
      `INSERT INTO links (
         page_id, target_url, final_url, anchor_text, scope,
         http_status, outcome, redirect_hops, method_used, checked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertLinksTransaction = this.db.transaction(
      (rows: LinkRecord[]): void => {
        for (const row of rows) {
          this.insertLinkStatement.run(
            row.pageId,
            row.targetUrl,
            row.finalUrl,
            row.anchorText,
            row.scope,
            row.httpStatus,
            row.outcome,
            row.redirectHops,
            row.methodUsed,
            row.checkedAt,
          );
        }
      },
    );
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    // Never keep the process alive just for the flush timer.
    this.flushTimer.unref();
  }

  /** Insert or refresh a page row and return its id (written immediately). */
  recordPage(record: PageRecord): number {
    this.upsertPageStatement.run(
      record.url,
      record.httpStatus,
      record.selectorUsed,
      record.fetchedAt,
    );
    const row = this.selectPageIdStatement.get(record.url) as
      | { id: number }
      | undefined;
    if (row === undefined) {
      throw new Error(`Failed to resolve page id for ${record.url}`);
    }
    return row.id;
  }

  /** Buffer a link result for batched, transactional insertion. */
  recordLink(record: LinkRecord): void {
    this.pendingLinks.push(record);
    if (this.pendingLinks.length >= BATCH_SIZE) {
      this.flush();
    }
  }

  /** Write all buffered link rows inside a single transaction. */
  flush(): void {
    if (this.pendingLinks.length === 0) {
      return;
    }
    const rows = this.pendingLinks.splice(0, this.pendingLinks.length);
    this.insertLinksTransaction(rows);
  }

  countPages(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM pages')
      .get() as { count: number };
    return row.count;
  }

  countLinks(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM links')
      .get() as { count: number };
    return row.count;
  }

  getOutcomeCounts(): OutcomeCount[] {
    return this.db
      .prepare(
        `SELECT outcome, COUNT(*) AS count FROM links
         GROUP BY outcome
         ORDER BY count DESC, outcome ASC`,
      )
      .all() as OutcomeCount[];
  }

  /**
   * Most frequently seen broken links (HTTP >= 400 or network failure),
   * with the number of occurrences and an example parent page.
   */
  getBrokenLinks(limit: number): BrokenLinkRow[] {
    return this.db
      .prepare(
        `SELECT l.target_url AS target_url,
                l.http_status AS http_status,
                l.outcome AS outcome,
                COUNT(*) AS occurrences,
                MIN(p.url) AS example_page
         FROM links l JOIN pages p ON p.id = l.page_id
         WHERE l.http_status IS NULL OR l.http_status >= 400
         GROUP BY l.target_url
         ORDER BY occurrences DESC, l.outcome ASC, l.target_url ASC
         LIMIT ?`,
      )
      .all(limit) as BrokenLinkRow[];
  }

  getAllLinkRows(): LinkCsvRow[] {
    return this.db
      .prepare(
        `SELECT p.url AS page_url,
                l.target_url AS target_url,
                l.final_url AS final_url,
                l.anchor_text AS anchor_text,
                l.scope AS scope,
                l.http_status AS http_status,
                l.outcome AS outcome,
                l.redirect_hops AS redirect_hops,
                l.method_used AS method_used,
                l.checked_at AS checked_at
         FROM links l JOIN pages p ON p.id = l.page_id
         ORDER BY p.id, l.id`,
      )
      .all() as LinkCsvRow[];
  }

  close(): void {
    clearInterval(this.flushTimer);
    this.flush();
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.close();
  }
}