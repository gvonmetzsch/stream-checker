// docs/waterways.js — map lookups for Stream Checker.
//
// Overpass (OpenStreetMap) gives the mapped waterways, lakes and coastlines
// around a point; Open-Meteo gives a coarse terrain slope when nothing is
// mapped. Everything here is importable from Node: the network calls take a
// `fetchImpl` so the tests can mock them, and nothing touches the DOM.
//
// OSM convention relied on throughout: `waterway=*` ways are drawn in the
// direction of flow, so the node order of the nearest segment is the expected
// bearing of the water.

import * as config from './config.js';
import { nearestSegment, haversineM, destination, distanceToPolyline, pointInPolygon } from './geo.js';

export const WATERWAY_KINDS = ['river', 'stream', 'canal', 'drain', 'ditch', 'brook', 'tidal_channel'];
const WATERWAY_REGEX = `^(${WATERWAY_KINDS.join('|')})$`;

const CONFIDENCE_BY_KIND = {
  river: 'high',
  stream: 'high',
  brook: 'high',
  canal: 'medium',
  drain: 'medium',
  ditch: 'medium',
};

// Open-Meteo answers in well under a second; anything longer than this is a
// stuck connection and the terrain fallback is simply skipped.
const TERRAIN_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Query building

/** Coordinate formatting for Overpass QL: fixed notation, no exponent, no trailing zeros. */
function fmt(n) {
  const s = Number(n).toFixed(7).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/** Bounding box of the circle of `radiusM` around `center`, as {south, west, north, east}. */
function circleBounds(center, radiusM) {
  return {
    south: destination(center, 180, radiusM).lat,
    west: destination(center, 270, radiusM).lon,
    north: destination(center, 0, radiusM).lat,
    east: destination(center, 90, radiusM).lon,
  };
}

/**
 * The live query: one request, three statements, each printed in the output
 * mode its consumer needs.
 *  - waterway ways within radii.waterway with full geometry (the flow bearing
 *    comes from the node order of the nearest segment);
 *  - natural=water ways/relations within radii.water and coastline ways within
 *    radii.coast with their centre only (the server-side `around` already
 *    answers "is there a lake next to me", and lake outlines can be huge);
 *  - the natural=water areas that contain the point (standing on a pier).
 */
export function buildQuery(point, radii = config.RADIUS) {
  const r = { ...config.RADIUS, ...(radii || {}) };
  const lat = fmt(point.lat);
  const lon = fmt(point.lon);
  return [
    '[out:json][timeout:20];',
    `way(around:${r.waterway},${lat},${lon})[waterway~"${WATERWAY_REGEX}"][area!=yes];`,
    'out tags geom;',
    '(',
    `  way(around:${r.water},${lat},${lon})[natural=water];`,
    `  rel(around:${r.water},${lat},${lon})[natural=water];`,
    `  way(around:${r.coast},${lat},${lon})[natural=coastline];`,
    ');',
    'out tags center;',
    `is_in(${lat},${lon})->.a;`,
    'area.a[natural=water];',
    'out tags;',
  ].join('\n');
}

/**
 * The "Save streams near me" query: every feature class within `radiusM`,
 * with geometry clipped to the bounding box of that circle. Ways use
 * `out tags geom(bbox)`; relations need plain `out geom(bbox)` because the
 * `tags` mode drops relation members, and the cache needs lake outlines.
 */
export function buildAreaQuery(center, radiusM = config.RADIUS.offline) {
  const r = Math.max(1, Math.round(radiusM));
  const lat = fmt(center.lat);
  const lon = fmt(center.lon);
  const b = circleBounds(center, r);
  const box = `${fmt(b.south)},${fmt(b.west)},${fmt(b.north)},${fmt(b.east)}`;
  return [
    '[out:json][timeout:60];',
    '(',
    `  way(around:${r},${lat},${lon})[waterway~"${WATERWAY_REGEX}"][area!=yes];`,
    `  way(around:${r},${lat},${lon})[natural=water];`,
    `  way(around:${r},${lat},${lon})[natural=coastline];`,
    ');',
    `out tags geom(${box});`,
    `rel(around:${r},${lat},${lon})[natural=water];`,
    `out geom(${box});`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Response parsing

function isCoord(p) {
  return p != null && Number.isFinite(p.lat) && Number.isFinite(p.lon);
}

/**
 * Geometry array as printed by `out geom`. Entries outside a clipping bbox
 * can be missing or null depending on the server version, so anything that
 * is not a finite coordinate is dropped.
 */
function cleanGeometry(geometry) {
  if (!Array.isArray(geometry)) return null;
  const pts = [];
  for (const g of geometry) if (isCoord(g)) pts.push({ lat: g.lat, lon: g.lon });
  return pts;
}

function nameOf(tags) {
  return tags.name || tags['name:en'] || null;
}

function isBidirectional(tags) {
  return tags.waterway === 'tidal_channel' || tags.tidal === 'yes' || tags.flow_direction === 'both';
}

function samePoint(a, b) {
  return Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
}

function isClosed(ring) {
  return ring.length >= 4 && samePoint(ring[0], ring[ring.length - 1]);
}

/**
 * Stitch multipolygon member ways into rings by joining ways that share an
 * end node, in either direction. Geometry clipped to a bbox no longer shares
 * end nodes, so leftovers stay as open chains; pointInPolygon closes those
 * implicitly, which is the right approximation for a shore cut by the box.
 */
function assembleRings(chains) {
  const pool = chains.filter((c) => c.length >= 2).map((c) => c.slice());
  const rings = [];
  while (pool.length) {
    let ring = pool.shift();
    let grew = true;
    while (grew && !isClosed(ring)) {
      grew = false;
      const head = ring[0];
      const tail = ring[ring.length - 1];
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i];
        const cHead = c[0];
        const cTail = c[c.length - 1];
        if (samePoint(cHead, tail)) ring = ring.concat(c.slice(1));
        else if (samePoint(cTail, tail)) ring = ring.concat(c.slice(0, -1).reverse());
        else if (samePoint(cTail, head)) ring = c.slice(0, -1).concat(ring);
        else if (samePoint(cHead, head)) ring = c.slice(1).reverse().concat(ring);
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    rings.push(ring);
  }
  // Largest ring first so `geometry` (the primary outline) is the main shore.
  rings.sort((a, b) => b.length - a.length);
  return rings;
}

/** Outer rings, inner rings (islands) and the primary outline of a natural=water element. */
function areaGeometry(el) {
  if (el.type === 'way') {
    const g = cleanGeometry(el.geometry);
    return g && g.length ? { geometry: g, rings: [g], holes: [] } : null;
  }
  if (el.type === 'relation' && Array.isArray(el.members)) {
    const outers = [];
    const inners = [];
    for (const m of el.members) {
      if (!m || m.type !== 'way') continue;
      const g = cleanGeometry(m.geometry);
      if (!g || g.length < 2) continue;
      // An empty role on a multipolygon member means outer, per the OSM wiki.
      if (m.role === 'inner') inners.push(g);
      else if (!m.role || m.role === 'outer') outers.push(g);
    }
    const rings = assembleRings(outers);
    if (!rings.length) return null;
    return { geometry: rings[0], rings, holes: assembleRings(inners) };
  }
  return null;
}

/** Centre of an element: the printed centre, else the bounds centre, else the vertex mean. */
function centerOf(el, geometry) {
  if (isCoord(el.center)) return { lat: el.center.lat, lon: el.center.lon };
  const b = el.bounds;
  if (b && [b.minlat, b.maxlat, b.minlon, b.maxlon].every(Number.isFinite)) {
    return { lat: (b.minlat + b.maxlat) / 2, lon: (b.minlon + b.maxlon) / 2 };
  }
  if (geometry && geometry.length) {
    let lat = 0;
    let lon = 0;
    for (const p of geometry) {
      lat += p.lat;
      lon += p.lon;
    }
    return { lat: lat / geometry.length, lon: lon / geometry.length };
  }
  return null;
}

/**
 * Overpass JSON -> Features. Elements are classified by tags, deduplicated by
 * type and id (a way can be printed by more than one `out`), and nodes are
 * ignored. Relation outlines, when the response carries member geometry, are
 * assembled into rings: `geometry` is the largest outer ring, `rings` all of
 * them and `holes` the inner rings.
 */
export function parseOverpass(json) {
  const out = { waterways: [], waterAreas: [], coastlines: [], containing: [], timestamp: null, remark: null };
  if (!json || typeof json !== 'object') return out;
  const base = json.osm3s && json.osm3s.timestamp_osm_base;
  out.timestamp = typeof base === 'string' ? base : null;
  out.remark = typeof json.remark === 'string' ? json.remark : null;
  const seen = new Set();
  for (const el of Array.isArray(json.elements) ? json.elements : []) {
    if (!el || typeof el !== 'object' || !el.type) continue;
    const key = `${el.type}/${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = el.tags && typeof el.tags === 'object' ? el.tags : {};

    if (el.type === 'area') {
      out.containing.push({ id: el.id, name: nameOf(tags), kind: tags.water || tags.natural || 'water', tags });
      continue;
    }

    if (el.type === 'way' && tags.waterway && tags.area !== 'yes') {
      out.waterways.push({
        id: el.id,
        name: nameOf(tags),
        kind: tags.waterway,
        tags,
        geometry: cleanGeometry(el.geometry) || [],
        bidirectional: isBidirectional(tags),
      });
    }

    if ((el.type === 'way' || el.type === 'relation') && tags.natural === 'water') {
      const geom = areaGeometry(el);
      const entry = { id: el.id, name: nameOf(tags), kind: tags.water || 'water', tags, center: centerOf(el, geom && geom.geometry) };
      if (geom) {
        entry.geometry = geom.geometry;
        entry.rings = geom.rings;
        entry.holes = geom.holes;
      }
      out.waterAreas.push(entry);
    }

    if (el.type === 'way' && tags.natural === 'coastline') {
      const geometry = cleanGeometry(el.geometry);
      // Coastline ways are open polylines (land on the left, water on the
      // right), never rings: `kind` marks them so distance code never closes them.
      const entry = { id: el.id, kind: 'coastline', tags, center: centerOf(el, geometry) };
      if (geometry && geometry.length) entry.geometry = geometry;
      out.coastlines.push(entry);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetching with host fallback

export class OverpassError extends Error {
  constructor(code, message, attempts = []) {
    super(message);
    this.name = 'OverpassError';
    this.code = code;
    this.attempts = attempts;
  }
}

// Hosts that answered 429, with the time until which they are left alone.
const backoffUntil = new Map();

/** True while `host` is paused after a 429. */
export function isRateLimited(host, now = Date.now()) {
  const until = backoffUntil.get(host);
  return until != null && until > now;
}

/** Forget every 429 pause (used by tests and by a manual retry). */
export function clearRateLimits() {
  backoffUntil.clear();
}

function excerpt(text, max = 240) {
  const plain = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

/**
 * POST the query to each host in turn until one answers with usable data.
 *
 * Per host: a form-encoded body (`data=<query>`, a CORS "simple request" with
 * no preflight) and its own AbortController timeout. 429 pauses that host for
 * config.OVERPASS_BACKOFF_MS; 400 means the query itself is wrong and throws
 * at once with the server's explanation; everything else (406 without a
 * Referer, 503 when overloaded, network errors, timeouts, a 200 carrying a
 * runtime `remark`) moves on to the next host.
 */
export async function fetchFeatures(point, { fetchImpl = fetch, hosts = config.OVERPASS_HOSTS, timeoutMs = config.OVERPASS_TIMEOUT_MS, signal, query } = {}) {
  const ql = query || buildQuery(point);
  const body = new URLSearchParams({ data: ql }).toString();
  const attempts = [];
  let rateLimitedOnly = true;

  for (const host of hosts) {
    if (signal && signal.aborted) throw new OverpassError('aborted', 'map lookup cancelled', attempts);
    if (isRateLimited(host)) {
      attempts.push({ host, skipped: 'rate_limited' });
      continue;
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let bodyText = '';
    try {
      response = await fetchImpl(host, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
      // The timer stays armed until the body has been read: a server that
      // sends headers and then stalls must not hang the check.
      if (response.status !== 429) {
        bodyText = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
      }
    } catch (err) {
      if (signal && signal.aborted) throw new OverpassError('aborted', 'map lookup cancelled', attempts);
      attempts.push({ host, status: response ? response.status : undefined, error: controller.signal.aborted ? `timeout after ${timeoutMs} ms` : String((err && err.message) || err) });
      rateLimitedOnly = false;
      continue;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    const status = response.status;
    if (status === 429) {
      backoffUntil.set(host, Date.now() + config.OVERPASS_BACKOFF_MS);
      attempts.push({ host, status });
      continue;
    }
    if (status === 400) {
      throw new OverpassError('bad_query', `Overpass rejected the query (400): ${excerpt(bodyText)}`, [...attempts, { host, status }]);
    }
    if (!response.ok) {
      attempts.push({ host, status });
      rateLimitedOnly = false;
      continue;
    }

    let json;
    try {
      json = JSON.parse(bodyText);
    } catch (err) {
      attempts.push({ host, status, error: `unreadable JSON: ${String((err && err.message) || err)}` });
      rateLimitedOnly = false;
      continue;
    }
    const remark = json && typeof json.remark === 'string' ? json.remark : null;
    if (remark && /error|timed out/i.test(remark)) {
      attempts.push({ host, status, remark });
      rateLimitedOnly = false;
      continue;
    }

    const features = parseOverpass(json);
    const dataTime = features.timestamp ? Date.parse(features.timestamp) : NaN;
    const stale = Number.isFinite(dataTime) && Date.now() - dataTime > config.OVERPASS_STALE_MS;
    attempts.push({ host, status, ok: true });
    return { ...features, host, source: 'live', stale, fetchedAt: new Date().toISOString(), attempts };
  }

  if (attempts.length && rateLimitedOnly) {
    throw new OverpassError('rate_limited', 'every Overpass host is rate limited; try again shortly', attempts);
  }
  throw new OverpassError('all_hosts_failed', `no Overpass host answered (${attempts.length} attempt${attempts.length === 1 ? '' : 's'})`, attempts);
}

// ---------------------------------------------------------------------------
// Interpreting features

/**
 * The mapped flow at the nearest waterway within radii.waterway, or null.
 * The bearing is the node order of the nearest segment; confidence follows
 * the feature class (natural channels high, engineered channels medium,
 * anything else low). Tidal and two-way channels are exempt from judgement.
 */
export function expectedFlow(features, point, radii = config.RADIUS) {
  if (!features || !Array.isArray(features.waterways)) return null;
  const maxM = radii && Number.isFinite(radii.waterway) ? radii.waterway : config.RADIUS.waterway;
  let best = null;
  for (const w of features.waterways) {
    const seg = nearestSegment(point, w.geometry);
    if (!seg || seg.distanceM > maxM) continue;
    if (!best || seg.distanceM < best.seg.distanceM) best = { w, seg };
  }
  if (!best) return null;
  const { w, seg } = best;
  let reason = null;
  if (w.bidirectional) {
    if (w.kind === 'tidal_channel') reason = 'tidal channel: the water goes both ways';
    else if (w.tags && w.tags.tidal === 'yes') reason = 'tidal reach: the water goes both ways';
    else reason = 'mapped as flowing both ways';
  }
  return {
    bearing: seg.bearing,
    name: w.name || null,
    kind: w.kind,
    distanceM: seg.distanceM,
    confidence: CONFIDENCE_BY_KIND[w.kind] || 'low',
    exempt: Boolean(w.bidirectional),
    reason,
    wayId: w.id,
  };
}

/** True when the point lies inside a water area's outline (outer rings minus islands). */
export function areaContains(area, point) {
  if (!area) return false;
  const rings = Array.isArray(area.rings) && area.rings.length ? area.rings : area.geometry ? [area.geometry] : [];
  if (!rings.some((ring) => pointInPolygon(point, ring))) return false;
  const holes = Array.isArray(area.holes) ? area.holes : [];
  return !holes.some((hole) => pointInPolygon(point, hole));
}

/**
 * Distance from the point to a water area or coastline. With an outline it is
 * the distance to the shore (0 inside); with only a centre it is the distance
 * to that centre, flagged `approx` because a big lake's centre can be far
 * from a shore that is right next to the user.
 */
export function featureDistance(feature, point) {
  if (!feature) return null;
  if (feature.kind === 'coastline' || feature.polyline === true) return coastlineDistance(feature, point);
  const rings = Array.isArray(feature.rings) && feature.rings.length ? feature.rings : feature.geometry ? [feature.geometry] : [];
  if (rings.length) {
    if (areaContains(feature, point)) return { distanceM: 0, contains: true, approx: false };
    let d = Infinity;
    for (const ring of rings) d = Math.min(d, distanceToPolyline(point, ring));
    return { distanceM: d, contains: false, approx: false };
  }
  if (isCoord(feature.center)) return { distanceM: haversineM(point, feature.center), contains: false, approx: true };
  return null;
}

/**
 * Distance to a coastline way, which is always an open polyline: a coast
 * kilometres away must never read as "inside" because its ends happen to
 * enclose the point when joined.
 */
export function coastlineDistance(feature, point) {
  if (!feature) return null;
  if (Array.isArray(feature.geometry) && feature.geometry.length) {
    return { distanceM: distanceToPolyline(point, feature.geometry), contains: false, approx: false };
  }
  if (isCoord(feature.center)) return { distanceM: haversineM(point, feature.center), contains: false, approx: true };
  return null;
}

/**
 * natural=water areas whose water=* value describes flowing water. These are
 * riverbanks and channels drawn as polygons, not lakes, so they never produce
 * the "lakes don't go anywhere" verdict.
 */
export const FLOWING_WATER_KINDS = new Set(['river', 'canal', 'stream', 'ditch', 'drain', 'moat', 'lock', 'harbour', 'wastewater', 'fish_pass', 'rapids', 'tidal_channel']);

export function isLakeLike(kind) {
  return !FLOWING_WATER_KINDS.has(String(kind || 'water').toLowerCase());
}

/**
 * Lake and coast context for the verdict.
 *
 * Features with an outline (the offline cache) are measured against the
 * shore and must fall within the radius or contain the point. Centre-only
 * features come from the live query, where the server-side `around` filter
 * has already applied the radius to the outline, so they are accepted as
 * they are and report the centre distance for information. An `is_in` match
 * (`containing`) wins outright with distance 0.
 */
export function nearbyWater(features, point, radii = config.RADIUS) {
  const out = { lake: null, coast: null };
  if (!features) return out;
  const r = { ...config.RADIUS, ...(radii || {}) };

  const containing = (Array.isArray(features.containing) ? features.containing : []).filter((c) => c && isLakeLike(c.kind));
  if (containing.length) {
    const c = containing[0];
    out.lake = { name: c.name || null, kind: c.kind || 'water', distanceM: 0, contains: true };
  } else {
    let best = null;
    for (const a of Array.isArray(features.waterAreas) ? features.waterAreas : []) {
      if (!a || !isLakeLike(a.kind)) continue;
      const d = featureDistance(a, point);
      if (!d) continue;
      if (!d.contains && !d.approx && d.distanceM > r.water) continue;
      if (!best || d.distanceM < best.d.distanceM) best = { a, d };
    }
    if (best) out.lake = { name: best.a.name || null, kind: best.a.kind || 'water', distanceM: best.d.distanceM, contains: best.d.contains };
  }

  let coast = null;
  for (const c of Array.isArray(features.coastlines) ? features.coastlines : []) {
    const d = coastlineDistance(c, point);
    if (!d) continue;
    if (!d.approx && d.distanceM > r.coast) continue;
    if (!coast || d.distanceM < coast.distanceM) coast = { distanceM: d.distanceM };
  }
  out.coast = coast;
  return out;
}

// ---------------------------------------------------------------------------
// Terrain fallback

/** Ordinary least squares of elevation against distance. Non-finite pairs are ignored. */
export function fitSlope(distances, elevations) {
  const xs = [];
  const ys = [];
  const n = Math.min(distances.length, elevations.length);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(distances[i]) && Number.isFinite(elevations[i])) {
      xs.push(distances[i]);
      ys.push(elevations[i]);
    }
  }
  if (xs.length < 2) return { slope: NaN, intercept: NaN, r2: NaN };
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return { slope: NaN, intercept: NaN, r2: NaN };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  // r² = explained / total variance; a perfectly flat profile explains all of nothing.
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
}

/** Signed sample distances along the bearing: -600, -300, -150, 0, 150, 300, 600 for the defaults. */
function sampleDistances(distances) {
  const d = distances.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  return [...d.map((v) => -v).reverse(), 0, ...d];
}

/**
 * Coarse terrain slope along `bearing` from one Open-Meteo elevation request
 * for the point and +/- each distance along the bearing. Elevation is fitted
 * against signed distance; dropM is the fitted fall over the whole span,
 * positive when the ground drops along the bearing (water should flow that
 * way). Resolves null on any failure, including a 429 from the free tier.
 */
export async function terrainSlope(point, bearing, { fetchImpl = fetch, distances = config.TERRAIN_DISTANCES_M, signal } = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const timer = setTimeout(() => controller.abort(), TERRAIN_TIMEOUT_MS);
  try {
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon) || !Number.isFinite(bearing)) return null;
    if (signal) {
      if (signal.aborted) return null;
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const signed = sampleDistances(distances);
    if (signed.length < 3) return null;
    const span = 2 * Math.max(...signed);
    const samples = signed.map((d) => (d === 0 ? { lat: point.lat, lon: point.lon } : destination(point, bearing, d)));
    const url = `${config.ELEVATION_URL}?latitude=${samples.map((p) => p.lat.toFixed(6)).join(',')}&longitude=${samples.map((p) => p.lon.toFixed(6)).join(',')}`;
    const response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    if (!response || !response.ok) return null;
    const json = await response.json();
    const elevation = json && Array.isArray(json.elevation) ? json.elevation : null;
    if (!elevation || elevation.length !== samples.length || !elevation.every(Number.isFinite)) return null;
    const fit = fitSlope(signed, elevation);
    if (!Number.isFinite(fit.slope)) return null;
    const dropM = -fit.slope * span;
    const verdict = dropM >= config.TERRAIN_MIN_DROP_M ? 'downhill' : dropM <= -config.TERRAIN_MIN_DROP_M ? 'uphill' : 'flat';
    return {
      verdict,
      dropM,
      slope: fit.slope,
      r2: fit.r2,
      elevations: signed.map((distanceM, i) => ({ distanceM, elevation: elevation[i] })),
      confidence: 'low',
    };
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
