// docs/geo.js — geometry helpers for Stream Checker.
//
// Pure functions, no DOM. Angles are degrees; bearings are compass bearings
// (0 = north, 90 = east, in [0, 360)). Points are {lat, lon} objects.
//
// Distances use a spherical Earth with the mean radius; over the few hundred
// metres this app cares about, the error against an ellipsoid is far below
// what a phone's GPS can resolve.

const EARTH_RADIUS_M = 6371008.8; // IUGG mean radius
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Wrap any angle into [0, 360). NaN stays NaN; -0 becomes 0. */
export function normalizeDeg(d) {
  const n = ((d % 360) + 360) % 360;
  return n === 0 ? 0 : n; // folds -0 into +0
}

/** Signed smallest difference a - b, in (-180, 180]. */
export function angleDiff(a, b) {
  let d = normalizeDeg(a - b);
  if (d > 180) d -= 360;
  return d;
}

/** Unsigned smallest difference between two bearings, 0..180. */
export function absAngleDiff(a, b) {
  return Math.abs(angleDiff(a, b));
}

const CARDINALS_16 = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

/**
 * Compass point name for a bearing. `points` is 4, 8 or 16; the 16-point
 * names are subsampled for the coarser roses (every 4th / 2nd entry).
 */
export function toCardinal(deg, points = 16) {
  if (!Number.isFinite(deg)) return '';
  const n = points === 4 || points === 8 ? points : 16;
  const step = 16 / n;
  const idx = Math.round(normalizeDeg(deg) / (360 / n)) % n;
  return CARDINALS_16[idx * step];
}

/** Great-circle distance in metres (haversine). */
export function haversineM(a, b) {
  const phi1 = a.lat * DEG;
  const phi2 = b.lat * DEG;
  const dPhi = (b.lat - a.lat) * DEG;
  const dLambda = (b.lon - a.lon) * DEG;
  const s = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial great-circle bearing from a to b, in [0, 360). */
export function bearingDeg(a, b) {
  const phi1 = a.lat * DEG;
  const phi2 = b.lat * DEG;
  const dLambda = (b.lon - a.lon) * DEG;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return normalizeDeg(Math.atan2(y, x) * RAD);
}

/**
 * Point reached by travelling `distanceM` along `bearing` from p (spherical
 * direct problem). A negative distance walks backwards along the bearing.
 */
export function destination(p, bearing, distanceM) {
  const phi1 = p.lat * DEG;
  const lambda1 = p.lon * DEG;
  const theta = bearing * DEG;
  const delta = distanceM / EARTH_RADIUS_M;
  const sinPhi2 = Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)));
  const y = Math.sin(theta) * Math.sin(delta) * Math.cos(phi1);
  const x = Math.cos(delta) - Math.sin(phi1) * sinPhi2;
  const lambda2 = lambda1 + Math.atan2(y, x);
  // Wrap longitude into [-180, 180).
  const lon = ((lambda2 * RAD + 540) % 360) - 180;
  return { lat: phi2 * RAD, lon };
}

/**
 * Local equirectangular projection centred on `origin`: x metres east, y
 * metres north. Accurate to well under a metre within a few kilometres of the
 * origin, which is all the nearest-segment search needs. The longitude
 * difference is wrapped so the projection also behaves near the antimeridian.
 */
export function localProjection(origin) {
  const lat0 = origin.lat;
  const lon0 = origin.lon;
  const kx = EARTH_RADIUS_M * DEG * Math.cos(lat0 * DEG); // metres per degree of longitude here
  const ky = EARTH_RADIUS_M * DEG; // metres per degree of latitude
  return {
    toXY(p) {
      const dLon = ((p.lon - lon0 + 540) % 360) - 180;
      return { x: dLon * kx, y: (p.lat - lat0) * ky };
    },
    fromXY(q) {
      // Guard kx = 0 at the poles; nothing there flows anyway.
      const dLon = kx === 0 ? 0 : q.x / kx;
      return { lat: lat0 + q.y / ky, lon: ((lon0 + dLon + 540) % 360) - 180 };
    },
  };
}

function isPoint(p) {
  return p != null && Number.isFinite(p.lat) && Number.isFinite(p.lon);
}

/**
 * Nearest segment of a polyline to `point`.
 *
 * Works in the local projection around the query point: for each segment AB
 * the foot of the perpendicular from the point is found as the parameter
 * t = (P-A)·(B-A) / |B-A|², clamped to [0, 1] so that points beyond either
 * end measure their distance to that end node. The bearing is that of the
 * segment in node order (index -> index + 1), which for OSM waterways is the
 * mapped flow direction. Zero-length segments are skipped.
 *
 * Returns { distanceM, index, bearing, closest } or null when the polyline
 * has fewer than two distinct usable nodes.
 */
export function nearestSegment(point, geometry) {
  if (!isPoint(point) || !Array.isArray(geometry) || geometry.length < 2) return null;
  const proj = localProjection(point);
  const xy = geometry.map((p) => (isPoint(p) ? proj.toXY(p) : null));
  let best = null;
  for (let i = 0; i < xy.length - 1; i++) {
    const a = xy[i];
    const b = xy[i + 1];
    if (!a || !b) continue;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    if (len2 === 0) continue;
    // The query point is the origin of the projection, so P - A = -A.
    let t = (-a.x * vx + -a.y * vy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = a.x + t * vx;
    const cy = a.y + t * vy;
    const d = Math.hypot(cx, cy);
    if (best === null || d < best.distanceM) {
      best = { distanceM: d, index: i, t, cx, cy };
    }
  }
  if (best === null) return null;
  return {
    distanceM: best.distanceM,
    index: best.index,
    bearing: bearingDeg(geometry[best.index], geometry[best.index + 1]),
    closest: proj.fromXY({ x: best.cx, y: best.cy }),
  };
}

/**
 * Ray-casting point-in-polygon test in lon/lat space. The ring may be open
 * (first != last) or closed (first == last): the wrap-around edge from the
 * last vertex to the first supplies the closing segment, and a duplicated
 * closing vertex only adds a zero-length edge that never flips the parity.
 * Points exactly on an edge may land on either side; that is fine here.
 */
export function pointInPolygon(point, ring) {
  if (!isPoint(point) || !Array.isArray(ring) || ring.length < 3) return false;
  const x = point.lon;
  const y = point.lat;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    if (!isPoint(pi) || !isPoint(pj)) continue;
    const xi = pi.lon;
    const yi = pi.lat;
    const xj = pj.lon;
    const yj = pj.lat;
    // Does the horizontal ray from the point cross this edge?
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * Distance in metres from a point to a polyline. A single-node geometry
 * measures to that node; an empty or unusable geometry is infinitely far.
 */
export function distanceToPolyline(point, geometry) {
  if (!isPoint(point) || !Array.isArray(geometry)) return Infinity;
  const seg = nearestSegment(point, geometry);
  if (seg) return seg.distanceM;
  const nodes = geometry.filter(isPoint);
  if (nodes.length === 0) return Infinity;
  // Only degenerate segments (or one node): nearest node distance.
  let best = Infinity;
  for (const n of nodes) best = Math.min(best, haversineM(point, n));
  return best;
}
