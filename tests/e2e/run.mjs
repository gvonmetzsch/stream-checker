// End-to-end test for Stream Checker.
//
// Runs the real app in headless Chromium with a file-backed fake camera, a
// geolocation override, synthetic compass events, and the map / elevation /
// Claude endpoints routed to fixtures. One browser launch per scenario because
// the fake camera clip is a launch argument.
//
//   node tests/e2e/run.mjs                 # local static server over docs/
//   E2E_URL=https://x.github.io/stream-checker node tests/e2e/run.mjs   # deployed site
//   E2E_ONLY=right,wrong node tests/e2e/run.mjs                           # subset
//
// Screenshots land in tests/e2e/out/.

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';
import { declination } from '../../docs/declination.js';
import { parseOverpass, expectedFlow } from '../../docs/waterways.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS = path.join(ROOT, 'docs');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const VID = path.join(FIX, 'video');
const OUT = path.join(ROOT, 'tests', 'e2e', 'out');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(VID, { recursive: true });

// Must match the point the Overpass fixtures were drawn around.
const POINT = { lat: 45.462, lon: -122.598 };
const PITCH = 45; // phone tilted down toward the water

const loadJson = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));

function ensureVideos() {
  const specs = {
    'flow-ne.y4m': ['--angle', '45', '--speed', '1.5', '--jitter', '1.2'],
    'flow-s.y4m': ['--angle', '180', '--speed', '1.5', '--jitter', '1.2'],
    'still.y4m': ['--still'],
    'blank.y4m': ['--blank'],
  };
  for (const [file, args] of Object.entries(specs)) {
    const out = path.join(VID, file);
    if (fs.existsSync(out)) continue;
    console.log(`generating ${file} ...`);
    const r = spawnSync('python3', [path.join(ROOT, 'scripts', 'make-test-video.py'), '--out', out, '--seconds', '5', '--fps', '15', '--width', '640', '--height', '480', '--seed', '7', ...args], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`could not generate ${file}`);
  }
}

// Bearing of the fixture stream, derived from the fixture itself so the test
// stays consistent with whatever the geometry says.
function fixtureStreamBearing(name) {
  const f = expectedFlow(parseOverpass(loadJson(name)), POINT);
  if (!f) throw new Error(`fixture ${name} has no usable waterway near the test point`);
  return f.bearing;
}

const sceneReply = (scene, bodyType, label, quip) => ({
  id: 'msg_e2e', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
  content: [{ type: 'text', text: JSON.stringify({ scene, bodyType, label, confidence: 0.93, quip }) }],
  usage: { input_tokens: 420, output_tokens: 64 },
});

function scenarios() {
  const streamBearing = fixtureStreamBearing('overpass-stream.json');
  const clipAngle = 45; // flow-ne.y4m moves up-right on screen
  const screenUpFor = (flowBearing) => ((flowBearing - clipAngle) % 360 + 360) % 360;
  return [
    { key: 'right', video: 'flow-ne.y4m', overpass: 'overpass-stream.json', headingTrue: screenUpFor(streamBearing), expect: 'RIGHT', screenshot: true },
    { key: 'wrong', video: 'flow-ne.y4m', overpass: 'overpass-stream.json', headingTrue: screenUpFor(streamBearing + 180), expect: 'WRONG', screenshot: true },
    { key: 'sideways', video: 'flow-ne.y4m', overpass: 'overpass-stream.json', headingTrue: screenUpFor(streamBearing + 90), expect: 'SIDEWAYS' },
    { key: 'terrain-right', video: 'flow-ne.y4m', overpass: 'overpass-empty.json', elevation: 'elevation-downhill.json', headingTrue: 100, expect: 'TERRAIN_RIGHT' },
    { key: 'terrain-wrong', video: 'flow-ne.y4m', overpass: 'overpass-empty.json', elevation: 'elevation-uphill.json', headingTrue: 100, expect: 'TERRAIN_WRONG' },
    { key: 'unverified-map-down', video: 'flow-ne.y4m', overpass: 'fail', elevation: null, headingTrue: 100, expect: 'UNVERIFIED' },
    { key: 'unverified-no-location', video: 'flow-ne.y4m', overpass: 'overpass-stream.json', location: null, headingTrue: 100, expect: 'UNVERIFIED' },
    { key: 'still-lake', video: 'still.y4m', overpass: 'overpass-lake.json', headingTrue: 100, expect: 'STILL_LAKE' },
    { key: 'still-stream', video: 'still.y4m', overpass: 'overpass-stream.json', headingTrue: 100, expect: 'STILL_STREAM' },
    { key: 'still-unknown', video: 'still.y4m', overpass: 'overpass-empty.json', elevation: null, headingTrue: 100, expect: 'STILL_UNKNOWN' },
    { key: 'tidal', video: 'flow-ne.y4m', overpass: 'overpass-coast.json', headingTrue: 100, expect: 'TIDAL' },
    { key: 'no-texture', video: 'blank.y4m', overpass: 'overpass-stream.json', headingTrue: 100, expect: 'NO_TEXTURE' },
    { key: 'no-compass', video: 'flow-ne.y4m', overpass: 'overpass-stream.json', headingTrue: null, expect: 'NO_COMPASS' },
    { key: 'not-water', video: 'flow-ne.y4m', overpass: 'overpass-stream.json', headingTrue: 100, scene: sceneReply('not_water', 'other', 'a living-room carpet', 'That is a rug. Rugs do not flow.'), expect: 'NOT_WATER' },
    { key: 'puddle', video: 'still.y4m', overpass: 'overpass-empty.json', elevation: null, headingTrue: 100, scene: sceneReply('still_water', 'puddle', 'a parking-lot puddle', 'A puddle. Majestic.'), expect: 'STILL_UNKNOWN' },
  ];
}

