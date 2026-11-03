// Smoke tests for the Stream Checker UI shell, app orchestration, demo mode,
// PWA files and the e2e static server.
//
//   node --test tests/e2e/shell.test.mjs
//
// Browser tests run the real docs/ files; any sibling module that another
// agent has not written yet is replaced by a contract-shaped stub from
// ./stubs so the orchestration can be exercised end to end.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS = path.join(REPO, 'docs');
const OUT = path.join(REPO, 'tests', 'e2e', 'out');
const SCRATCH = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(os.tmpdir(), 'stream-checker-shell-site');
const STUBS = path.join(SCRATCH, 'stubs');
const SIBLINGS = ['flow', 'compass', 'declination', 'geo', 'waterways', 'offline', 'scene', 'verdict'];

const { serve, resolvePath } = await import(path.join(REPO, 'tests', 'e2e', 'serve.mjs'));
const { chromium } = createRequire(import.meta.url)('playwright');

fs.mkdirSync(OUT, { recursive: true });

/** Copy docs/ to SITE and fill in stubs for missing sibling modules. */
function buildSite() {
  fs.rmSync(SITE, { recursive: true, force: true });
  fs.cpSync(DOCS, SITE, { recursive: true });
  const stubbed = [];
  for (const m of SIBLINGS) {
    const target = path.join(SITE, `${m}.js`);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(path.join(STUBS, `${m}.js`), target);
      stubbed.push(m);
    }
  }
  return stubbed;
}

const stubbed = buildSite();
console.log(`stubbed modules: ${stubbed.length ? stubbed.join(', ') : 'none (all real)'}`);

const CONTRACT_IDS = [
  'app', 'state', 'video', 'overlay', 'check-button', 'cancel-button', 'countdown', 'status', 'heading-readout',
  'verdict', 'verdict-headline', 'verdict-detail', 'measured-bearing', 'expected-bearing', 'verdict-source',
  'share-button', 'again-button', 'history', 'save-area-button', 'save-area-status', 'settings-button', 'settings',
  'api-key', 'model-select', 'scene-toggle', 'sideways-toggle', 'settings-close', 'help-button', 'help', 'demo-link',
];

let site;
let browser;
before(async () => {
  site = serve(SITE, 0);
  await site.ready;
  browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
});
after(async () => {
  if (browser) await browser.close();
  if (site) await site.close();
});

async function newPage({ colorScheme = 'light', scale = 2, geolocation = null, permissions = [] } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: scale,
    isMobile: true,
    hasTouch: true,
    colorScheme,
    serviceWorkers: 'block',
    permissions,
    geolocation: geolocation || undefined,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  // Google Fonts are not reachable from the sandbox; fail fast instead of waiting.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  return { context, page, errors };
}

const notFontErrors = (errors) => errors.filter((e) => !/fonts\.g|net::ERR|Failed to load resource/.test(e));

// ---------------------------------------------------------------------------
// serve.mjs

test('serve.mjs: resolvePath keeps requests inside the root', () => {
  assert.equal(resolvePath('/srv/docs', '/index.html'), path.resolve('/srv/docs/index.html'));
  assert.equal(resolvePath('/srv/docs', '/'), path.resolve('/srv/docs'));
  assert.equal(resolvePath('/srv/docs', '/a/../b.js?x=1#frag'), path.resolve('/srv/docs/b.js'));
  assert.equal(resolvePath('/srv/docs', '/../../etc/passwd'), path.resolve('/srv/docs/etc/passwd'));
  assert.equal(resolvePath('/srv/docs', '/%2e%2e/%2e%2e/etc/passwd'), path.resolve('/srv/docs/etc/passwd'));
});

