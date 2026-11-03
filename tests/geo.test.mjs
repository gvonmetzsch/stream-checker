// Unit tests for docs/geo.js: bearings, distances, projection, nearest segment, polygons.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeDeg,
  angleDiff,
  absAngleDiff,
  toCardinal,
  haversineM,
  bearingDeg,
  destination,
  localProjection,
  nearestSegment,
  pointInPolygon,
  distanceToPolyline,
} from '../docs/geo.js';

const P = { lat: 45.462, lon: -122.598 };
const METRES_PER_DEG = 111195.08; // 6371008.8 m * pi / 180

const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} expected ${expected} ± ${tol}, got ${actual}`);
const nearPoint = (a, b, tolM, msg) => near(haversineM(a, b), 0, tolM, msg);

test('normalizeDeg wraps into [0, 360) and folds -0', () => {
  assert.equal(normalizeDeg(0), 0);
  assert.equal(normalizeDeg(360), 0);
  assert.equal(normalizeDeg(720), 0);
  assert.equal(normalizeDeg(370), 10);
  assert.equal(normalizeDeg(-10), 350);
  assert.equal(normalizeDeg(-45), 315);
  assert.ok(Object.is(normalizeDeg(-0), 0));
  assert.ok(Object.is(normalizeDeg(-360), 0));
  near(normalizeDeg(359.9999), 359.9999, 1e-9);
  assert.ok(Number.isNaN(normalizeDeg(NaN)));
});

test('angleDiff is the signed smallest difference in (-180, 180]', () => {
  assert.equal(angleDiff(10, 350), 20);
  assert.equal(angleDiff(350, 10), -20);
  assert.equal(angleDiff(45, 45), 0);
  assert.equal(angleDiff(0, 180), 180);
  assert.equal(angleDiff(180, 0), 180);
  assert.equal(angleDiff(90, 270), 180);
  assert.equal(angleDiff(270, 90), 180);
  assert.equal(angleDiff(-30, 30), -60);
  assert.equal(angleDiff(179, -179), -2);
  assert.equal(absAngleDiff(350, 10), 20);
  assert.equal(absAngleDiff(10, 350), 20);
  assert.equal(absAngleDiff(0, 180), 180);
});

test('toCardinal names the 16-, 8- and 4-point roses', () => {
  assert.equal(toCardinal(0), 'N');
  assert.equal(toCardinal(11.2), 'N');
  assert.equal(toCardinal(11.3), 'NNE');
  assert.equal(toCardinal(45), 'NE');
  assert.equal(toCardinal(90), 'E');
  assert.equal(toCardinal(112.5), 'ESE');
  assert.equal(toCardinal(180), 'S');
  assert.equal(toCardinal(270), 'W');
  assert.equal(toCardinal(337.5), 'NNW');
  assert.equal(toCardinal(359), 'N');
  assert.equal(toCardinal(-90), 'W');
  assert.equal(toCardinal(450), 'E');
  assert.equal(toCardinal(22.4, 8), 'N');
  assert.equal(toCardinal(23, 8), 'NE');
  assert.equal(toCardinal(200, 8), 'S');
  assert.equal(toCardinal(100, 4), 'E');
  assert.equal(toCardinal(44, 4), 'N');
  assert.equal(toCardinal(46, 4), 'E');
  assert.equal(toCardinal(NaN), '');
});

test('haversineM matches known distances and is symmetric', () => {
  near(haversineM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), METRES_PER_DEG, 1, 'one degree at the equator');
  near(haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), METRES_PER_DEG, 1, 'one degree of latitude');
  near(haversineM({ lat: 0, lon: 0 }, { lat: 0, lon: 180 }), Math.PI * 6371008.8, 1, 'antipodes');
  assert.equal(haversineM(P, P), 0);
  const q = { lat: 45.4647, lon: -122.5931 };
  assert.equal(haversineM(P, q), haversineM(q, P));
});

test('bearingDeg gives compass bearings (0 north, 90 east)', () => {
  const o = { lat: 0, lon: 0 };
  near(bearingDeg(o, { lat: 1, lon: 0 }), 0, 1e-9);
  near(bearingDeg(o, { lat: 0, lon: 1 }), 90, 1e-9);
  near(bearingDeg(o, { lat: -1, lon: 0 }), 180, 1e-9);
  near(bearingDeg(o, { lat: 0, lon: -1 }), 270, 1e-9);
  near(bearingDeg(o, { lat: 1, lon: 1 }), 45, 0.01);
});

test('destination round-trips through haversineM and bearingDeg', () => {
  for (const b of [0, 37, 90, 123.4, 180, 250, 359]) {
    for (const d of [1, 150, 600, 25000]) {
      const q = destination(P, b, d);
      near(haversineM(P, q), d, 1e-6 * d + 1e-6, `distance for bearing ${b}, ${d} m`);
      near(absAngleDiff(bearingDeg(P, q), b), 0, 1e-6, `bearing ${b} at ${d} m`);
    }
  }
  // Zero distance is the identity (to floating-point noise).
  nearPoint(destination(P, 123, 0), P, 1e-6);
});

test('destination walks backwards for negative distances and wraps longitude', () => {
  nearPoint(destination(P, 90, -100), destination(P, 270, 100), 1e-6);
  const q = destination({ lat: 0, lon: 179.9999 }, 90, 50000);
  assert.ok(q.lon < 0 && q.lon > -180, `wrapped longitude ${q.lon}`);
  near(q.lon, -179.5505, 0.001);
});

test('localProjection gives metres east/north around the origin and inverts', () => {
  const proj = localProjection(P);
  assert.deepEqual(proj.toXY(P), { x: 0, y: 0 });
  const east = proj.toXY(destination(P, 90, 100));
  near(east.x, 100, 0.01);
  near(east.y, 0, 0.01);
  const north = proj.toXY(destination(P, 0, 100));
  near(north.x, 0, 0.01);
  near(north.y, 100, 0.01);
  const sw = proj.toXY(destination(P, 225, 1000));
  near(sw.x, -1000 * Math.SQRT1_2, 0.1);
  near(sw.y, -1000 * Math.SQRT1_2, 0.1);
  const q = destination(P, 123, 2000);
  const back = proj.fromXY(proj.toXY(q));
  near(back.lat, q.lat, 1e-9);
  near(back.lon, q.lon, 1e-9);
  // Across the antimeridian the longitude difference is the short way round.
  const edge = localProjection({ lat: 0, lon: 179.99 });
  near(edge.toXY({ lat: 0, lon: -179.99 }).x, 0.02 * METRES_PER_DEG, 1);
});

test('nearestSegment finds the closest segment of a bent polyline, in node order', () => {
  // Bent polyline: comes in from the north-west, passes north of P, leaves to the south-east.
  const n0 = destination(P, 300, 200);
  const n1 = destination(P, 350, 40);
  const n2 = destination(P, 80, 40);
  const n3 = destination(P, 120, 200);
  const line = [n0, n1, n2, n3];
  const seg = nearestSegment(P, line);
  assert.ok(seg);
  assert.equal(seg.index, 1);
  // Chord between two points 40 m away subtending 90 degrees: 40 * cos(45) from P.
  near(seg.distanceM, 40 * Math.SQRT1_2, 0.05, 'perpendicular distance');
  near(absAngleDiff(seg.bearing, bearingDeg(n1, n2)), 0, 1e-6, 'bearing follows node order');
  nearPoint(seg.closest, destination(P, 35, 40 * Math.SQRT1_2), 0.05, 'foot of the perpendicular');
  near(haversineM(P, seg.closest), seg.distanceM, 0.01);

  // Reversing the node order reverses the bearing but nothing else (the
  // initial bearings of a 60 m great-circle arc differ from exact opposites
  // by the meridian convergence, well under a hundredth of a degree).
  const rev = nearestSegment(P, line.slice().reverse());
  assert.equal(rev.index, 1);
  near(rev.distanceM, seg.distanceM, 1e-6);
  near(absAngleDiff(rev.bearing, seg.bearing + 180), 0, 0.01);
});

test('nearestSegment clamps to the segment ends', () => {
  const a = destination(P, 270, 100);
  const b = destination(P, 270, 20);
  // P lies 20 m beyond b along the a->b direction: nearest is the end node b.
  const seg = nearestSegment(P, [a, b]);
  assert.equal(seg.index, 0);
  near(seg.distanceM, 20, 0.01);
  nearPoint(seg.closest, b, 0.01);
  near(absAngleDiff(seg.bearing, 90), 0, 0.01);
  // And before the start node.
  const q = destination(a, 270, 30);
  const seg2 = nearestSegment(q, [a, b]);
  near(seg2.distanceM, 30, 0.01);
  nearPoint(seg2.closest, a, 0.01);
});

test('nearestSegment skips degenerate segments and rejects short input', () => {
  const a = destination(P, 0, 50);
  const b = destination(P, 90, 50);
  const seg = nearestSegment(P, [a, a, b]);
  assert.equal(seg.index, 1, 'zero-length first segment skipped');
  near(absAngleDiff(seg.bearing, bearingDeg(a, b)), 0, 1e-9);
  assert.equal(nearestSegment(P, [a]), null);
  assert.equal(nearestSegment(P, []), null);
  assert.equal(nearestSegment(P, [a, a]), null);
  assert.equal(nearestSegment(P, null), null);
  // Invalid nodes are ignored.
  const seg3 = nearestSegment(P, [{ lat: NaN, lon: 1 }, a, b]);
  assert.equal(seg3.index, 1);
});

test('pointInPolygon works for open and closed rings and concave shapes', () => {
  const square = [45, 135, 225, 315].map((b) => destination(P, b, 50));
  assert.equal(pointInPolygon(P, square), true);
  assert.equal(pointInPolygon(destination(P, 0, 100), square), false);
  assert.equal(pointInPolygon(destination(P, 0, 30), square), true);
  assert.equal(pointInPolygon(destination(P, 90, 40), square), false, 'outside the rotated square corner-to-corner');
  const closed = [...square, square[0]];
  assert.equal(pointInPolygon(P, closed), true);
  assert.equal(pointInPolygon(destination(P, 0, 100), closed), false);
  // A "C" shape open to the west: the notch is outside, the arms inside.
  const c = [
    { lat: 0, lon: 0 }, { lat: 0, lon: 4 }, { lat: 4, lon: 4 }, { lat: 4, lon: 0 },
    { lat: 3, lon: 0 }, { lat: 3, lon: 3 }, { lat: 1, lon: 3 }, { lat: 1, lon: 0 },
  ];
  assert.equal(pointInPolygon({ lat: 2, lon: 1 }, c), false, 'inside the notch');
  assert.equal(pointInPolygon({ lat: 2, lon: 3.5 }, c), true, 'in the spine');
  assert.equal(pointInPolygon({ lat: 0.5, lon: 1 }, c), true, 'in the lower arm');
  assert.equal(pointInPolygon({ lat: 5, lon: 1 }, c), false);
  assert.equal(pointInPolygon(P, [square[0], square[1]]), false, 'fewer than three vertices');
});

test('distanceToPolyline handles polylines, single nodes and empty input', () => {
  const a = destination(P, 270, 100);
  const b = destination(P, 90, 100);
  const c = destination(a, 20, 30); // 30 m north-north-east of a, the line passes 30*cos(20) ... use the segment instead
  near(distanceToPolyline(destination(P, 0, 30), [a, b]), 30, 0.05, 'perpendicular to an east-west line');
  near(distanceToPolyline(P, [c]), haversineM(P, c), 1e-9, 'single node');
  assert.equal(distanceToPolyline(P, []), Infinity);
  assert.equal(distanceToPolyline(P, null), Infinity);
  near(distanceToPolyline(P, [a, a]), 100, 0.01, 'degenerate segment falls back to node distance');
});