async function launch(video, opts = {}) {
  const args = [
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${path.join(VID, video)}`,
    '--use-fake-ui-for-media-stream',
  ];
  return chromium.launch({ args, ...opts });
}

async function newPage(browser, s, baseUrl) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: s.screenshot ? 2 : 1,
    isMobile: true,
    hasTouch: true,
    colorScheme: s.colorScheme || 'light',
    permissions: s.location === null ? [] : ['geolocation'],
    geolocation: s.location === null ? undefined : { latitude: POINT.lat, longitude: POINT.lon, accuracy: 8 },
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.route(/overpass|interpreter/i, (route) => {
    if (s.overpass === 'fail') return route.fulfill({ status: 503, contentType: 'text/plain', body: 'overloaded' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(loadJson(s.overpass)) });
  });
  await page.route(/api\.open-meteo\.com/i, (route) => {
    if (!s.elevation) return route.fulfill({ status: 503, contentType: 'text/plain', body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(loadJson(s.elevation)) });
  });
  await page.route(/api\.anthropic\.com/i, (route) => {
    if (!s.scene) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'no key in test' } }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(s.scene) });
  });
  await page.goto(`${baseUrl}/`, { waitUntil: 'load' });
  return { context, page, errors };
}

async function startCompass(page, headingTrue) {
  if (headingTrue == null) return;
  const decl = declination(POINT.lat, POINT.lon);
  const headingMag = ((headingTrue - decl) % 360 + 360) % 360;
  // Android convention: alpha runs counter-clockwise, so a top-edge heading H
  // corresponds to alpha = 360 - H. With gamma = 0 the tilt blend is exact.
  const alpha = (360 - headingMag) % 360;
  await page.evaluate(({ alpha, beta }) => {
    const fire = () => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha, beta, gamma: 0, absolute: true }));
    fire();
    window.__e2eOrientation = setInterval(fire, 100);
  }, { alpha, beta: PITCH });
}

async function enableScene(page) {
  await page.click('#settings-button');
  await page.fill('#api-key', 'sk-ant-e2e-test-key');
  const toggle = page.locator('#scene-toggle');
  if (!(await toggle.isChecked())) await toggle.check();
  await page.click('#settings-close');
}

async function runScenario(s, baseUrl) {
  const browser = await launch(s.video);
  try {
    const { page, errors } = await newPage(browser, s, baseUrl);
    if (s.scene) await enableScene(page);
    await startCompass(page, s.headingTrue);
    await page.click('#check-button');
    await page.waitForSelector('#state[data-state="verdict"]', { timeout: 45000 });
    const got = await page.evaluate(() => ({
      code: document.querySelector('#verdict')?.dataset.code || null,
      headline: document.querySelector('#verdict-headline')?.textContent?.trim() || null,
      detail: document.querySelector('#verdict-detail')?.textContent?.trim() || null,
      verdict: window.__sc?.lastVerdict || null,
      flow: window.__sc?.lastFlow || null,
      heading: window.__sc?.lastHeading || null,
    }));
    if (s.screenshot) {
      await page.screenshot({ path: path.join(OUT, `verdict-${s.key}-light.png`), fullPage: true });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.screenshot({ path: path.join(OUT, `verdict-${s.key}-dark.png`), fullPage: true });
    }
    const pass = got.code === s.expect;
    return { key: s.key, expect: s.expect, got: got.code, headline: got.headline, detail: got.detail, pass, errors, flow: got.flow, heading: got.heading };
  } finally {
    await browser.close();
  }
}

async function idleScreenshots(baseUrl) {
  const browser = await launch('flow-ne.y4m');
  try {
    for (const scheme of ['light', 'dark']) {
      const { page } = await newPage(browser, { video: 'flow-ne.y4m', overpass: 'overpass-empty.json', colorScheme: scheme, screenshot: true }, baseUrl);
      await page.screenshot({ path: path.join(OUT, `idle-${scheme}.png`), fullPage: true });
      await page.context().close();
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  ensureVideos();
  let server = null;
  let baseUrl = process.env.E2E_URL ? process.env.E2E_URL.replace(/\/$/, '') : null;
  if (!baseUrl) {
    server = await serve(DOCS, 0);
    baseUrl = server.url.replace(/\/$/, '');
  }
  const only = process.env.E2E_ONLY ? new Set(process.env.E2E_ONLY.split(',')) : null;
  const results = [];
  try {
    await idleScreenshots(baseUrl);
    for (const s of scenarios()) {
      if (only && !only.has(s.key)) continue;
      const t0 = Date.now();
      let r;
      try {
        r = await runScenario(s, baseUrl);
      } catch (e) {
        r = { key: s.key, expect: s.expect, got: null, pass: false, errors: [String(e)] };
      }
      r.ms = Date.now() - t0;
      results.push(r);
      console.log(`${r.pass ? 'PASS' : 'FAIL'} ${s.key.padEnd(22)} expected ${s.expect.padEnd(14)} got ${String(r.got).padEnd(14)} ${r.ms} ms${r.headline ? '  | ' + r.headline : ''}`);
      if (r.errors && r.errors.length) for (const e of r.errors.slice(0, 5)) console.log(`     ${e}`);
      if (!r.pass && r.flow) console.log('     flow:', JSON.stringify(r.flow), 'heading:', JSON.stringify(r.heading));
    }
  } finally {
    if (server) await server.close();
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
