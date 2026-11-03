/* Stream Checker service worker.
 *
 * Network-first with a cached fallback for the app shell (this directory's
 * files), so an installed copy runs the latest deployed files whenever it has
 * a connection and still opens offline; network-first with a cache fallback
 * for the Google Fonts CSS and font files, so the typography survives offline
 * once seen; and plain network for everything else that is cross-origin
 * (api.anthropic.com, Overpass mirrors, Open-Meteo): the worker never touches
 * those requests.
 *
 * Classic (non-module) worker so it runs on every browser that has service
 * workers at all. CACHE_VERSION only needs a bump when the shell file list
 * changes shape: the install step fills a fresh cache and the activate step
 * deletes the old one.
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
    event.respondWith(shellNetworkFirst(req));
    return;
  }
  if (FONT_HOSTS.has(url.hostname)) {
    event.respondWith(networkFirst(req));
  }
  // Anything else cross-origin: not handled, so it goes straight to the network.
});

// How long to wait for the network before falling back to the cached copy.
// Online, the app always runs the latest deployed files (there is no build
// step, so nothing else bumps the cache); offline or on a dead connection, the
// cached shell appears after this delay at the latest.
const NETWORK_TIMEOUT_MS = 4000;

async function shellNetworkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  // Navigations may carry ?demo=1 or ?debug=1: the cached shell matches regardless.
  const matchOpts = { ignoreSearch: req.mode === 'navigate' };
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS);
  });
  try {
    const res = await Promise.race([fetch(req), timeout]);
    if (res) {
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      if (res.ok || res.status === 304) return res;
      // A 404 during a partial deploy or a 5xx: prefer the last good copy.
      const cached = await cache.match(req, matchOpts);
      return cached || res;
    }
  } catch (err) {
    // fall through to the cache
  } finally {
    clearTimeout(timer);
  }
  const cached = await cache.match(req, matchOpts);
  if (cached) return cached;
  if (req.mode === 'navigate') {
    const shell = await cache.match('./index.html');
    if (shell) return shell;
  }
  return fetch(req);
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
