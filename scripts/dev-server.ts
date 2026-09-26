// Local development server for the ScreamingFreed web UI.
//
// Serves the static UI (index.html + app.js) from the project root and
// exposes POST /api/audit by importing api/audit.ts directly, mimicking
// how the Vercel runtime invokes the handler (JSON body pre-parsing and
// Express-like res.status()/res.json() helpers).
//
// Run with: npm run dev   (executed through tsx so .ts imports work)

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = '127.0.0.1';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// Only these static files are served; everything else in the project root
// (source, configs, personal URL lists) stays private to the dev machine.
const STATIC_ALLOWLIST = new Set(['/index.html', '/app.js']);

function augmentResponse(res: ServerResponse): VercelResponse {
  const augmented = res as unknown as VercelResponse & {
    status?: (code: number) => VercelResponse;
    json?: (body: unknown) => VercelResponse;
  };
  augmented.status = (code: number) => {
    res.statusCode = code;
    return augmented;
  };
  augmented.json = (body: unknown) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
    return augmented;
  };
  return augmented;
}

const { default: handler } = await import(
  pathToFileURL(join(ROOT, 'api', 'audit.ts')).href
);

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

    if (url.pathname === '/api/audit') {
      const vercelResponse = augmentResponse(res);
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const vercelRequest = req as unknown as VercelRequest;
      if (raw.length > 0) {
        try {
          vercelRequest.body = JSON.parse(raw);
        } catch {
          vercelRequest.body = raw;
        }
      }
      await handler(vercelRequest, vercelResponse);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('Method not allowed');
      return;
    }

    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    if (!STATIC_ALLOWLIST.has(pathname)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    try {
      const content = await readFile(join(ROOT, pathname));
      res.writeHead(200, {
        'content-type':
          MIME_TYPES[extname(pathname)] ?? 'application/octet-stream',
      });
      res.end(content);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    }
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(error instanceof Error ? error.message : 'Server error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ScreamingFreed web UI: http://${HOST}:${PORT}`);
  console.log('Press Ctrl+C to stop.');
});