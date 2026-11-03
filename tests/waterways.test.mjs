// Unit tests for docs/waterways.js: Overpass query building and parsing, host
// fallback with a mocked fetch, feature interpretation, and the Open-Meteo
// terrain fallback. No network: every fetch is a stub.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as config from '../docs/config.js';
import { destination, haversineM, absAngleDiff } from '../docs/geo.js';
import {
  buildQuery,
  buildAreaQuery,
  parseOverpass,
  fetchFeatures,
  OverpassError,
  isRateLimited,
  clearRateLimits,
  expectedFlow,
  nearbyWater,
  areaContains,
  fitSlope,
  terrainSlope,
} from '../docs/waterways.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name) => JSON.parse(readFileSync(join(FIX, name), 'utf8'));

// The point every Overpass fixture was drawn around (see tests/fixtures/overpass-*.json).
const P = { lat: 45.462, lon: -122.598 };
const FAR = { lat: 46.0, lon: -121.0 };

const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} expected ${expected} ± ${tol}, got ${actual}`);

const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const textResponse = (text, status) => new Response(text, { status, headers: { 'content-type': 'text/html' } });

/** A fetch stub that answers each call with the next responder and records the calls. */
function scripted(responders) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const r = responders.shift();
    if (!r) throw new Error(`unexpected fetch of ${url}`);
    return r(url, init);
  };
  return { fetchImpl, calls };
}

/** A fetch that never answers until its signal aborts. */
const hanging = (url, init) =>
  new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
  });

const HOSTS = ['https://a.overpass.test/api/interpreter', 'https://b.overpass.test/api/interpreter', 'https://c.overpass.test/api/interpreter'];

beforeEach(() => clearRateLimits());

// ---------------------------------------------------------------------------
// Query building

test('buildQuery is one request with the three statements and the configured radii', () => {
  const q = buildQuery(P);
  assert.ok(q.startsWith('[out:json][timeout:20];'));
  assert.ok(q.includes(`way(around:${config.RADIUS.waterway},45.462,-122.598)[waterway~"^(river|stream|canal|drain|ditch|brook|tidal_channel)$"][area!=yes];`));
  assert.ok(q.includes('out tags geom;'));
  assert.ok(q.includes(`way(around:${config.RADIUS.water},45.462,-122.598)[natural=water];`));
  assert.ok(q.includes(`rel(around:${config.RADIUS.water},45.462,-122.598)[natural=water];`));
  assert.ok(q.includes(`way(around:${config.RADIUS.coast},45.462,-122.598)[natural=coastline];`));
  assert.ok(q.includes('out tags center;'));
  assert.ok(q.includes('is_in(45.462,-122.598)->.a;'));
  assert.ok(q.includes('area.a[natural=water];'));
  assert.ok(q.trimEnd().endsWith('out tags;'));
  // Each out statement follows its own statement set, in order.
  const order = ['out tags geom;', 'out tags center;', 'is_in(', 'out tags;'].map((s) => q.indexOf(s));
  assert.deepEqual(order.slice().sort((a, b) => a - b), order);
  assert.equal((q.match(/\bout\b/g) || []).length, 4, 'three out statements plus [out:json]');
});

test('buildQuery honours custom radii and formats coordinates without exponents', () => {
  const q = buildQuery({ lat: 0.0000001, lon: -0.00000001 }, { waterway: 50, water: 10, coast: 20 });
  assert.ok(q.includes('around:50,0.0000001,0)'));
  assert.ok(q.includes('around:10,'));
  assert.ok(q.includes('around:20,'));
  assert.ok(!/e-\d/.test(q), 'no exponent notation');
  // Partial overrides keep the defaults for the rest.
  const q2 = buildQuery(P, { waterway: 75 });
  assert.ok(q2.includes('around:75,'));
  assert.ok(q2.includes(`around:${config.RADIUS.coast},`));
});

test('buildAreaQuery asks for everything in the radius with geometry clipped to the circle bbox', () => {
  const q = buildAreaQuery(P, 5000);
  assert.ok(q.startsWith('[out:json][timeout:'));
  assert.ok(q.includes('way(around:5000,45.462,-122.598)[waterway~"^(river|stream|canal|drain|ditch|brook|tidal_channel)$"][area!=yes];'));
  assert.ok(q.includes('way(around:5000,45.462,-122.598)[natural=water];'));
  assert.ok(q.includes('way(around:5000,45.462,-122.598)[natural=coastline];'));
  assert.ok(q.includes('rel(around:5000,45.462,-122.598)[natural=water];'));
  const m = q.match(/out tags geom\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\);/);
  assert.ok(m, 'ways printed with out tags geom(bbox)');
  const [south, west, north, east] = m.slice(1).map(Number);
  assert.ok(south < P.lat && P.lat < north);
  assert.ok(west < P.lon && P.lon < east);
  near(north - south, (2 * 5000) / 111195, 1e-4, 'bbox height spans the circle');
  near(haversineM({ lat: P.lat, lon: west }, { lat: P.lat, lon: east }), 10000, 1, 'bbox width spans the circle');
  assert.ok(q.includes(`out geom(${m[1]},${m[2]},${m[3]},${m[4]});`), 'relations printed with out geom(bbox), members included');
  assert.ok(q.indexOf('out tags geom(') < q.indexOf('rel(around'), 'ways printed before the relation statement');
  assert.ok(buildAreaQuery(P).includes(`around:${config.RADIUS.offline},`), 'default radius');
});

// ---------------------------------------------------------------------------
// Parsing

test('parseOverpass shapes waterways from the stream fixture', () => {
  const f = parseOverpass(load('overpass-stream.json'));
  assert.equal(f.timestamp, '2026-11-02T08:15:04Z');
  assert.equal(f.remark, null);
  assert.equal(f.waterways.length, 2);
  assert.equal(f.waterAreas.length, 0);
  assert.equal(f.coastlines.length, 0);
  assert.equal(f.containing.length, 0);
  const creek = f.waterways.find((w) => w.name === 'Johnson Creek');
  assert.ok(creek);
  assert.equal(creek.id, 128334761);
  assert.equal(creek.kind, 'stream');
  assert.equal(creek.bidirectional, false);
  assert.equal(creek.tags.waterway, 'stream');
  assert.equal(creek.geometry.length, 6);
  assert.ok(creek.geometry.every((g) => Number.isFinite(g.lat) && Number.isFinite(g.lon)));
  const ditch = f.waterways.find((w) => w.kind === 'ditch');
  assert.equal(ditch.name, null, 'unnamed ditch');
});

test('parseOverpass shapes water areas, containing areas and coastlines', () => {
  const lake = parseOverpass(load('overpass-lake.json'));
  assert.equal(lake.waterAreas.length, 2);
  const demo = lake.waterAreas.find((a) => a.name === 'Demo Lake');
  assert.equal(demo.id, 12345);
  assert.equal(demo.kind, 'lake');
  assert.ok(Number.isFinite(demo.center.lat) && Number.isFinite(demo.center.lon));
  assert.ok(!('geometry' in demo), 'centre-only response carries no geometry');
  near(haversineM(P, demo.center), 35, 0.5);
  const pond = lake.waterAreas.find((a) => a.name === 'Duck Pond');
  assert.equal(pond.kind, 'pond');
  assert.deepEqual(lake.containing, [{ id: 3600012345, name: 'Demo Lake', kind: 'lake', tags: { natural: 'water', water: 'lake', name: 'Demo Lake' } }]);

  const coast = parseOverpass(load('overpass-coast.json'));
  assert.equal(coast.coastlines.length, 2);
  assert.equal(coast.waterways.length, 0);
  assert.equal(coast.coastlines[0].tags.natural, 'coastline');
  assert.ok(Number.isFinite(coast.coastlines[0].center.lat));
});

test('parseOverpass flags tidal and two-way channels and falls back to name:en', () => {
  const tidal = parseOverpass(load('overpass-tidal.json'));
  assert.equal(tidal.waterways.length, 2);
  assert.ok(tidal.waterways.every((w) => w.bidirectional), 'tidal_channel and tidal=yes are both bidirectional');
  const both = parseOverpass({ elements: [{ type: 'way', id: 1, tags: { waterway: 'river', flow_direction: 'both', 'name:en': 'Two Way River' }, geometry: [{ lat: 1, lon: 1 }, { lat: 1.001, lon: 1 }] }] });
  assert.equal(both.waterways[0].bidirectional, true);
  assert.equal(both.waterways[0].name, 'Two Way River');
  assert.equal(both.timestamp, null);
});

test('parseOverpass deduplicates by type and id, ignores nodes, keeps the remark', () => {
  const raw = load('overpass-stream.json');
  const doubled = { ...raw, elements: [...raw.elements, ...raw.elements, { type: 'node', id: 7, lat: 1, lon: 2, tags: { natural: 'water' } }, null, { id: 9 }] };
  const f = parseOverpass(doubled);
  assert.equal(f.waterways.length, 2);
  assert.equal(f.waterAreas.length, 0);
  const remark = parseOverpass(load('overpass-remark.json'));
  assert.match(remark.remark, /timed out/);
  assert.equal(remark.waterways.length, 0);
  assert.deepEqual(parseOverpass(null), { waterways: [], waterAreas: [], coastlines: [], containing: [], timestamp: null, remark: null });
  assert.equal(parseOverpass(load('overpass-empty.json')).waterways.length, 0);
});

test('parseOverpass assembles relation member ways into rings (offline cache shape)', () => {
  const f = parseOverpass(load('overpass-area.json'));
  assert.equal(f.waterways.length, 3);
  assert.equal(f.coastlines.length, 1);
  assert.equal(f.coastlines[0].geometry.length, 3);
  const lake = f.waterAreas.find((a) => a.name === 'Demo Lake');
  assert.ok(lake);
  assert.equal(lake.rings.length, 1, 'two outer ways stitched into one ring');
  assert.equal(lake.geometry.length, 9, 'closed octagon (first vertex repeated)');
  assert.deepEqual(lake.geometry[0], lake.geometry[8]);
  assert.deepEqual(lake.holes, []);
  // Centre of a relation printed with out geom: the bounds centre.
  near(haversineM(lake.center, destination(P, 300, 140)), 0, 0.5);
  assert.ok(areaContains(lake, lake.center));
  assert.ok(!areaContains(lake, P));
  // A closed natural=water way: its own geometry is the ring, centre is the vertex mean.
  const pond = f.waterAreas.find((a) => a.name === 'Far Pond');
  assert.equal(pond.rings.length, 1);
  near(haversineM(pond.center, destination(P, 180, 1000)), 0, 0.5);
});

test('parseOverpass keeps inner rings as holes and drops null clipped vertices', () => {
  const c = { lat: 45.0, lon: -122.0 };
  const ring = (centre, r) => [0, 90, 180, 270].map((b) => destination(centre, b, r));
  const outer = ring(c, 200);
  const inner = ring(c, 20);
  const el = {
    type: 'relation',
    id: 5,
    tags: { type: 'multipolygon', natural: 'water', water: 'reservoir' },
    members: [
      { type: 'way', ref: 1, role: 'outer', geometry: [...outer, outer[0], null] },
      { type: 'way', ref: 2, role: 'inner', geometry: [...inner, inner[0]] },
      { type: 'node', ref: 3, role: 'label', lat: c.lat, lon: c.lon },
    ],
  };
  const f = parseOverpass({ elements: [el] });
  const area = f.waterAreas[0];
  assert.equal(area.kind, 'reservoir');
  assert.equal(area.rings.length, 1);
  assert.equal(area.holes.length, 1);
  assert.equal(area.geometry.length, 5, 'null vertex dropped');
  assert.equal(areaContains(area, c), false, 'on the island');
  assert.equal(areaContains(area, destination(c, 45, 60)), true, 'on the water');
  assert.equal(areaContains(area, destination(c, 45, 400)), false, 'outside');
});

// ---------------------------------------------------------------------------
// Interpreting features

test('expectedFlow finds Johnson Creek with the designed bearing, distance and confidence', () => {
  const f = parseOverpass(load('overpass-stream.json'));
  const e = expectedFlow(f, P);
  assert.ok(e);
  assert.equal(e.name, 'Johnson Creek');
  assert.equal(e.kind, 'stream');
  assert.equal(e.wayId, 128334761);
  assert.equal(e.confidence, 'high');
  assert.equal(e.exempt, false);
  assert.equal(e.reason, null);
  near(absAngleDiff(e.bearing, 110), 0, 3, 'bearing within 3 degrees of the design (ESE)');
  near(e.distanceM, 25, 3, 'about 25 m from the creek');
  // The nearer feature wins even though the ditch is also within 200 m.
  assert.equal(expectedFlow(f, destination(P, 200, 120)).kind, 'ditch');
  // Nothing within the radius.
  assert.equal(expectedFlow(f, FAR), null);
  assert.equal(expectedFlow(f, P, { waterway: 10 }), null);
  assert.equal(expectedFlow(parseOverpass(load('overpass-empty.json')), P), null);
  assert.equal(expectedFlow(null, P), null);
});

test('expectedFlow grades canals medium and exempts tidal channels', () => {
  const canal = expectedFlow(parseOverpass(load('overpass-canal.json')), P);
  assert.equal(canal.kind, 'canal');
  assert.equal(canal.confidence, 'medium');
  near(absAngleDiff(canal.bearing, 200), 0, 3);
  near(canal.distanceM, 30, 3);
  const tidal = expectedFlow(parseOverpass(load('overpass-tidal.json')), P);
  assert.equal(tidal.kind, 'tidal_channel');
  assert.equal(tidal.name, 'Demo Slough');
  assert.equal(tidal.exempt, true);
  assert.match(tidal.reason, /tidal/);
  assert.equal(tidal.confidence, 'low');
  near(absAngleDiff(tidal.bearing, 350), 0, 3);
  // A tidal=yes river is exempt too, with its own reason.
  const river = expectedFlow(parseOverpass(load('overpass-tidal.json')), destination(P, 260, 100));
  assert.equal(river.kind, 'river');
  assert.equal(river.exempt, true);
  assert.match(river.reason, /tidal/);
});

test('nearbyWater reports the containing lake, the nearest water area and the coast', () => {
  const lake = nearbyWater(parseOverpass(load('overpass-lake.json')), P);
  assert.deepEqual(lake.lake, { name: 'Demo Lake', kind: 'lake', distanceM: 0, contains: true });
  assert.equal(lake.coast, null);

  // Without the is_in match the nearest centre wins.
  const raw = load('overpass-lake.json');
  const noArea = parseOverpass({ ...raw, elements: raw.elements.filter((e) => e.type !== 'area') });
  const nearest = nearbyWater(noArea, P);
  assert.equal(nearest.lake.name, 'Demo Lake');
  assert.equal(nearest.lake.contains, false);
  near(nearest.lake.distanceM, 35, 0.5);

  const coast = nearbyWater(parseOverpass(load('overpass-coast.json')), P);
  assert.equal(coast.lake, null);
  near(coast.coast.distanceM, 120, 0.5, 'nearest of the two coastline ways');

  const stream = nearbyWater(parseOverpass(load('overpass-stream.json')), P);
  assert.deepEqual(stream, { lake: null, coast: null });
  assert.deepEqual(nearbyWater(null, P), { lake: null, coast: null });
});

test('nearbyWater measures outlines against the radius but trusts centre-only live results', () => {
  const far = destination(P, 90, 500);
  const square = [0, 90, 180, 270].map((b) => destination(far, b, 30));
  const withGeometry = { waterAreas: [{ id: 1, name: 'Far Pond', kind: 'pond', tags: {}, center: far, geometry: square, rings: [square], holes: [] }], coastlines: [], containing: [] };
  assert.equal(nearbyWater(withGeometry, P).lake, null, 'an outline 470 m away is rejected');
  assert.equal(nearbyWater(withGeometry, destination(far, 0, 50)).lake.name, 'Far Pond', 'an outline 20 m away is accepted');
  assert.equal(nearbyWater(withGeometry, far).lake.contains, true, 'inside the outline');
  // Centre-only features only come from the server-filtered live query, so a
  // big lake whose centre is far from the shore next to the user still counts.
  const centreOnly = { waterAreas: [{ id: 2, name: 'Big Lake', kind: 'lake', tags: {}, center: far }], coastlines: [{ id: 3, tags: {}, center: destination(P, 0, 900) }], containing: [] };
  const w = nearbyWater(centreOnly, P);
  assert.equal(w.lake.name, 'Big Lake');
  near(w.lake.distanceM, 500, 1);
  near(w.coast.distanceM, 900, 1);
  // A coastline with geometry is measured to the line: a north-south shore 250 m east of P.
  const shore = destination(P, 90, 250);
  const line = [destination(shore, 180, 400), shore, destination(shore, 0, 400)];
  const coastGeom = { waterAreas: [], coastlines: [{ id: 4, tags: {}, center: destination(shore, 0, 150), geometry: line }], containing: [] };
  near(nearbyWater(coastGeom, P).coast.distanceM, 250, 0.5);
  assert.equal(nearbyWater(coastGeom, P, { coast: 100 }).coast, null);
});

// ---------------------------------------------------------------------------
// fetchFeatures with a mocked fetch

test('fetchFeatures posts a form-encoded query and falls back to the next host after a 503', async () => {
  const { fetchImpl, calls } = scripted([() => textResponse('overloaded', 503), () => jsonResponse(load('overpass-stream.json'))]);
  const before = Date.now();
  const r = await fetchFeatures(P, { fetchImpl, hosts: HOSTS });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, HOSTS[0]);
  assert.equal(calls[1].url, HOSTS[1]);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.ok(calls[0].init.body.startsWith('data='));
  assert.equal(new URLSearchParams(calls[0].init.body).get('data'), buildQuery(P));
  assert.ok(calls[0].init.signal instanceof AbortSignal, 'per-host abort signal');
  assert.equal(r.host, HOSTS[1]);
  assert.equal(r.source, 'live');
  assert.equal(r.timestamp, '2026-11-02T08:15:04Z');
  assert.equal(r.waterways.length, 2);
  assert.equal(typeof r.stale, 'boolean');
  assert.ok(Date.parse(r.fetchedAt) >= before - 1);
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].status, 503);
  assert.equal(r.attempts[1].ok, true);
});

test('fetchFeatures uses a custom query when given one', async () => {
  const { fetchImpl, calls } = scripted([() => jsonResponse(load('overpass-empty.json'))]);
  const query = buildAreaQuery(P, 1000);
  await fetchFeatures(P, { fetchImpl, hosts: HOSTS, query });
  assert.equal(new URLSearchParams(calls[0].init.body).get('data'), query);
});

test('fetchFeatures marks the stale flag from osm3s.timestamp_osm_base', async () => {
  const fresh = { ...load('overpass-empty.json'), osm3s: { timestamp_osm_base: new Date(Date.now() - 3600 * 1000).toISOString() } };
  const old = { ...load('overpass-empty.json'), osm3s: { timestamp_osm_base: new Date(Date.now() - config.OVERPASS_STALE_MS - 3600 * 1000).toISOString() } };
  const a = await fetchFeatures(P, { fetchImpl: scripted([() => jsonResponse(fresh)]).fetchImpl, hosts: HOSTS });
  assert.equal(a.stale, false);
  const b = await fetchFeatures(P, { fetchImpl: scripted([() => jsonResponse(old)]).fetchImpl, hosts: HOSTS });
  assert.equal(b.stale, true);
  const c = await fetchFeatures(P, { fetchImpl: scripted([() => jsonResponse({ elements: [] })]).fetchImpl, hosts: HOSTS });
  assert.equal(c.stale, false, 'no timestamp: not flagged');
  assert.equal(c.timestamp, null);
});

test('fetchFeatures pauses a host after a 429 and skips it on the next call', async () => {
  const first = scripted([() => textResponse('Too Many Requests', 429), () => jsonResponse(load('overpass-stream.json'))]);
  const r1 = await fetchFeatures(P, { fetchImpl: first.fetchImpl, hosts: HOSTS });
  assert.equal(r1.host, HOSTS[1]);
  assert.equal(first.calls.length, 2);
  assert.equal(isRateLimited(HOSTS[0]), true);
  assert.equal(isRateLimited(HOSTS[1]), false);
  assert.equal(isRateLimited(HOSTS[0], Date.now() + config.OVERPASS_BACKOFF_MS + 1), false, 'pause ends after the backoff');

  const second = scripted([() => jsonResponse(load('overpass-stream.json'))]);
  const r2 = await fetchFeatures(P, { fetchImpl: second.fetchImpl, hosts: HOSTS });
  assert.equal(second.calls.length, 1, 'the paused host is not contacted');
  assert.equal(second.calls[0].url, HOSTS[1]);
  assert.equal(r2.host, HOSTS[1]);
  assert.deepEqual(r2.attempts[0], { host: HOSTS[0], skipped: 'rate_limited' });

  clearRateLimits();
  assert.equal(isRateLimited(HOSTS[0]), false);
});

test('fetchFeatures throws rate_limited when every host is paused or answers 429', async () => {
  const all429 = scripted(HOSTS.map(() => () => textResponse('', 429)));
  await assert.rejects(fetchFeatures(P, { fetchImpl: all429.fetchImpl, hosts: HOSTS }), (err) => {
    assert.ok(err instanceof OverpassError);
    assert.equal(err.code, 'rate_limited');
    assert.equal(err.attempts.length, 3);
    return true;
  });
  // Now every host is paused: no fetch at all, still rate_limited.
  const none = scripted([]);
  await assert.rejects(fetchFeatures(P, { fetchImpl: none.fetchImpl, hosts: HOSTS }), { code: 'rate_limited' });
  assert.equal(none.calls.length, 0);
});

test('fetchFeatures throws at once on a 400 with the body excerpt', async () => {
  const body = '<html><body><p><strong style="color:#FF0000">Error</strong>: line 2: parse error: Unknown type "wayy" </p></body></html>';
  const { fetchImpl, calls } = scripted([() => textResponse(body, 400), () => jsonResponse(load('overpass-stream.json'))]);
  await assert.rejects(fetchFeatures(P, { fetchImpl, hosts: HOSTS }), (err) => {
    assert.ok(err instanceof OverpassError);
    assert.equal(err.code, 'bad_query');
    assert.match(err.message, /parse error: Unknown type "wayy"/);
    assert.ok(!err.message.includes('<p>'), 'HTML stripped');
    return true;
  });
  assert.equal(calls.length, 1, 'no fallback for a query bug');
});

test('fetchFeatures treats a 200 with a runtime remark as a failure', async () => {
  const { fetchImpl, calls } = scripted([() => jsonResponse(load('overpass-remark.json')), () => jsonResponse(load('overpass-stream.json'))]);
  const r = await fetchFeatures(P, { fetchImpl, hosts: HOSTS });
  assert.equal(calls.length, 2);
  assert.equal(r.host, HOSTS[1]);
  assert.match(r.attempts[0].remark, /timed out/);

  const allRemark = scripted(HOSTS.map(() => () => jsonResponse(load('overpass-remark.json'))));
  await assert.rejects(fetchFeatures(P, { fetchImpl: allRemark.fetchImpl, hosts: HOSTS }), (err) => {
    assert.equal(err.code, 'all_hosts_failed');
    assert.equal(err.attempts.length, 3);
    assert.ok(err.attempts.every((a) => /timed out/.test(a.remark)));
    return true;
  });
  // A harmless remark (no "error" / "timed out") is kept and the data used.
  const note = { ...load('overpass-stream.json'), remark: 'Mirror notice: data refreshed hourly.' };
  const ok = await fetchFeatures(P, { fetchImpl: scripted([() => jsonResponse(note)]).fetchImpl, hosts: HOSTS });
  assert.equal(ok.remark, 'Mirror notice: data refreshed hourly.');
});

test('fetchFeatures moves on after network errors, unreadable JSON and timeouts', async () => {
  const { fetchImpl, calls } = scripted([
    () => { throw new TypeError('Failed to fetch'); },
    () => textResponse('<html>not json</html>', 200),
    () => jsonResponse(load('overpass-stream.json')),
  ]);
  const r = await fetchFeatures(P, { fetchImpl, hosts: HOSTS });
  assert.equal(calls.length, 3);
  assert.equal(r.host, HOSTS[2]);
  assert.match(r.attempts[0].error, /Failed to fetch/);
  assert.match(r.attempts[1].error, /JSON/);

  const slow = scripted([hanging, () => jsonResponse(load('overpass-stream.json'))]);
  const t0 = Date.now();
  const r2 = await fetchFeatures(P, { fetchImpl: slow.fetchImpl, hosts: HOSTS, timeoutMs: 40 });
  assert.equal(r2.host, HOSTS[1]);
  assert.match(r2.attempts[0].error, /timeout after 40 ms/);
  assert.ok(Date.now() - t0 < 2000);

  const allDown = scripted(HOSTS.map(() => () => textResponse('', 503)));
  await assert.rejects(fetchFeatures(P, { fetchImpl: allDown.fetchImpl, hosts: HOSTS }), { code: 'all_hosts_failed' });
  await assert.rejects(fetchFeatures(P, { fetchImpl: scripted([]).fetchImpl, hosts: [] }), { code: 'all_hosts_failed' });
});

test('fetchFeatures rejects with aborted when the caller cancels', async () => {
  const controller = new AbortController();
  const { fetchImpl, calls } = scripted([hanging, hanging, hanging]);
  const pending = fetchFeatures(P, { fetchImpl, hosts: HOSTS, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { code: 'aborted' });
  assert.equal(calls.length, 1, 'no further hosts after cancelling');
  // Already aborted: no fetch at all.
  const done = new AbortController();
  done.abort();
  const none = scripted([]);
  await assert.rejects(fetchFeatures(P, { fetchImpl: none.fetchImpl, hosts: HOSTS, signal: done.signal }), { code: 'aborted' });
  assert.equal(none.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Terrain

test('fitSlope is ordinary least squares', () => {
  const exact = fitSlope([-600, -300, -150, 0, 150, 300, 600], [-1199, -599, -299, 1, 301, 601, 1201]);
  near(exact.slope, 2, 1e-12);
  near(exact.intercept, 1, 1e-9);
  near(exact.r2, 1, 1e-12);
  const two = fitSlope([0, 10], [5, 0]);
  near(two.slope, -0.5, 1e-12);
  near(two.intercept, 5, 1e-12);
  // Hand-computed: sxy = 4.95, sxx = 5 -> slope 0.99.
  const noisy = fitSlope([0, 1, 2, 3], [0, 1.2, 1.8, 3.1]);
  assert.ok(noisy.r2 > 0.98 && noisy.r2 < 1);
  near(noisy.slope, 0.99, 1e-9);
  near(noisy.intercept, 1.525 - 0.99 * 1.5, 1e-9);
  const flat = fitSlope([0, 1, 2], [4, 4, 4]);
  assert.equal(flat.slope, 0);
  assert.equal(flat.r2, 1);
  assert.ok(Number.isNaN(fitSlope([1], [2]).slope));
  assert.ok(Number.isNaN(fitSlope([1, 1], [2, 3]).slope), 'no spread in x');
  near(fitSlope([0, 1, NaN, 2], [0, 2, 99, 4]).slope, 2, 1e-12, 'non-finite pairs ignored');
});

function elevationFetch(fixture, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return status === 200 ? jsonResponse(load(fixture)) : textResponse('', status);
  };
  return { fetchImpl, calls };
}

test('terrainSlope requests seven coordinates in order along the bearing', async () => {
  const { fetchImpl, calls } = elevationFetch('elevation-flat.json');
  await terrainSlope(P, 0, { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, config.ELEVATION_URL);
  const lats = url.searchParams.get('latitude').split(',').map(Number);
  const lons = url.searchParams.get('longitude').split(',').map(Number);
  assert.equal(lats.length, 7);
  assert.equal(lons.length, 7);
  for (let i = 1; i < 7; i++) assert.ok(lats[i] > lats[i - 1], 'northward bearing: latitudes increase from -600 m to +600 m');
  near(lats[3], P.lat, 1e-6, 'the middle sample is the point itself');
  near(lons[3], P.lon, 1e-6);
  const expected = [-600, -300, -150, 0, 150, 300, 600].map((d) => destination(P, 0, d));
  expected.forEach((e, i) => {
    near(lats[i], e.lat, 2e-6, `latitude ${i}`);
    near(lons[i], e.lon, 2e-6, `longitude ${i}`);
  });

  const east = elevationFetch('elevation-flat.json');
  await terrainSlope(P, 90, { fetchImpl: east.fetchImpl });
  const eLons = new URL(east.calls[0].url).searchParams.get('longitude').split(',').map(Number);
  for (let i = 1; i < 7; i++) assert.ok(eLons[i] > eLons[i - 1], 'eastward bearing: longitudes increase');
  near(eLons[0], destination(P, 270, 600).lon, 2e-6);
  near(eLons[6], destination(P, 90, 600).lon, 2e-6);
});

test('terrainSlope classifies the three elevation fixtures', async () => {
  const down = await terrainSlope(P, 100, { fetchImpl: elevationFetch('elevation-downhill.json').fetchImpl });
  assert.equal(down.verdict, 'downhill');
  assert.ok(down.dropM >= config.TERRAIN_MIN_DROP_M);
  near(down.dropM, 13.66, 0.05, 'fitted drop over the 1200 m span');
  assert.ok(down.slope < 0);
  assert.equal(down.confidence, 'low');
  assert.equal(down.elevations.length, 7);
  assert.deepEqual(down.elevations.map((e) => e.distanceM), [-600, -300, -150, 0, 150, 300, 600]);
  assert.equal(down.elevations[0].elevation, 621.4);
  assert.ok(down.r2 > 0.99);

  const up = await terrainSlope(P, 100, { fetchImpl: elevationFetch('elevation-uphill.json').fetchImpl });
  assert.equal(up.verdict, 'uphill');
  assert.ok(up.dropM <= -config.TERRAIN_MIN_DROP_M);
  near(up.dropM, -down.dropM, 1e-9);

  const flat = await terrainSlope(P, 100, { fetchImpl: elevationFetch('elevation-flat.json').fetchImpl });
  assert.equal(flat.verdict, 'flat');
  assert.ok(Math.abs(flat.dropM) < config.TERRAIN_MIN_DROP_M);
});

test('terrainSlope resolves null on 429, errors, bad payloads and cancellation', async () => {
  assert.equal(await terrainSlope(P, 100, { fetchImpl: elevationFetch('elevation-downhill.json', { status: 429 }).fetchImpl }), null);
  assert.equal(await terrainSlope(P, 100, { fetchImpl: elevationFetch('elevation-downhill.json', { status: 503 }).fetchImpl }), null);
  assert.equal(await terrainSlope(P, 100, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), null);
  assert.equal(await terrainSlope(P, 100, { fetchImpl: async () => jsonResponse({ error: true, reason: 'bad' }) }), null);
  assert.equal(await terrainSlope(P, 100, { fetchImpl: async () => jsonResponse({ elevation: [1, 2, 3] }) }), null, 'wrong count');
  assert.equal(await terrainSlope(P, 100, { fetchImpl: async () => jsonResponse({ elevation: [1, 2, 3, null, 5, 6, 7] }) }), null, 'missing value');
  assert.equal(await terrainSlope(P, 100, { fetchImpl: async () => textResponse('nope', 200) }), null, 'not JSON');
  assert.equal(await terrainSlope(P, NaN, { fetchImpl: elevationFetch('elevation-downhill.json').fetchImpl }), null, 'no bearing');
  const done = new AbortController();
  done.abort();
  const { fetchImpl, calls } = elevationFetch('elevation-downhill.json');
  assert.equal(await terrainSlope(P, 100, { fetchImpl, signal: done.signal }), null);
  assert.equal(calls.length, 0, 'cancelled before the request');
  // Cancelling mid-flight also yields null rather than an exception.
  const controller = new AbortController();
  const pending = terrainSlope(P, 100, { fetchImpl: hanging, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  assert.equal(await pending, null);
});