test('serve.mjs: serves files with types, 404s, HEAD and ignores the query string', async () => {
  const r = await fetch(`${site.url}index.html?demo=1`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const html = await r.text();
  assert.match(html, /<title>Stream Checker<\/title>/);

  const root = await fetch(site.url);
  assert.equal(root.status, 200);
  assert.match(await root.text(), /id="check-button"/);

  const man = await fetch(`${site.url}manifest.webmanifest`);
  assert.match(man.headers.get('content-type'), /application\/manifest\+json/);
  const js = await fetch(`${site.url}app.js`);
  assert.match(js.headers.get('content-type'), /text\/javascript/);
  const svg = await fetch(`${site.url}icon.svg`);
  assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);

  const missing = await fetch(`${site.url}nope.txt`);
  assert.equal(missing.status, 404);

  const head = await fetch(`${site.url}styles.css`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);

  const post = await fetch(`${site.url}index.html`, { method: 'POST', body: 'x' });
  assert.equal(post.status, 405);

  // raw traversal attempt that fetch() would otherwise normalise away
  const raw = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: site.port, path: '/..%2F..%2F..%2Fetc%2Fpasswd', method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.ok(raw === 404 || raw === 403, `traversal answered ${raw}`);
});

// ---------------------------------------------------------------------------
// demo.js fixtures

test('demo.js: velocity, noise, URL matching and demoFetch', async () => {
  const demo = await import(path.join(SITE, 'demo.js'));
  const config = await import(path.join(SITE, 'config.js'));
  const up = demo.velocityFor(0, 2);
  assert.ok(Math.abs(up.vx) < 1e-9 && up.vy < 0, 'angle 0 moves up the screen');
  const right = demo.velocityFor(90, 2);
  assert.ok(right.vx > 0 && Math.abs(right.vy) < 1e-9, 'angle 90 moves right');
  assert.ok(Math.abs(Math.hypot(up.vx, up.vy) - 60) < 1e-9, '2 px/frame at 30 fps = 60 px/s');

  const noise = demo.makeNoise(64, 1);
  assert.equal(noise.length, 64 * 64);
  let min = 1, max = 0;
  for (const v of noise) { min = Math.min(min, v); max = Math.max(max, v); }
  assert.ok(min >= 0 && max <= 1 && max - min > 0.3, `noise range ${min}..${max}`);

  for (const host of config.OVERPASS_HOSTS) assert.ok(demo.isOverpassUrl(host), host);
  assert.ok(demo.isElevationUrl(`${config.ELEVATION_URL}?latitude=1&longitude=2`));
  assert.ok(!demo.isOverpassUrl('https://api.anthropic.com/v1/messages'));

  let passed = null;
  const f = demo.demoFetch(async (input) => { passed = input; return new Response('real'); }, { delayMs: 0 });
  const ov = await (await f(config.OVERPASS_HOSTS[0], { method: 'POST' })).json();
  assert.equal(ov.elements[0].tags.name, 'Demo Creek');
  const el = await (await f(`${config.ELEVATION_URL}?latitude=1&longitude=1`)).json();
  assert.equal(el.elevation.length, 7);
  const other = await f('https://api.anthropic.com/v1/messages');
  assert.equal(await other.text(), 'real');
  assert.equal(passed, 'https://api.anthropic.com/v1/messages');
});

test('demo.js: Demo Creek passes within 30 m and flows at the bearing the demo water will show', async () => {
  const { DEMO } = await import(path.join(SITE, 'demo.js'));
  const geo = await import(path.join(SITE, 'geo.js'));
  const way = DEMO.overpass.elements.find((e) => e.tags && e.tags.waterway);
  assert.ok(way && way.geometry.length >= 2);
  const seg = geo.nearestSegment(DEMO.location, way.geometry);
  assert.ok(seg.distanceM < 30, `creek is ${seg.distanceM.toFixed(1)} m away`);

  // Declination from the real module when present, else the value the fixture was drawn with.
  let decl = -13.57;
  if (!stubbed.includes('declination')) {
    const { declination } = await import(path.join(SITE, 'declination.js'));
    decl = declination(DEMO.location.lat, DEMO.location.lon);
  }
  const expectedTrue = (((DEMO.headingMag + decl + DEMO.angleDeg) % 360) + 360) % 360;
  const diff = Math.abs(geo.angleDiff(seg.bearing, expectedTrue));
  assert.ok(diff < 1.5, `nearest segment bearing ${seg.bearing.toFixed(1)} vs expected ${expectedTrue.toFixed(1)} (decl ${decl.toFixed(2)})`);

  const elev = DEMO.elevation.elevation;
  assert.equal(elev.length, 7);
  for (let i = 1; i < elev.length; i++) assert.ok(elev[i] < elev[i - 1], 'elevation descends along the bearing');
});

