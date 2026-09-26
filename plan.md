# ScreamingFreed: WordPress Link Auditor (Node.js CLI)

## Role

You are a senior Node.js engineer. Build a command-line tool called **ScreamingFreed**, a lightweight alternative to Screaming Frog focused on one job: auditing hyperlinks inside the article body of WordPress pages. Favor clarity and correctness over feature breadth. Do not add features that are not listed here.

## Stack and constraints

- Node.js 20 LTS or newer, TypeScript, ESM modules, strict mode
- Dependencies allowed: `cheerio` (HTML parsing), `better-sqlite3` (storage), `undici` (HTTP, already bundled with Node but pin the package for `Agent` control), `p-limit` (concurrency), `commander` (CLI parsing), `chalk` (colors), `cli-progress` (progress bar), `tldts` (registrable domain comparison)
- Dev dependencies: `typescript`, `tsx`, `vitest`, `eslint`
- No external services, no browser automation, no JavaScript rendering
- Support graceful shutdown on `SIGINT`: stop scheduling new requests, flush pending database writes, print the summary
- Publish a `bin` entry so `npx screamingfreed` works after `npm install`

## Functional requirements

### 1. Ingestion and pre-processing

- Accept seed URLs from three sources: `--urls` (comma or newline separated), `--file` (path to `.txt` or `.csv`, one URL per line, first CSV column used), or stdin when neither is given
- Normalize every URL: trim whitespace, strip fragment (`#...`), lowercase scheme and host, remove default ports, resolve relative URLs against the page they were found on (use the WHATWG `URL` class)
- Deduplicate after normalization, preserving first-seen order
- Skip and log any input that is not a valid absolute `http` or `https` URL

### 2. WordPress content isolation

- Fetch each seed page with GET and load into cheerio
- Locate the main article body by trying these selectors in order and using the first match: `article .entry-content`, `.entry-content`, `.post-content`, `article`, `#content`, `main`
- If nothing matches, fall back to `body` after removing boilerplate: `header`, `footer`, `nav`, `aside`, `.sidebar`, `#sidebar`, `.widget`, `.widget-area`, `.menu`, `[role=navigation]`, `[role=banner]`, `[role=contentinfo]`
- Record which selector strategy was used for each page (store it in the database)

### 3. Hyperlink extraction and classification

- Extract `href` values from `<a>` elements strictly inside the isolated body
- Discard non-crawlable schemes: `mailto:`, `tel:`, `javascript:`, `data:`, `sms:`, and empty or `#`-only hrefs
- Normalize each link the same way as seed URLs
- Classify each link as `internal` (registrable domain from `tldts` matches the seed page host) or `external`
- Deduplicate links per parent page

### 4. Asynchronous checking and rate limiting

- Implement a token bucket rate limiter per host in a small class (no extra library); default 2 requests per second per host, configurable with `--rps`
- Bound global concurrency with `p-limit`; default 10, configurable with `--concurrency`
- Use a single shared `undici.Agent` with connection pooling, `maxRedirections: 0` so redirect chains are visible, per-request timeout via `AbortSignal.timeout`, default 15 seconds configurable with `--timeout`
- Send a realistic `User-Agent` header (`ScreamingFreed/1.0 (+https://example.com/bot)`)
- Check each link with HEAD first; if the response is `405` or `501`, or the socket closes without a response, retry once with GET
- Follow redirects manually up to 5 hops and record the final status and final URL
- Capture outcomes as distinct categories: HTTP status code (200, 3xx, 404, 429, 5xx, etc.), `timeout`, `dns_failure` (`ENOTFOUND`, `EAI_AGAIN`), `connection_refused` (`ECONNREFUSED`), `connection_reset` (`ECONNRESET`), `tls_error`, `too_many_redirects`, `unknown`
- On `429`, honor `Retry-After` if present and retry once, otherwise back off 5 seconds and retry once

### 5. Persistence and console feedback

- Create a SQLite database at `./ScreamingFreedSession.db` (override with `--db`), created on startup if missing, WAL mode enabled
- Schema:

```sql
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
```

- Write results as they arrive using prepared statements wrapped in `db.transaction()`, batch of 50 or every 2 seconds, whichever comes first
- Console output with chalk: one line per checked link, color coded (green 2xx, yellow 3xx, red 4xx/5xx, magenta network errors), plus a `cli-progress` bar showing pages processed and links checked
- On completion print a summary table (`console.table` is acceptable): total pages, total links, count per outcome category, and the top 20 broken links with their parent page
- `--export report.csv` writes all rows of the `links` table joined with the parent page URL (escape fields correctly, no CSV library needed)

## CLI

```
screamingfreed [--urls <list>] [--file <path>] [--rps 2] [--concurrency 10]
               [--timeout 15] [--db ScreamingFreedSession.db] [--export report.csv]
               [--internal-only | --external-only] [--verbose]
```

## Project structure

```
package.json                  "type": "module", bin -> dist/cli.js
tsconfig.json
src/
  cli.ts                      commander wiring only
  ingestion/urlLoader.ts
  ingestion/urlNormalizer.ts
  extraction/contentIsolator.ts
  extraction/linkExtractor.ts
  crawling/tokenBucket.ts
  crawling/linkChecker.ts
  crawling/types.ts
  storage/sqliteStore.ts
  reporting/consoleReporter.ts
  reporting/csvExporter.ts
tests/                        vitest, one file per module
```

Scripts: `build` (tsc), `dev` (tsx src/cli.ts), `test` (vitest run), `lint` (eslint).

## Tests (vitest)

- `urlNormalizer`: fragment stripping, relative resolution, dedupe, invalid input rejection
- `contentIsolator`: selector priority order and boilerplate fallback, using inline HTML fixtures
- `linkExtractor`: scheme filtering and internal/external classification including `www.` and subdomain handling
- `tokenBucket`: never exceeds configured rate under concurrent load (use fake timers)
- `linkChecker`: HEAD to GET fallback on 405, redirect chain recording, timeout categorization (use `undici.MockAgent`, no real network)

## Acceptance criteria

1. `npm run build` and `npm run lint` succeed with zero errors
2. `npm test` passes
3. Running against three seed URLs produces a populated `ScreamingFreedSession.db` and a readable console summary
4. `SIGINT` stops cleanly and the database remains queryable with everything checked so far
5. The tool never sends more requests per second to a host than `--rps`

## Non-goals

No JavaScript rendering, no sitemap discovery, no recursive crawling beyond the seed pages, no GUI, no authentication support.

## Working style

Start by scaffolding the project and the SQLite schema, then implement features in the order listed above. After each feature, run the tests. Ask before introducing any package not listed here.
