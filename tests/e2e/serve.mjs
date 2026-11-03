// Tiny dependency-free static file server for the end-to-end tests.
//
//   import { serve } from './serve.mjs';
//   const site = serve('/abs/path/to/docs', 0);   // port 0 = any free port
//   await site.ready;                              // optional: listen() binds synchronously, see below
//   ... fetch(site.url + 'index.html') ...
//   await site.close();
//
// Run directly:  node tests/e2e/serve.mjs [port]   (default 4173, serves ./docs)
//
// Design notes
// - `serve()` returns synchronously. Node binds a TCP listener synchronously
//   when `listen()` is called without a hostname (the port is known at once,
//   even for port 0), so `url` is final on return. `ready` resolves on the
//   'listening' event for callers that prefer to await it.
// - Every response carries `Cache-Control: no-store` so a stale service worker
//   or HTTP cache can never hide a change between test runs.
// - Paths are resolved inside `root` only; `..` segments cannot escape it.

import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.y4m': 'video/x-yuv4mpeg',
  '.mjpeg': 'video/x-motion-jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
};

/** Map a request URL to an absolute file path under root, or null when it escapes. */
export function resolvePath(root, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  } catch {
    return null;
  }
  // path.normalize collapses `..`; the join below is then checked against root
  // so a path such as /../../etc/passwd cannot leave the served directory.
  const normalized = path.posix.normalize(pathname);
  const absRoot = path.resolve(root);
  const full = path.resolve(absRoot, '.' + (normalized.startsWith('/') ? normalized : '/' + normalized));
  if (full !== absRoot && !full.startsWith(absRoot + path.sep)) return null;
  return full;
}

async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

/**
 * Start serving `root` on `port` (0 for an ephemeral port).
 * Returns { url, port, server, ready, close() } synchronously.
 */
export function serve(root, port = 0) {
  const absRoot = path.resolve(root);

  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    let file = resolvePath(absRoot, req.url || '/');
    if (!file) {
      res.writeHead(403, { 'Cache-Control': 'no-store' });
      res.end('Forbidden');
      return;
    }
    let st = await statOrNull(file);
    if (st && st.isDirectory()) {
      file = path.join(file, 'index.html');
      st = await statOrNull(file);
    }
    if (!st || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('Not found: ' + (req.url || '/'));
      return;
    }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
      // Lets the e2e page be treated as a top-level document with no surprises.
      'X-Content-Type-Options': 'nosniff',
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    stream.pipe(res);
  });

  // Keep-alive sockets would otherwise hold close() open for seconds.
  server.keepAliveTimeout = 1000;
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve());
  });
  // No hostname: binds synchronously, so address() is valid right away.
  server.listen(port);
  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}/`;

  return {
    url,
    port: actualPort,
    server,
    ready: ready.then(() => url),
    close() {
      return new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      });
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const docs = path.resolve(here, '..', '..', 'docs');
  const port = Number(process.argv[2] || process.env.PORT || 4173);
  const site = serve(docs, port);
  console.log(`Serving ${docs} at ${site.url}`);
}