// ---------------------------------------------------------------------------
// app.js pure helpers (importable from Node)

test('app.js: pure helpers', async () => {
  const app = await import(path.join(SITE, 'app.js'));
  const config = await import(path.join(SITE, 'config.js'));

  const s = app.sanitizeSettings({ apiKey: ' sk-x ', model: 'nope', sceneCheck: 'yes', sideways: true, junk: 1 });
  assert.deepEqual(s, { apiKey: 'sk-x', model: config.SCENE.models.default, sceneCheck: false, sideways: true });
  assert.equal(app.sanitizeSettings(null).model, 'claude-opus-5-5');
  assert.equal(app.sanitizeSettings({ model: 'claude-haiku-5-5' }).model, 'claude-haiku-5-5');

  assert.equal(app.pad3(41), '041');
  assert.equal(app.pad3(-10), '350');
  assert.equal(app.formatHeading(41), 'NE 041°');
  assert.equal(app.formatHeading(null), '—');

  assert.equal(app.headingReadout(null, { status: 'denied', waitedMs: 2000 }).kind, 'none');
  assert.equal(app.headingReadout(null, { status: 'denied', waitedMs: 200 }).kind, 'waiting');
  assert.equal(app.headingReadout({ headingMag: 10, tiltOk: true }, { status: 'denied' }).kind, 'ok', 'a real sample beats a denied answer');
  assert.equal(app.headingReadout(null, { status: 'granted', waitedMs: 100 }).kind, 'waiting');
  assert.equal(app.headingReadout(null, { status: 'unsupported', waitedMs: 5000 }).hint, 'no compass');
  assert.equal(app.headingReadout({ headingMag: 41, tiltOk: false }).hint, 'tilt the phone down toward the water');
  const jumpy = app.headingReadout({ headingMag: 41, tiltOk: true }, { recent: [0, 90, 180, 270, 45, 200] });
  assert.equal(jumpy.kind, 'calibrate');
  const steady = app.headingReadout({ headingMag: 41, tiltOk: true, source: 'android' }, { recent: [40, 41, 42, 41, 40, 41] });
  assert.equal(steady.kind, 'ok');
  assert.equal(steady.value, 'NE 041°');
  assert.equal(app.headingReadout({ headingMag: 41, tiltOk: true, accuracy: 40 }).kind, 'calibrate');

  const now = Date.parse('2026-11-03T12:00:00Z');
  assert.equal(app.mapAgeText(null), 'map unavailable');
  assert.equal(app.mapAgeText({ status: 'live', features: { timestamp: '2026-11-03T11:30:00Z' } }, now), 'map data current');
  assert.equal(app.mapAgeText({ status: 'live', features: { timestamp: '2026-11-03T06:00:00Z' } }, now), 'map data 6 h old');
  assert.equal(app.mapAgeText({ status: 'live', features: { timestamp: '2026-10-29T12:00:00Z', stale: true } }, now), 'map data 5 days old (stale mirror)');
  assert.match(app.mapAgeText({ status: 'cache', features: { savedAt: now } }, now), /^saved map data from/);

  assert.equal(app.compassStatusFrom('denied', null).status, 'denied');
  assert.equal(app.compassStatusFrom('denied', { headingMag: 10, samples: 50, R: 1 }).status, 'ok', 'samples beat a denied answer');
  assert.equal(app.compassStatusFrom('granted', { headingMag: null, samples: 0, R: 0 }).status, 'unsupported');
  assert.equal(app.compassStatusFrom('unsupported', { headingMag: 10, samples: 2, R: 1 }).status, 'unreliable');
  assert.equal(app.compassStatusFrom('unsupported', { headingMag: 10, samples: 50, R: 0.3 }).status, 'unreliable');
  assert.equal(app.compassStatusFrom('unsupported', { headingMag: 10, samples: 50, R: 0.98 }).status, 'ok');

  const line = app.buildSourceLine({
    verdict: { source: 'osm' },
    expected: { name: 'Demo Creek', kind: 'stream', distanceM: 14.2, confidence: 'high' },
    map: { status: 'live', features: { timestamp: new Date(Date.now() - 3600e3 * 5).toISOString() } },
    mapStatus: 'live',
    heading: { status: 'ok', headingMag: 32, headingTrue: 18.4, declination: -13.6 },
  });
  assert.match(line, /Demo Creek · OSM stream · 14 m from the mapped channel\. Map data 5 h old\. Heading 032° magnetic, declination −13\.6° → 018° true\.$/);
  const unv = app.buildSourceLine({ verdict: { source: 'none' }, mapStatus: 'unavailable', heading: { status: 'ok', headingMag: 32, headingTrue: 32, declination: null } });
  assert.match(unv, /^Unverified · map unreachable/);
  assert.match(unv, /declination was not applied\.$/);
  const terr = app.buildSourceLine({ verdict: { source: 'terrain' }, terrain: { verdict: 'downhill', dropM: 4.2, elevations: [{ distanceM: -600 }, { distanceM: 600 }] }, mapStatus: 'live', map: { status: 'live', features: {} } });
  assert.match(terr, /Terrain estimate \(coarse\): ground drops 4\.2 m over 1200 m/);

  const h = app.historyEntryFrom({ code: 'RIGHT', tone: 'good', headline: 'RIGHT DIRECTION', measuredBearing: 32.6, expectedBearing: 32.4, streamName: 'Demo Creek', source: 'osm' }, { at: now, demo: true });
  assert.deepEqual(h, { at: '2026-11-03T12:00:00.000Z', code: 'RIGHT', tone: 'good', headline: 'RIGHT DIRECTION', measuredBearing: 33, expectedBearing: 32, streamName: 'Demo Creek', source: 'osm', demo: true });

  assert.equal(app.progressText('hi'), 'hi');
  assert.equal(app.progressText({ stage: 'saving', count: 12, bytes: 2048 }), 'saving · 12 features · 2 KB');
  assert.equal(app.progressText({ loaded: 1, total: 4 }), '25%');
  assert.equal(app.describeSceneError({ code: 'auth' }), 'Scene check skipped: the API key was rejected.');
  assert.match(app.describeCameraError({ name: 'NotAllowedError' }), /denied/);
  assert.equal(app.STALL_MESSAGE, 'Camera stalled. Close and reopen the app.');
});

