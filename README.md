# ScreamingFreed

A lightweight command-line alternative to Screaming Frog focused on one job:
auditing the hyperlinks inside the article/main content of web pages
(WordPress-aware selectors first, generic `article`/`main`/`<body>` fallbacks
for any other site).

## Usage

```bash
screamingfreed [--urls <list>] [--file <path>] [--rps 2] [--concurrency 10]
               [--timeout 15] [--db ScreamingFreedSession.db] [--export report.csv]
               [--internal-only | --external-only] [--verbose]
               [--user-agent chrome|bot|<ua>] [-H "Name: value"]... [--cookie <c>]
               [--proxy <url>] [--render auto|headless|headful|off]
```

Examples:

```bash
# Audit specific pages and export a CSV report
screamingfreed --urls "https://example.com/post-1,https://example.com/post-2" --export report.csv

# Read seed URLs from a file (one URL per line; for .csv the first column is used)
screamingfreed --file seeds.csv --verbose

# Pipe seed URLs through stdin
cat seeds.txt | screamingfreed
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--urls <list>` | - | Seed URLs, comma or newline separated (takes precedence over `--file`) |
| `--file <path>` | - | Path to a `.txt` or `.csv` file with seed URLs (one per line, first CSV column used) |
| `--rps <rate>` | `2` | Maximum requests per second per host |
| `--concurrency <n>` | `10` | Maximum concurrent requests overall |
| `--timeout <seconds>` | `15` | Per-request timeout in seconds |
| `--db <path>` | `ScreamingFreedSession.db` | SQLite session database path |
| `--export <path>` | - | Write all link results to a CSV file when the audit finishes |
| `--internal-only` | - | Only check internal links |
| `--external-only` | - | Only check external links |
| `--verbose` | - | Print verbose diagnostics (selector strategy, retries, skips) |
| `--user-agent <ua>` | `chrome` | `chrome` (browser-like headers), `bot` (identifying UA) or a literal UA string. Env: `SCREAMINGFREED_USER_AGENT` |
| `-H, --header <h>` | - | Extra request header `"Name: value"`, repeatable. Env: `SCREAMINGFREED_HEADERS` (one per line, or JSON) |
| `--cookie <cookie>` | - | Cookie header to send (e.g. `cf_clearance=...`) |
| `--proxy <url>` | - | Route all requests through an HTTP(S) proxy. Env: `SCREAMINGFREED_PROXY` |
| `--render <mode>` | `auto` | Real-browser fallback for bot-protected responses: `auto` (when Playwright is installed), `headless`, `headful` (visible window, solve checks by hand), `off` |

When neither `--urls` nor `--file` is given, seed URLs are read from stdin.

Pressing `Ctrl+C` once stops scheduling new requests, flushes pending database
writes and prints the summary; pressing it twice exits immediately.

## Sites behind Cloudflare / bot protection

Cloudflare (and Akamai, Sucuri, Wordfence, Imperva, DataDome...) block or
challenge clients that do not look like a browser. ScreamingFreed handles
this in layers, from cheapest to most robust:

1. **Browser-like requests (always on).** Requests carry the header set of
   desktop Chrome (`User-Agent`, `Accept`, `Accept-Language`,
   `Sec-Fetch-*`, `sec-ch-ua`) — the same idea as Screaming Frog's Chrome UA
   preset. A HEAD rejected with 400/403/405/406/501 is retried with GET,
   because many WAFs refuse HEAD outright.
2. **Challenge detection.** Challenge/block pages ("Just a moment...",
   `cf-mitigated: challenge`, WAF block pages) are reported with the
   distinct outcome **`bot_protection`** — *unverified*, not broken — so a
   blocked audit no longer looks like hundreds of broken 403 links or a
   clean report.
3. **Real-browser fallback (CLI).** Only blocked requests are re-done in
   Chromium via Playwright, which runs Cloudflare's JavaScript challenge
   like a visitor's browser (Screaming Frog's JavaScript rendering mode
   works the same way). The cookies the browser earns (`cf_clearance`) are
   then reused for plain HTTP requests to that host, so the rest of the
   crawl stays fast. Enable it once:

   ```bash
   npm install playwright && npx playwright install chromium
   ```

   It is then used automatically (`--render auto`). If a site shows an
   interactive check (Turnstile checkbox), run with `--render headful` and
   tick it in the window that opens; the clearance is reused afterwards.
4. **Allow the crawler on your own site (most reliable).** In Cloudflare,
   add a WAF custom rule with action *Skip* (all remaining custom rules,
   rate limiting, managed rules, Super Bot Fight Mode) matching a secret
   header, then pass it: `-H "X-Audit-Key: <secret>"` (CLI) or the "Extra
   request headers" box (web UI). Alternatively allowlist your IP under
   *Security → WAF → Tools*.
5. **Change where requests come from.** Datacenter IPs (Vercel, cloud VMs)
   are scored as bots far more often than home/office connections. Run the
   CLI locally, or route through a residential proxy with `--proxy` /
   `SCREAMINGFREED_PROXY`.
6. **Reuse your own browser session.** Open the site in your browser, copy
   the `cf_clearance` cookie and your browser's exact User-Agent, and pass
   `--cookie "cf_clearance=..." --user-agent "<that UA>"` (clearance is tied
   to IP + User-Agent, so run from the same network).

The Vercel web UI cannot run a browser, so for it use (4) and/or (5): set
`SCREAMINGFREED_PROXY`, `SCREAMINGFREED_HEADERS` or
`SCREAMINGFREED_USER_AGENT` as project environment variables, or enter a
header in the UI's "Bot protection workarounds" section.

## Development

```bash
npm install
npm run build          # tsc -> dist/
npm test               # vitest
npm run lint           # eslint
npm run typecheck:api  # type-check the Vercel serverless function
npm run dev            # web UI + local API at http://127.0.0.1:3000
npm run dev:cli -- --file allurls.csv   # run the CLI without building first
```

## Web UI on Vercel

A minimal web UI is included: upload (or paste) a CSV/TXT of seed URLs in the
browser and download the resulting CSV/JSON report.

The browser parses the file, chunks the list into small batches and calls
`POST /api/audit` — a Vercel serverless function (`api/audit.ts`) that runs the
same audit engine (`src/audit/batchAuditor.ts`) **in memory** and returns the
results as JSON. This design fits serverless constraints:

- nothing is written to disk (serverless filesystems are read-only and
  ephemeral, so the CLI's SQLite store is intentionally not used; the browser
  holds the results)
- each batch must finish inside the function's time limit, so the browser
  retries partial/unprocessed seeds and skips already-checked targets
- per request: at most 12 seeds, soft deadline 40s, function `maxDuration` 60s
  (Hobby tier compatible)

The deployment build is explicit and framework-agnostic: `npm run build`
compiles the CLI (`tsc` → `dist/`) and copies `index.html` + `app.js` into
`public/`, which `vercel.json` declares as the output directory. Only that
directory is exposed as static assets, and `.vercelignore` keeps private files
(like your URL lists) out of the upload.
