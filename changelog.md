# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-26

Initial release: a WordPress article-body link auditor with both a Node.js CLI
and a Vercel-deployable web UI.

### Added

**CLI (`screamingfreed`, usable via `npx` or `npm run dev:cli`)**

- Seed URL ingestion from `--urls` (comma/newline separated), `--file`
  (`.txt`, or `.csv` using the first column), or stdin when neither is given.
- URL normalization via the WHATWG `URL` parser: whitespace trimming, fragment
  stripping, lowercase scheme/host, default-port removal, relative-URL
  resolution; first-seen dedupe with logging of invalid inputs.
- WordPress article-body isolation with a prioritized selector chain
  (`article .entry-content` → `.entry-content` → `.post-content` → `article`
  → `#content` → `main`) and a `<body>` fallback after removing boilerplate
  (header, footer, nav, aside, sidebars, widgets, menus, ARIA landmark
  roles); the winning strategy is stored per page.
- Hyperlink extraction strictly inside the isolated body: non-crawlable
  scheme filtering (`mailto:`, `tel:`, `javascript:`, `data:`, `sms:`,
  empty/`#`-only hrefs), per-page dedupe, whitespace-collapsed anchor text,
  and internal/external classification via `tldts` registrable domains
  (apex/www/subdomain aware, exact-host fallback for localhost and IPs).
- Asynchronous checking: per-host token-bucket rate limiter (capacity one, so
  `--rps` is never exceeded; default 2), global concurrency bounded by
  `p-limit` (default 10), a single shared pooled undici Agent, and per-request
  timeouts via `AbortSignal.timeout` (default 15s, `--timeout`).
- HEAD-first checks with GET fallback (405, 501, or socket closed without a
  response), manual redirect following up to 5 hops with final status/URL
  recording, `too_many_redirects` detection, and 429 handling that honors
  `Retry-After` (capped at 60s; 5s default backoff) with a single retry.
- Outcome categories: numeric HTTP status, `timeout`, `dns_failure`,
  `connection_refused`, `connection_reset`, `tls_error`, `too_many_redirects`,
  `unknown` — classified by walking error `cause` chains.
- SQLite persistence (WAL mode, documented schema + indexes): page rows
  upserted immediately, link results buffered and flushed inside transactions
  every 50 rows or 2 seconds (whichever comes first).
- Console experience: chalk color-coded lines per link (green 2xx, yellow 3xx,
  red 4xx/5xx, magenta network errors), cli-progress bars for pages/links, and
  a summary with totals, per-outcome counts and the top 20 broken links.
- `--export report.csv`: RFC 4180-escaped CSV of all link rows joined with
  their parent page.
- Graceful SIGINT shutdown: stops scheduling new requests, lets in-flight
  work settle, flushes the database and prints the summary (exit code 130);
  a second Ctrl+C force-exits.

**Web UI + Vercel serverless mode**

- `src/audit/batchAuditor.ts`: the same audit engine in an in-memory,
  deadline-aware batch form for serverless environments — reports processed,
  partially processed and unprocessed seeds and skips already-checked targets.
- `api/audit.ts` (`POST /api/audit`): input validation (≤ 12 seeds per
  request, clamped rate/concurrency/timeout options) and optional `AUDIT_TOKEN`
  protection via the `x-audit-token` header.
- Static UI (`index.html`, `app.js`): CSV/TXT upload or paste, browser-side
  batching with retries, live progress bar and color-coded log, summary
  tables, CSV/JSON download — results stay in the browser; nothing is stored
  server-side.
- `vercel.json` with a framework-agnostic build (UI copied into `public/`),
  60s function `maxDuration`; `.vercelignore` keeps private files (URL lists,
  docs, tests, CLI build output) out of deployments.
- `npm run dev`: local server at http://127.0.0.1:3000 serving the UI and the
  real API handler (no Vercel login required).

**Tests & tooling**

- 64 vitest tests across 10 files: URL normalization, seed loading, content
  isolation, link extraction/classification, token-bucket rate guarantees
  (fake timers), link checking with `undici.MockAgent` (HEAD→GET fallback,
  redirect chains, timeouts, 429 retries), batch auditing, SQLite batching
  and queries, and CSV escaping/export.
- ESLint (flat config), strict TypeScript, and `typecheck:api` for the
  serverless function.

### Fixed

- Windows exit crash (0xC0000409): `process.exit()` immediately after undici
  activity crashed the process — replaced with `process.exitCode` plus
  guaranteed agent disposal so the event loop drains naturally.
- Final summary and CSV export missed the last buffered link rows — results
  are now flushed before reporting.
- `ClientDestroyedError` when the shared undici Agent was disposed twice —
  disposal is now idempotent and the duplicate call was removed.
- `undici` v7 removed the `maxRedirections` option — dropped it; undici never
  follows redirects by default, which is exactly what manual redirect-chain
  traversal requires.
- Local dev server returned 404 for `/` (root path was not mapped to
  `index.html`).
- Vercel build failed with "No Output Directory named public" after framework
  auto-detection — the build now explicitly produces `public/` and pins
  `buildCommand`/`outputDirectory` in `vercel.json`.

### Changed

- `npm run dev` now starts the web UI; the CLI moved to `npm run dev:cli`.
- `.gitignore` and `.vercelignore` exclude personal seed lists (`allurls.*`)
  and generated `public/` output.
- Generalized the UI copy (removed WordPress-specific wording from the page
  title and header).
- README covering CLI usage, options, Vercel deployment, token hardening and
  local development.
