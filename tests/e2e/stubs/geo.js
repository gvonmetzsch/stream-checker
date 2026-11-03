// STUB (test only): minimal geo.js per CONTRACTS.md, used when the real module is absent.
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
export function normalizeDeg(d) { return ((d % 360) + 360) % 360; }
export function angleDiff(a, b) { let d = normalizeDeg(a - b); if (d > 180) d -= 360; return d; }
export function absAngleDiff(a, b) { return Math.abs(angleDiff(a, b)); }
export function toCardinal(d, points = 16) {
  const names = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  const step = 360 / points;
  const i = Math.round(normalizeDeg(d) / step) % points;
  return points === 16 ? names[i] : names[(i * 16) / points];
}
export function haversineM(a, b) {
  const dφ = rad(b.lat - a.lat), dλ = rad(b.lon - a.lon);
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function bearingDeg(a, b) {
  const φ1 = rad(a.lat), φ2 = rad(b.lat), Δλ = rad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2), x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeDeg(deg(Math.atan2(y, x)));
}
export function destination(p, bearing, distanceM) {
  const φ1 = rad(p.lat), λ1 = rad(p.lon), θ = rad(bearing), δ = distanceM / R;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: deg(φ2), lon: deg(λ2) };
}
export function localProjection(origin) {
  const k = Math.cos(rad(origin.lat));
  const m = 111320;
  return {
    toXY: (p) => ({ x: (p.lon - origin.lon) * m * k, y: (p.lat - origin.lat) * m }),
    fromXY: ({ x, y }) => ({ lat: origin.lat + y / m, lon: origin.lon + x / (m * k) }),
  };
}
export function nearestSegment(point, geometry) {
  if (!geometry || geometry.length < 2) return null;
  const proj = localProjection(point);
  const P = { x: 0, y: 0 };
  let best = null;
  for (let i = 0; i < geometry.length - 1; i++) {
    const A = proj.toXY(geometry[i]), B = proj.toXY(geometry[i + 1]);
    const abx = B.x - A.x, aby = B.y - A.y;
    const len2 = abx * abx + aby * aby || 1e-9;
    let t = ((P.x - A.x) * abx + (P.y - A.y) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    const C = { x: A.x + t * abx, y: A.y + t * aby };
    const d = Math.hypot(C.x - P.x, C.y - P.y);
    if (!best || d < best.distanceM) best = { distanceM: d, index: i, bearing: bearingDeg(geometry[i], geometry[i + 1]), closest: proj.fromXY(C) };
  }
  return best;
}
export function pointInPolygon(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lon, yi = ring[i].lat, xj = ring[j].lon, yj = ring[j].lat;
    const hit = yi > point.lat !== yj > point.lat && point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}
export function distanceToPolyline(point, geometry) { const s = nearestSegment(point, geometry); return s ? s.distanceM : Infinity; }
