# ScreamingFreed

A lightweight command-line alternative to Screaming Frog focused on one job:
auditing the hyperlinks inside the article body of WordPress pages.

## Usage

```bash
screamingfreed [--urls <list>] [--file <path>] [--rps 2] [--concurrency 10]
               [--timeout 15] [--db ScreamingFreedSession.db] [--export report.csv]
               [--internal-only | --external-only] [--verbose]
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

When neither `--urls` nor `--file` is given, seed URLs are read from stdin.

Pressing `Ctrl+C` once stops scheduling new requests, flushes pending database
writes and prints the summary; pressing it twice exits immediately.

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

The deployment is plain zero-config: `index.html` + `app.js` are served as
static assets from the project root, `api/` becomes serverless functions, and
`.vercelignore` keeps private files (like your URL lists) out of the
deployment.

Deploy from the project folder:

```bash
npm i -g vercel   # once
vercel            # preview deployment, accept the defaults
vercel --prod     # production deployment
```

Optional hardening — require a shared token on the API:

```bash
vercel env add AUDIT_TOKEN
```

Then enter the same value in the UI's "API token" field (requests without the
matching `x-audit-token` header are rejected with 401).

Local development of the web UI:

```bash
npm run dev        # http://127.0.0.1:3000 — static UI + local /api/audit (no Vercel login needed)
npx vercel dev     # alternative: the full Vercel runtime (requires login)
```
