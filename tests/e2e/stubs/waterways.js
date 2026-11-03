// STUB (test only): waterways.js per CONTRACTS.md, simplified.
import { RADIUS, OVERPASS_HOSTS, OVERPASS_TIMEOUT_MS, TERRAIN_DISTANCES_M, ELEVATION_URL } from './config.js';
import { nearestSegment, haversineM, destination } from './geo.js';
export class OverpassError extends Error { constructor(code, attempts) { super(code); this.code = code; this.attempts = attempts; } }
export function buildQuery(point, radii = RADIUS) { return `[out:json][timeout:20];(way(around:${radii.waterway},${point.lat},${point.lon})[waterway];);out tags geom;`; }
export function buildAreaQuery(center, radiusM) { return buildQuery(center, { waterway: radiusM }); }
export function parseOverpass(json) {
  const out = { waterways: [], waterAreas: [], coastlines: [], containing: [], timestamp: json && json.osm3s ? json.osm3s.timestamp_osm_base || null : null, remark: (json && json.remark) || null };
  for (const e of (json && json.elements) || []) {
    const tags = e.tags || {};
    if (tags.waterway && Array.isArray(e.geometry)) {
      out.waterways.push({ id: e.id, name: tags.name || null, kind: tags.waterway, tags, geometry: e.geometry, bidirectional: tags.waterway === 'tidal_channel' || tags.tidal === 'yes' || tags.flow_direction === 'both' });
    } else if (tags.natural === 'water') {
      out.waterAreas.push({ id: e.id, name: tags.name || null, kind: tags.water || 'water', tags, center: e.center || null, geometry: e.geometry || null });
    } else if (tags.natural === 'coastline') {
      out.coastlines.push({ id: e.id, tags, center: e.center || null, geometry: e.geometry || null });
    }
  }
  return out;
}
export async function fetchFeatures(point, { fetchImpl = fetch, hosts = OVERPASS_HOSTS, timeoutMs = OVERPASS_TIMEOUT_MS, signal, query } = {}) {
  const attempts = [];
  for (const host of hosts) {
    try {
      const res = await fetchImpl(host, { method: 'POST', body: new URLSearchParams({ data: query || buildQuery(point) }), signal });
      if (res.status === 429) throw new OverpassError('rate_limited', attempts);
      if (!res.ok) { attempts.push({ host, status: res.status }); continue; }
      const json = await res.json();
      if (json.remark) { attempts.push({ host, remark: json.remark }); continue; }
      const f = parseOverpass(json);
      return { ...f, host, source: 'live', stale: false, fetchedAt: Date.now() };
    } catch (err) {
      if (err && err.code === 'rate_limited') throw err;
      if (signal && signal.aborted) throw new OverpassError('aborted', attempts);
      attempts.push({ host, error: String(err) });
    }
  }
  throw new OverpassError('all_hosts_failed', attempts);
}
export function expectedFlow(features, point, radii = RADIUS) {
  let best = null;
  for (const w of features.waterways || []) {
    const seg = nearestSegment(point, w.geometry);
    if (!seg || seg.distanceM > radii.waterway) continue;
    if (!best || seg.distanceM < best.distanceM) {
      best = { bearing: seg.bearing, name: w.name, kind: w.kind, distanceM: seg.distanceM, confidence: ['river', 'stream'].includes(w.kind) ? 'high' : 'medium', exempt: !!w.bidirectional, reason: w.bidirectional ? 'bidirectional' : null, wayId: w.id };
    }
  }
  return best;
}
export function nearbyWater(features, point, radii = RADIUS) {
  let lake = null;
  for (const a of features.waterAreas || []) {
    if (a.center && haversineM(point, a.center) <= radii.water) lake = { name: a.name, kind: a.kind, distanceM: haversineM(point, a.center), contains: false };
  }
  let coast = null;
  for (const c of features.coastlines || []) {
    if (c.center && haversineM(point, c.center) <= radii.coast) coast = { distanceM: haversineM(point, c.center) };
  }
  return { lake, coast };
}
export function fitSlope(distances, elevations) {
  const n = distances.length; const mx = distances.reduce((a, b) => a + b, 0) / n; const my = elevations.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (distances[i] - mx) * (elevations[i] - my); sxx += (distances[i] - mx) ** 2; syy += (elevations[i] - my) ** 2; }
  const slope = sxx ? sxy / sxx : 0;
  return { slope, intercept: my - slope * mx, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : 0 };
}
export async function terrainSlope(point, bearing, { fetchImpl = fetch, distances = TERRAIN_DISTANCES_M, signal } = {}) {
  try {
    const ds = [...distances.map((d) => -d).reverse(), 0, ...distances];
    const pts = ds.map((d) => (d === 0 ? point : destination(point, d < 0 ? (bearing + 180) % 360 : bearing, Math.abs(d))));
    const url = `${ELEVATION_URL}?latitude=${pts.map((p) => p.lat.toFixed(5)).join(',')}&longitude=${pts.map((p) => p.lon.toFixed(5)).join(',')}`;
    const res = await fetchImpl(url, { signal });
    if (!res.ok) return null;
    const json = await res.json();
    const el = json.elevation;
    if (!Array.isArray(el) || el.length !== ds.length) return null;
    const { slope } = fitSlope(ds, el);
    const dropM = -(slope * (ds[ds.length - 1] - ds[0]));
    return { verdict: Math.abs(dropM) < 2 ? 'flat' : dropM > 0 ? 'downhill' : 'uphill', dropM, slope, elevations: ds.map((d, i) => ({ distanceM: d, elevation: el[i] })), confidence: 'low' };
  } catch { return null; }
}
