/* Stream Checker service worker.
 *
 * Cache-first for the app shell (this directory's files) under a versioned
 * cache name; network-first with a cache fallback for the Google Fonts CSS
 * and font files, so the typography survives offline once seen; and plain
 * network for everything else that is cross-origin (api.anthropic.com,
 * Overpass mirrors, Open-Meteo): the worker never touches those requests.
 *
 * Classic (non-module) worker so it runs on every browser that has service
 * workers at all. Bump CACHE_VERSION with each release: the install step
 * fills a fresh cache and the activate step deletes the old one.
 */

const CACHE_VERSION = '0.1.0';
const CACHE_NAME = `stream-checker-v${CACHE_VERSION}`;

// Relative to this file's directory, which is the site root (/ in tests,
// /stream-checker/ on GitHub Pages).
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './flow.js',
  './compass.js',
  './declination.js',
  './geo.js',
  './waterways.js',
  './offline.js',
  './scene.js',
  './verdict.js',
  './demo.js',
  './data/wmm-2025.json',
  './manifest.webmanifest',
  './icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        // One missing file (say, during a partial deploy) must not block the
        // whole install, so each entry is added on its own.
        Promise.allSettled(SHELL.map((path) => cache.add(path).catch((err) => console.warn('[sw] not cached', path, err)))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('stream-checker-v') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (FONT_HOSTS.has(url.hostname)) {
    event.respondWith(networkFirst(req));
  }
  // Anything else cross-origin: not handled, so it goes straight to the network.
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  // Navigations may carry ?demo=1 or ?debug=1: serve the cached shell regardless.
  const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  } catch (err) {
    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    // Google Fonts responses are opaque for no-cors stylesheet links; caching
    // them is still fine, they are only ever replayed for the same request.
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}