// ---------------------------------------------------------------------------
// PWA files

test('manifest and service worker are consistent and relative', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DOCS, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'Stream Checker');
  assert.equal(manifest.short_name, 'Stream Checker');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  const sizes = manifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
  assert.ok(sizes.includes('192x192:any') && sizes.includes('512x512:any') && sizes.includes('512x512:maskable'));
  for (const icon of manifest.icons) {
    assert.ok(icon.src.startsWith('./'), `relative icon src ${icon.src}`);
    assert.ok(fs.existsSync(path.join(DOCS, icon.src)), `icon exists ${icon.src}`);
  }
  const sw = fs.readFileSync(path.join(DOCS, 'sw.js'), 'utf8');
  assert.match(sw, /skipWaiting/);
  assert.match(sw, /clients\.claim/);
  const shell = [...sw.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]);
  for (const f of shell) {
    if (f === '') continue;
    assert.ok(SIBLINGS.some((m) => f === `${m}.js`) || fs.existsSync(path.join(DOCS, f)), `shell file ${f} exists or is a sibling module`);
  }
  const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /name="referrer"/i, 'no referrer meta (Overpass needs a Referer)');
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /apple-mobile-web-app-status-bar-style/);
  assert.equal((html.match(/name="theme-color"/g) || []).length, 2, 'theme-color for light and dark');
  assert.doesNotMatch(html, /(src|href)="\//, 'no root-absolute asset URLs');
  for (const attr of ['Map data', 'OpenStreetMap', 'ODbL', 'Open-Meteo.com', 'CC BY 4.0', 'Copernicus DEM GLO-90', 'World Magnetic Model 2025']) {
    assert.ok(html.includes(attr), `attribution text: ${attr}`);
  }
  for (const id of CONTRACT_IDS) assert.ok(html.includes(`id="${id}"`), `html has #${id}`);
});

