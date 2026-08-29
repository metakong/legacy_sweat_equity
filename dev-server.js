/**
 * Local dev server. Mimics the Cloudflare edge closely enough that a bug shows
 * up here rather than after deploy:
 *   - D1  -> node:sqlite running the Worker's real SQL (see mockEnv.js)
 *   - R2  -> .local_r2/ on disk
 *   - static assets -> ./public with the Worker's own security headers
 *
 * Run with: npm run dev   (http://localhost:3000)
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import worker, { SECURITY_HEADERS, CONTENT_SECURITY_POLICY, runNightlyRollup } from './src/index.js';
import { createD1, mockR2 } from './mockEnv.js';

const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 25 * 1024 * 1024; // room for a long voice journal
const PUBLIC_ROOT = path.resolve(process.cwd(), 'public');

// Secrets come from the shell, never from this file — it is committed.
//   PowerShell:  $env:GROQ_API_KEY = 'gsk_...'; npm run dev
//   bash:        GROQ_API_KEY=gsk_... npm run dev
const env = {
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  TAVILY_API_KEY: process.env.TAVILY_API_KEY || '',
  MAPBOX_TOKEN: process.env.MAPBOX_TOKEN || '',
  GROQ_MODEL: process.env.GROQ_MODEL || '',
  OPENROUTER_STRUCTURE_MODEL: process.env.OPENROUTER_STRUCTURE_MODEL || '',
  OPENROUTER_ENRICH_MODEL: process.env.OPENROUTER_ENRICH_MODEL || '',
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '',
  STORE_AUDIO: process.env.STORE_AUDIO || '1',
  APP_URL: `http://localhost:${PORT}`,
  DB: createD1(),
  BUCKET: {
    put: (key, data, options) => mockR2.put(key, data, options),
    get: (key) => mockR2.get(key),
    delete: (key) => mockR2.delete(key)
  }
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

/** Resolve a URL path to a real file inside /public, or null. */
function resolveStaticFile(pathName) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathName);
  } catch {
    return null; // malformed percent-encoding
  }
  // Reject NUL and any traversal segment before touching the filesystem
  if (decoded.includes('\0')) return null;

  // The PWA is the site root now — the homeowner portal was removed in the
  // B2B pivot, and the Worker performs the same rewrite in production.
  const relative = (decoded === '/' || decoded === '/app' || decoded === '/app/')
    ? 'app/index.html'
    : decoded.replace(/^\/+/, '');

  const resolved = path.resolve(PUBLIC_ROOT, relative);
  // Confine to /public so encoded traversal cannot escape the web root
  if (resolved !== PUBLIC_ROOT && !resolved.startsWith(PUBLIC_ROOT + path.sep)) return null;

  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      const index = path.join(resolved, 'index.html');
      return fs.existsSync(index) ? index : null;
    }
    return stat.isFile() ? resolved : null;
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  const pathName = url.pathname;

  // Serve static files under /public directly
  if (!pathName.startsWith('/api/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const filePath = resolveStaticFile(pathName);
    if (filePath) {
      const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      const headers = {
        'Content-Type': contentType,
        // Without this the browser heuristically caches app.css and the ES
        // modules, and an edit appears not to have taken effect. Production
        // serves these through Cloudflare's asset handler, which does its own
        // (correct) cache negotiation — this is a dev-only concern.
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        ...SECURITY_HEADERS
      };
      if (contentType.startsWith('text/html')) {
        headers['Content-Security-Policy'] = CONTENT_SECURITY_POLICY;
      }
      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(filePath);
      stream.on('error', (err) => {
        console.error('Static read error:', err.message);
        res.destroy();
      });
      stream.pipe(res);
      return;
    }
  }

  // Buffer the body for API routes
  const chunks = [];
  let received = 0;
  let bodyTooLarge = false;

  req.on('data', (chunk) => {
    if (bodyTooLarge) return;
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      bodyTooLarge = true;
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Request body too large (25MB max)' }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('error', (err) => {
    console.error('Request stream error:', err.message);
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Malformed request' }));
    }
  });

  req.on('end', async () => {
    if (bodyTooLarge) return;
    const body = Buffer.concat(chunks);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && body.length > 0;
    const workerReq = new Request(url.toString(), {
      method: req.method,
      headers,
      body: hasBody ? body : undefined
    });

    // Local-only hook for exercising the cron path
    if (pathName === '/api/cron/trigger') {
      try {
        const summary = await runNightlyRollup(env);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, summary }));
      } catch (err) {
        console.error('Cron trigger failed:', err);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Cron trigger failed' }));
      }
      return;
    }

    try {
      const response = await worker.fetch(workerReq, env, { waitUntil: () => {} });

      const responseHeaders = {};
      response.headers.forEach((val, key) => { responseHeaders[key] = val; });

      res.writeHead(response.status, responseHeaders);
      const resBuf = await response.arrayBuffer();
      res.end(Buffer.from(resBuf));
    } catch (err) {
      console.error('Worker error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
});

server.listen(PORT, () => {
  const missing = ['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'TAVILY_API_KEY'].filter((k) => !env[k]);
  console.log(`Aflac Field Prospecting dev server -> http://localhost:${PORT}`);
  console.log(`- Field PWA (mobile + desktop console): http://localhost:${PORT}/`);
  console.log(`- Health / provider status:             http://localhost:${PORT}/api/health`);
  console.log(`- Simulated nightly rollup:             http://localhost:${PORT}/api/cron/trigger`);
  if (missing.length) {
    console.log(`- Note: ${missing.join(', ')} not set. Voice logging and enrichment will report a degraded status.`);
  }
  if (!env.MAPBOX_TOKEN) {
    console.log('- Note: MAPBOX_TOKEN not set. Route planner uses the local great-circle heuristic.');
  }
});

// Graceful shutdown so in-flight responses finish and the port frees cleanly
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down dev server...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
