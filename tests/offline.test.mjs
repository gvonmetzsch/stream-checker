// Unit tests for docs/offline.js: the pure radius filter against the offline
// fixture, the IndexedDB functions against a small in-memory IndexedDB fake
// (Node has none), and, when Playwright's Chromium can launch, the same
// functions against a real IndexedDB in a browser page.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as config from '../docs/config.js';
import { destination, haversineM } from '../docs/geo.js';
import { parseOverpass } from '../docs/waterways.js';
import { filterFeatures, saveArea, cachedFeatures, savedAreas, clearSaved } from '../docs/offline.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const DOCS = path.resolve(HERE, '..', 'docs');
const load = (name) => JSON.parse(readFileSync(path.join(FIX, name), 'utf8'));

const P = { lat: 45.462, lon: -122.598 };
const LAKE_CENTRE = destination(P, 300, 140); // Demo Lake in overpass-area.json: octagon, radius 100 m
const FAR_COAST = destination(P, 270, 2000);
const FAR_POND = destination(P, 180, 1000);
const FAR_CANAL = destination(P, 45, 1500);

const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} expected ${expected} ± ${tol}, got ${actual}`);
const names = (list) => list.map((f) => f.name).sort();
const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// filterFeatures

test('filterFeatures applies the live radii to a saved area', () => {
  const all = parseOverpass(load('overpass-area.json'));
  assert.equal(all.waterways.length, 3);
  assert.equal(all.waterAreas.length, 2);
  assert.equal(all.coastlines.length, 1);

  const f = filterFeatures(all, P);
  assert.deepEqual(names(f.waterways), ['Johnson Creek', null].sort(), 'creek (25 m) and ditch (120 m), not the canal 1.5 km away');
  assert.deepEqual(names(f.waterAreas), ['Demo Lake'], 'shore about 40 m away; Far Pond 1 km away dropped');
  assert.equal(f.coastlines.length, 0, 'coast 2 km away');
  assert.deepEqual(f.containing, [], 'P is outside the lake');
  assert.equal(f.timestamp, '2026-11-02T08:15:04Z');
  assert.equal(f.remark, null);
  // The kept features are the stored objects themselves (geometry intact).
  assert.equal(f.waterways.find((w) => w.name === 'Johnson Creek').geometry.length, 6);
});

test('filterFeatures derives containing from polygons', () => {
  const all = parseOverpass(load('overpass-area.json'));
  const f = filterFeatures(all, LAKE_CENTRE);
  assert.equal(f.containing.length, 1);
  assert.equal(f.containing[0].name, 'Demo Lake');
  assert.equal(f.containing[0].kind, 'lake');
  assert.equal(f.containing[0].id, 12345);
  assert.equal(f.containing[0].tags.natural, 'water');
  assert.deepEqual(names(f.waterAreas), ['Demo Lake']);
  // Standing in Far Pond.
  const pond = filterFeatures(all, FAR_POND);
  assert.deepEqual(names(pond.containing), ['Far Pond']);
  assert.deepEqual(names(pond.waterways), [], 'nothing mapped flows within 200 m of the pond');
});

test('filterFeatures finds the coast and the canal from their own neighbourhoods', () => {
  const all = parseOverpass(load('overpass-area.json'));
  const coast = filterFeatures(all, destination(FAR_COAST, 90, 100));
  assert.equal(coast.coastlines.length, 1);
  assert.equal(coast.waterways.length, 0);
  assert.equal(coast.waterAreas.length, 0);
  const canal = filterFeatures(all, destination(FAR_CANAL, 110, 40));
  assert.deepEqual(names(canal.waterways), ['Mill Race Canal']);
});

test('filterFeatures honours custom radii and tolerates empty input', () => {
  const all = parseOverpass(load('overpass-area.json'));
  const tight = filterFeatures(all, P, { waterway: 50, water: 10, coast: 10 });
  assert.deepEqual(names(tight.waterways), ['Johnson Creek'], 'ditch at 120 m excluded by the 50 m radius');
  assert.deepEqual(tight.waterAreas, []);
  const wide = filterFeatures(all, P, { waterway: 2000, coast: 2500 });
  assert.deepEqual(names(wide.waterways), ['Johnson Creek', 'Mill Race Canal', null].sort());
  assert.equal(wide.coastlines.length, 1);
  const empty = { waterways: [], waterAreas: [], coastlines: [], containing: [], timestamp: null, remark: null };
  assert.deepEqual(filterFeatures(null, P), empty);
  assert.deepEqual(filterFeatures({}, P), empty);
  assert.deepEqual(filterFeatures(all, { lat: NaN, lon: 1 }), { ...empty, timestamp: '2026-11-02T08:15:04Z' });
  // Centre-only areas (no outline) are measured by centre distance.
  const centreOnly = { waterAreas: [{ id: 1, name: 'Dot Pond', kind: 'pond', tags: {}, center: destination(P, 0, 50) }, { id: 2, name: 'Far Dot', kind: 'pond', tags: {}, center: destination(P, 0, 500) }] };
  assert.deepEqual(names(filterFeatures(centreOnly, P).waterAreas), ['Dot Pond']);
});

// ---------------------------------------------------------------------------
// A small in-memory IndexedDB: open/upgrade, one object store, put/getAll/clear,
// requests and transactions completing on later macrotasks like the real thing.

function makeFakeIndexedDB() {
  const databases = new Map();
  const later = (fn) => setTimeout(fn, 0);

  function makeRequest(tx, run) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    if (tx) tx._pending++;
    later(() => {
      try {
        req.result = run();
        if (req.onsuccess) req.onsuccess({ target: req });
      } catch (err) {
        req.error = err;
        if (req.onerror) req.onerror({ target: req });
      }
      if (tx) tx._done();
    });
    return req;
  }

  class FakeStore {
    constructor(tx, data, keyPath) {
      this.tx = tx;
      this.data = data;
      this.keyPath = keyPath;
    }
    put(value) {
      return makeRequest(this.tx, () => {
        if (this.tx.mode !== 'readwrite') throw new Error('ReadOnlyError');
        const key = value[this.keyPath];
        if (key == null) throw new Error('DataError: no key');
        this.data.set(key, structuredClone(value));
        return key;
      });
    }
    getAll() {
      return makeRequest(this.tx, () => [...this.data.values()].map((v) => structuredClone(v)));
    }
    clear() {
      return makeRequest(this.tx, () => {
        if (this.tx.mode !== 'readwrite') throw new Error('ReadOnlyError');
        this.data.clear();
      });
    }
  }

  class FakeTransaction {
    constructor(db, name, mode) {
      this.db = db;
      this.name = name;
      this.mode = mode;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      this.error = null;
      this._pending = 0;
      this._finished = false;
      later(() => this._maybeComplete());
    }
    objectStore(name) {
      if (!this.db.stores.has(name)) throw new Error(`NotFoundError: ${name}`);
      return new FakeStore(this, this.db.stores.get(name).data, this.db.stores.get(name).keyPath);
    }
    _done() {
      this._pending--;
      later(() => this._maybeComplete());
    }
    _maybeComplete() {
      if (this._finished || this._pending > 0) return;
      this._finished = true;
      if (this.oncomplete) this.oncomplete({ target: this });
    }
  }

  class FakeDatabase {
    constructor(name, version) {
      this.name = name;
      this.version = version;
      this.stores = new Map();
      this.objectStoreNames = { contains: (n) => this.stores.has(n) };
    }
    createObjectStore(name, { keyPath }) {
      this.stores.set(name, { keyPath, data: new Map() });
    }
    transaction(name, mode = 'readonly') {
      return new FakeTransaction(this, name, mode);
    }
    close() {}
  }

  return {
    opens: 0,
    open(name, version) {
      this.opens++;
      const req = { result: undefined, error: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      later(() => {
        let db = databases.get(name);
        const upgrade = !db || db.version < version;
        if (!db) {
          db = new FakeDatabase(name, version);
          databases.set(name, db);
        }
        req.result = db;
        if (upgrade) {
          db.version = version;
          if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        }
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
  };
}

const AREA = load('overpass-area.json');
const areaFetch = () => async () => jsonResponse(AREA);

afterEach(() => {
  delete globalThis.indexedDB;
});

test('saveArea, cachedFeatures, savedAreas and clearSaved round-trip through IndexedDB', async () => {
  const fake = makeFakeIndexedDB();
  globalThis.indexedDB = fake;
  const progress = [];
  const before = Date.now();
  const saved = await saveArea(P, { fetchImpl: areaFetch(), onProgress: (p) => progress.push(p) });
  assert.equal(saved.count, 6, '3 waterways + 2 water areas + 1 coastline');
  assert.ok(saved.bytes > 1000);
  assert.ok(Date.parse(saved.savedAt) >= before - 1);
  assert.deepEqual(saved.center, P);
  assert.equal(saved.radiusM, config.RADIUS.offline);
  assert.equal(typeof saved.id, 'string');
  assert.ok(progress.length >= 2, 'progress reported');
  assert.ok(progress.every((p) => typeof p.message === 'string' && typeof p.stage === 'string'));
  assert.ok(progress.some((p) => p.count === 6));

  const areas = await savedAreas();
  assert.equal(areas.length, 1);
  assert.deepEqual(Object.keys(areas[0]).sort(), ['bytes', 'center', 'count', 'id', 'radiusM', 'savedAt']);
  assert.equal(areas[0].count, 6);
  assert.equal(areas[0].id, saved.id);

  const cached = await cachedFeatures(P);
  assert.ok(cached);
  assert.equal(cached.source, 'cache');
  assert.equal(cached.savedAt, saved.savedAt);
  assert.equal(cached.timestamp, '2026-11-02T08:15:04Z');
  assert.deepEqual(names(cached.waterways), ['Johnson Creek', null].sort(), 'filtered with the live radii');
  assert.deepEqual(names(cached.waterAreas), ['Demo Lake']);
  assert.deepEqual(cached.containing, []);
  const inLake = await cachedFeatures(LAKE_CENTRE);
  assert.deepEqual(names(inLake.containing), ['Demo Lake']);

  // Coverage keeps a margin of the largest lookup radius inside the saved
  // circle: a point on the rim would get silently incomplete data.
  const margin = Math.max(config.RADIUS.waterway, config.RADIUS.water, config.RADIUS.coast);
  assert.equal(await cachedFeatures(destination(P, 0, config.RADIUS.offline + 50)), null, 'just outside the saved circle');
  assert.equal(await cachedFeatures(destination(P, 0, config.RADIUS.offline - 50)), null, 'on the rim: lookup radii would leave the saved circle');
  assert.ok(await cachedFeatures(destination(P, 0, config.RADIUS.offline - margin - 50)), 'well inside the saved circle');

  await clearSaved();
  assert.deepEqual(await savedAreas(), []);
  assert.equal(await cachedFeatures(P), null);
});

test('cachedFeatures prefers the most recent area covering the point', async () => {
  globalThis.indexedDB = makeFakeIndexedDB();
  const older = { ...AREA, osm3s: { timestamp_osm_base: '2026-10-01T00:00:00Z' } };
  await saveArea(P, { fetchImpl: async () => jsonResponse(older), radiusM: 3000 });
  await sleep(5);
  const elsewhere = destination(P, 90, 2500); // 2.5 km east: its 3 km circle still covers P
  await saveArea(elsewhere, { fetchImpl: areaFetch(), radiusM: 3000 });
  const areas = await savedAreas();
  assert.equal(areas.length, 2);
  assert.ok(Date.parse(areas[0].savedAt) >= Date.parse(areas[1].savedAt), 'most recent first');
  near(haversineM(areas[0].center, elsewhere), 0, 1e-6);
  const cached = await cachedFeatures(P);
  assert.equal(cached.timestamp, '2026-11-02T08:15:04Z', 'the newer save wins');
  // A point only the older circle covers falls back to it.
  const westOnly = destination(P, 270, 2000);
  assert.equal((await cachedFeatures(westOnly)).timestamp, '2026-10-01T00:00:00Z');
});

test('saveArea asks Overpass with the area query and propagates OverpassError', async () => {
  globalThis.indexedDB = makeFakeIndexedDB();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? new Response('overloaded', { status: 503 }) : jsonResponse(AREA);
  };
  const r = await saveArea(P, { fetchImpl, radiusM: 1500, hosts: ['https://a.test/api', 'https://b.test/api'] });
  assert.equal(calls.length, 2, 'host fallback applies to the download too');
  const query = new URLSearchParams(calls[0].init.body).get('data');
  assert.ok(query.includes('around:1500,45.462,-122.598'));
  assert.ok(query.includes('out tags geom('));
  assert.ok(query.includes('out geom('));
  assert.equal(r.radiusM, 1500);
  assert.equal(r.host, 'https://b.test/api');

  await assert.rejects(saveArea(P, { fetchImpl: async () => new Response('', { status: 503 }), hosts: ['https://a.test/api'] }), { code: 'all_hosts_failed' });
  assert.deepEqual(await savedAreas(), [{ id: r.id, center: P, radiusM: 1500, savedAt: r.savedAt, count: 6, bytes: r.bytes }], 'the failed save stored nothing');
  await assert.rejects(saveArea({ lat: 'x' }, { fetchImpl }), /lat, lon/);
});

test('without IndexedDB saveArea rejects clearly and the readers degrade', async () => {
  delete globalThis.indexedDB;
  await assert.rejects(saveArea(P, { fetchImpl: areaFetch() }), /IndexedDB/);
  assert.equal(await cachedFeatures(P), null);
  assert.deepEqual(await savedAreas(), []);
  await clearSaved();
});

// ---------------------------------------------------------------------------
// Real browser (Playwright Chromium, preinstalled): skipped when it cannot launch.

test('offline cache works against a real IndexedDB in Chromium', { timeout: 90000 }, async (t) => {
  let chromium;
  try {
    ({ chromium } = createRequire(import.meta.url)('playwright'));
  } catch (err) {
    t.skip('playwright not installed');
    return;
  }
  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    t.skip(`Chromium could not launch: ${String(err.message || err).split('\n')[0]}`);
    return;
  }
  // Static server for docs/ so the ES modules load from an http origin.
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/blank.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>offline test</title>');
      return;
    }
    const file = path.join(DOCS, path.normalize(url.pathname));
    if (!file.startsWith(DOCS) || !file.endsWith('.js')) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(data);
    } catch (err) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    await page.goto(`${base}/blank.html`);
    const out = await page.evaluate(
      async ({ fixture, point, lakeCentre, far }) => {
        const m = await import('/offline.js');
        const fetchImpl = async () => new Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } });
        await m.clearSaved();
        const progress = [];
        const saved = await m.saveArea(point, { fetchImpl, onProgress: (p) => progress.push(p.stage) });
        const areas = await m.savedAreas();
        const cached = await m.cachedFeatures(point);
        const inLake = await m.cachedFeatures(lakeCentre);
        const none = await m.cachedFeatures(far);
        await m.clearSaved();
        const after = await m.savedAreas();
        return {
          saved: { count: saved.count, radiusM: saved.radiusM, hasSavedAt: !Number.isNaN(Date.parse(saved.savedAt)) },
          progress,
          areas: areas.length,
          cached: cached && { source: cached.source, waterways: cached.waterways.map((w) => w.name), waterAreas: cached.waterAreas.map((a) => a.name), savedAt: cached.savedAt },
          inLakeContaining: inLake && inLake.containing.map((c) => c.name),
          none,
          after: after.length,
          dbNames: (await indexedDB.databases()).map((d) => d.name),
        };
      },
      { fixture: AREA, point: P, lakeCentre: LAKE_CENTRE, far: { lat: 46, lon: -121 } },
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(out.saved, { count: 6, radiusM: config.RADIUS.offline, hasSavedAt: true });
    assert.deepEqual(out.progress, ['downloading', 'saving', 'saved']);
    assert.equal(out.areas, 1);
    assert.equal(out.cached.source, 'cache');
    assert.deepEqual(out.cached.waterways.sort(), ['Johnson Creek', null].sort());
    assert.deepEqual(out.cached.waterAreas, ['Demo Lake']);
    assert.ok(!Number.isNaN(Date.parse(out.cached.savedAt)));
    assert.deepEqual(out.inLakeContaining, ['Demo Lake']);
    assert.equal(out.none, null);
    assert.equal(out.after, 0);
    assert.ok(out.dbNames.includes(config.STORAGE.db), 'database name from config');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