// ---------------------------------------------------------------------------
// Browser: static shell

for (const scheme of ['light', 'dark']) {
  test(`shell renders at 390 px (${scheme})`, async () => {
    const { context, page, errors } = await newPage({ colorScheme: scheme });
    try {
      await page.goto(site.url, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__sc && window.__sc.state === 'idle');
      const info = await page.evaluate((ids) => {
        const missing = ids.filter((id) => !document.getElementById(id));
        const rect = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { w: r.width, h: r.height }; };
        return {
          missing,
          scrollW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
          state: document.getElementById('state').dataset.state,
          camera: document.getElementById('state').dataset.camera,
          check: rect('#check-button'),
          settings: rect('#settings-button'),
          save: rect('#save-area-button'),
          bodyBg: getComputedStyle(document.body).backgroundColor,
          verdictHidden: document.getElementById('verdict').hidden,
          videoDisplay: getComputedStyle(document.getElementById('video')).display,
          status: document.getElementById('status').textContent,
          version: window.__sc.version,
          hasSetFetch: typeof window.__sc.setFetch === 'function',
        };
      }, CONTRACT_IDS);
      assert.deepEqual(info.missing, [], 'all contract ids present');
      assert.ok(info.scrollW <= info.innerW, `no horizontal scroll (${info.scrollW} > ${info.innerW})`);
      assert.equal(info.state, 'idle');
      assert.equal(info.camera, 'off');
      assert.ok(info.check.h >= 64 && info.check.w >= 300, `check button ${JSON.stringify(info.check)}`);
      assert.ok(info.settings.h >= 44 && info.settings.w >= 44, 'settings tap target');
      assert.ok(info.save.h >= 44, 'save button tap target');
      assert.notEqual(info.bodyBg, 'rgba(0, 0, 0, 0)', 'body has an explicit background');
      assert.equal(info.verdictHidden, true);
      assert.notEqual(info.videoDisplay, 'none', 'video is never display:none');
      assert.match(info.status, /tap Check/);
      assert.equal(info.version, '0.1.0');
      assert.ok(info.hasSetFetch);
      await page.screenshot({ path: path.join(OUT, `shell-idle-${scheme}.png`), fullPage: true });

      await page.click('#settings-button');
      await page.waitForSelector('#settings[open]');
      await page.screenshot({ path: path.join(OUT, `shell-settings-${scheme}.png`) });
      assert.equal(await page.$eval('#model-select', (e) => e.value), 'claude-opus-5-5');
      const options = await page.$$eval('#model-select option', (os) => os.map((o) => o.value));
      assert.deepEqual(options, ['claude-opus-5-5', 'claude-haiku-5-5']);
      await page.fill('#api-key', 'sk-ant-test');
      await page.check('#scene-toggle');
      await page.check('#sideways-toggle');
      await page.click('#settings-close');
      await page.waitForSelector('#settings[open]', { state: 'detached' });
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('streamchecker.settings.v1')));
      assert.deepEqual(stored, { apiKey: 'sk-ant-test', model: 'claude-opus-5-5', sceneCheck: true, sideways: true });
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('sideways')), true);
      assert.equal(await page.evaluate(() => window.__sc.settings.apiKey), '[set]', 'key is not exposed on window');
      await page.click('#settings-button');
      await page.uncheck('#sideways-toggle');
      await page.click('#settings-close');

      await page.click('#help-button');
      await page.waitForSelector('#help[open]');
      const helpText = await page.$eval('#help', (e) => e.textContent);
      assert.match(helpText, /OpenStreetMap contributors/);
      assert.match(helpText, /Open-Meteo/);
      assert.match(helpText, /World Magnetic Model 2025/);
      await page.screenshot({ path: path.join(OUT, `shell-help-${scheme}.png`) });
      await page.click('#help-close');

      const bad = notFontErrors(errors);
      assert.deepEqual(bad, [], `no page errors: ${bad.join(' | ')}`);
    } finally {
      await context.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Browser: demo mode end to end

test('demo mode: a full check reaches a verdict, writes history, shares, and resets', async () => {
  const { context, page, errors } = await newPage({ permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    await page.goto(`${site.url}?demo=1&debug=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__sc && window.__sc.state === 'idle');
    assert.equal(await page.$eval('#demo-badge', (e) => e.hidden), false, 'demo badge visible');
    assert.equal(await page.$eval('#debug', (e) => e.hidden), false, 'debug panel visible');
    assert.equal(await page.$eval('#demo-link', (e) => e.textContent.trim()), 'Exit demo');

    // cancel path
    await page.click('#check-button');
    await page.waitForSelector('#state[data-state="capturing"]', { timeout: 10000 });
    assert.ok(await page.$eval('#cancel-button', (e) => getComputedStyle(e).display !== 'none'), 'cancel visible while capturing');
    assert.ok(await page.$eval('#countdown', (e) => getComputedStyle(e).display !== 'none'), 'countdown visible while capturing');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, 'demo-capturing-light.png') });
    const readout = await page.$eval('#heading-readout', (e) => e.textContent);
    assert.match(readout, /NE 032°/, `heading readout shows the demo heading: ${readout}`);
    await page.click('#cancel-button');
    await page.waitForSelector('#state[data-state="idle"]');
    assert.equal(await page.$eval('#state', (e) => e.dataset.camera), 'on', 'stream stays alive after cancel');

    // full run
    const t0 = Date.now();
    await page.click('#check-button');
    await page.waitForSelector('#state[data-state="verdict"]', { timeout: 40000 });
    const elapsed = Date.now() - t0;
    const got = await page.evaluate(() => ({
      code: document.getElementById('verdict').dataset.code,
      tone: document.getElementById('verdict').dataset.tone,
      hidden: document.getElementById('verdict').hidden,
      headline: document.getElementById('verdict-headline').textContent,
      measured: document.getElementById('measured-bearing').textContent,
      expected: document.getElementById('expected-bearing').textContent,
      source: document.getElementById('verdict-source').textContent,
      verdict: window.__sc.lastVerdict,
      flow: window.__sc.lastFlow,
      heading: window.__sc.lastHeading,
      location: window.__sc.lastLocation,
      map: window.__sc.lastMap,
      history: JSON.parse(localStorage.getItem('streamchecker.history.v1')),
      historyItems: document.querySelectorAll('#history .history-item').length,
      camera: document.getElementById('state').dataset.camera,
      videoActive: !!(document.getElementById('video').srcObject && document.getElementById('video').srcObject.active),
    }));
    console.log(`demo verdict ${got.code} in ${elapsed} ms; flow ${JSON.stringify(got.flow)}`);
    assert.equal(got.hidden, false);
    assert.equal(got.code, 'RIGHT', `demo must come out RIGHT (got ${got.code}: ${got.headline})`);
    assert.equal(got.tone, 'good');
    assert.match(got.measured, /^NE \(\d+°\)$/);
    assert.match(got.expected, /^NE \(\d+°\)$/);
    assert.match(got.source, /Demo Creek · OSM stream · 14 m from the mapped channel/);
    assert.match(got.source, /declination −13\.\d° →/);
    assert.equal(got.map.status, 'live');
    assert.deepEqual(got.location, { lat: 44.1735, lon: -72.912, accuracy: 9 });
    assert.equal(got.heading.check.status, 'ok');
    assert.equal(got.flow.motion, 'flowing');
    assert.ok(got.flow.frames >= 30, `enough frame pairs (${got.flow.frames})`);
    assert.ok(Math.abs(got.flow.angleDeg - 30) < 8, `image angle ${got.flow.angleDeg} near 30`);
    assert.equal(got.history.length, 1);
    assert.equal(got.history[0].code, 'RIGHT');
    assert.equal(got.history[0].demo, true);
    assert.equal(got.historyItems, 1);
    assert.equal(got.camera, 'on');
    assert.equal(got.videoActive, true, 'one stream kept alive after the check');

    await page.screenshot({ path: path.join(OUT, 'demo-verdict-light.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(OUT, 'demo-verdict-dark.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });

    // share falls back to the clipboard in headless Chromium
    await page.click('#share-button');
    await page.waitForFunction(() => !document.getElementById('toast').hidden);
    const toast = await page.$eval('#toast', (e) => e.textContent);
    assert.match(toast, /Copied/);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(clip.length > 10, 'share text copied');

    // visual check of the other tones, by restyling the rendered card
    for (const [tone, headline] of [['bad', 'WRONG WAY'], ['warn', 'SIDEWAYS'], ['neutral', 'UNVERIFIED']]) {
      await page.evaluate(({ tone, headline }) => {
        document.getElementById('verdict').dataset.tone = tone;
        document.getElementById('verdict-headline').textContent = headline;
      }, { tone, headline });
      await page.locator('#verdict').screenshot({ path: path.join(OUT, `verdict-card-${tone}.png`) });
    }

    await page.click('#again-button');
    await page.waitForSelector('#state[data-state="idle"]');
    assert.equal(await page.$eval('#verdict', (e) => e.hidden), true);

    const debug = await page.$eval('#debug', (e) => e.textContent);
    assert.match(debug, /"location"/);
    assert.match(debug, /"map"/);

    const bad = notFontErrors(errors);
    assert.deepEqual(bad, [], `no page errors: ${bad.join(' | ')}`);
  } finally {
    await context.close();
  }
});

test('demo mode: scene check result is used when a key is set', async () => {
  const { context, page, errors } = await newPage();
  try {
    await page.route(/api\.anthropic\.com/, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify({ scene: 'not_water', bodyType: 'other', label: 'a living-room carpet', confidence: 0.93, quip: 'That is a rug. Rugs do not flow.' }) }],
        usage: { input_tokens: 420, output_tokens: 64 },
      }),
    }));
    await page.goto(`${site.url}?demo=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__sc && window.__sc.state === 'idle');
    await page.click('#settings-button');
    await page.fill('#api-key', 'sk-ant-e2e-test-key');
    await page.check('#scene-toggle');
    await page.click('#settings-close');
    await page.click('#check-button');
    await page.waitForSelector('#state[data-state="verdict"]', { timeout: 40000 });
    const got = await page.evaluate(() => ({
      code: document.getElementById('verdict').dataset.code,
      notice: document.getElementById('scene-notice').textContent,
      scene: window.__sc.lastScene,
    }));
    assert.equal(got.code, 'NOT_WATER', `scene result drives the verdict (got ${got.code})`);
    assert.match(got.notice, /Rugs do not flow/);
    assert.equal(got.scene.scene, 'not_water');
    await page.locator('#verdict').screenshot({ path: path.join(OUT, 'verdict-card-not-water.png') });
    const bad = notFontErrors(errors);
    assert.deepEqual(bad, [], `no page errors: ${bad.join(' | ')}`);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------
// Browser: real camera path (Chromium's fake device), GPS, orientation events, injected fetch

test('camera path: getUserMedia, geolocation, compass events and setFetch all feed the verdict', async () => {
  const { DEMO } = await import(path.join(SITE, 'demo.js'));
  const { context, page, errors } = await newPage({
    permissions: ['camera', 'geolocation'],
    geolocation: { latitude: DEMO.location.lat, longitude: DEMO.location.lon, accuracy: 8 },
    scale: 1,
  });
  try {
    await page.goto(`${site.url}?debug=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__sc && window.__sc.state === 'idle');
    const calls = await page.evaluate((fixture) => {
      window.__calls = [];
      window.__sc.setFetch(async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        window.__calls.push(url);
        if (/overpass|interpreter/i.test(url)) {
          return new Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('nope', { status: 503 });
      });
      return window.__calls;
    }, DEMO.overpass);
    assert.deepEqual(calls, []);
    // Android-style absolute orientation: alpha = 360 - heading, pitched 45 degrees down.
    await page.evaluate(({ alpha }) => {
      const fire = () => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha, beta: 45, gamma: 0, absolute: true }));
      fire();
      setInterval(fire, 100);
    }, { alpha: (360 - DEMO.headingMag) % 360 });

    await page.click('#check-button');
    await page.waitForSelector('#state[data-state="capturing"]', { timeout: 10000 });
    const during = await page.evaluate(() => ({
      camera: document.getElementById('state').dataset.camera,
      videoW: document.getElementById('video').videoWidth,
      overlayW: document.getElementById('overlay').width,
      readout: document.getElementById('heading-readout').textContent,
    }));
    assert.equal(during.camera, 'on');
    assert.ok(during.videoW > 0, 'video has frames');
    assert.equal(during.overlayW, during.videoW, 'overlay matches the frame size');
    await page.waitForSelector('#state[data-state="verdict"]', { timeout: 40000 });
    const got = await page.evaluate(() => ({
      code: document.getElementById('verdict').dataset.code,
      location: window.__sc.lastLocation,
      map: window.__sc.lastMap,
      heading: window.__sc.lastHeading,
      flow: window.__sc.lastFlow,
      calls: window.__calls,
      videoActive: !!(document.getElementById('video').srcObject && document.getElementById('video').srcObject.active),
      readout: document.getElementById('heading-readout').textContent,
    }));
    const check = got.heading && got.heading.check;
    console.log(`camera path verdict ${got.code}; heading check ${JSON.stringify(check)}; flow ${JSON.stringify(got.flow && { motion: got.flow.motion, angle: got.flow.angleDeg, frames: got.flow.frames })}`);
    assert.ok(got.code, 'a verdict code was set');
    assert.ok(Math.abs(got.location.lat - DEMO.location.lat) < 1e-6 && Math.abs(got.location.lon - DEMO.location.lon) < 1e-6, 'GPS fix used');
    assert.equal(got.map.status, 'live', 'map lookup went through the injected fetch');
    assert.ok(got.calls.some((u) => /overpass|interpreter/i.test(u)), 'injected fetch was called for Overpass');
    assert.equal(check.status, 'ok', `compass window ok: ${JSON.stringify(check)}`);
    assert.ok(Math.abs(check.headingMag - DEMO.headingMag) < 1.5, `magnetic heading ${check.headingMag} ~ ${DEMO.headingMag}`);
    assert.ok(Math.abs(check.headingTrue - (DEMO.headingMag + check.declination)) < 1e-6, 'declination applied');
    assert.ok(got.flow && got.flow.frames > 10, 'frames were analysed');
    assert.equal(got.videoActive, true, 'camera stream still alive after the check');
    assert.match(got.readout, /NE 032°/);
    const bad = notFontErrors(errors);
    assert.deepEqual(bad, [], `no page errors: ${bad.join(' | ')}`);
  } finally {
    await context.close();
  }
});

test('camera path: a denied camera lands in the error state with a readable message', async () => {
  const { context, page } = await newPage({ permissions: [] });
  try {
    await page.goto(site.url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__sc && window.__sc.state === 'idle');
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    });
    await page.click('#check-button');
    await page.waitForSelector('#state[data-state="error"]', { timeout: 10000 });
    const status = await page.$eval('#status', (e) => e.textContent);
    assert.match(status, /Camera access was denied/);
    assert.equal(await page.$eval('#check-button', (e) => e.disabled), false, 'can try again');
    assert.equal(await page.$eval('#check-button .check-label', (e) => e.textContent), 'Try again');
  } finally {
    await context.close();
  }
});

test('camera path: a silent camera trips the stall detector', async () => {
  const { context, page } = await newPage({ permissions: ['camera'] });
  try {
    await page.goto(site.url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__sc && window.__sc.state === 'idle');
    // A stream whose track never delivers frames: a canvas that is never drawn to.
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 48;
      const stream = canvas.captureStream(0); // frames only on requestFrame(), which is never called
      navigator.mediaDevices.getUserMedia = () => Promise.resolve(stream);
    });
    const t0 = Date.now();
    await page.click('#check-button');
    await page.waitForSelector('#state[data-state="error"]', { timeout: 15000 });
    const status = await page.$eval('#status', (e) => e.textContent);
    assert.equal(status, 'Camera stalled. Close and reopen the app.');
    assert.ok(Date.now() - t0 >= 2500, 'waited about STALL_MS before giving up');
  } finally {
    await context.close();
  }
});
