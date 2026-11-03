// tests/declination.test.mjs — World Magnetic Model evaluator against NOAA's
// published WMM2025 test values, plus sanity checks on known places.
// Run with: node --test tests/declination.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  WMM_EPOCH,
  WMM_VALID,
  declination,
  magneticToTrue,
  trueToMagnetic,
  magneticField,
  decimalYear,
  dateFromDecimalYear,
  inValidity,
} from '../docs/declination.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Parse tests/fixtures/WMM2025_TEST_VALUES.txt. Columns per its header:
 * 1 date (decimal year), 2 height above the WGS84 ellipsoid (km),
 * 3 geodetic latitude, 4 longitude, 5 X, 6 Y, 7 Z, 8 H, 9 F (nT),
 * 10 inclination, 11 declination (deg), 12 grid variation, 13-19 rates.
 */
function loadTestValues() {
  const text = readFileSync(join(here, 'fixtures', 'WMM2025_TEST_VALUES.txt'), 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const f = line.split(/\s+/).map(Number);
      return {
        year: f[0], heightKm: f[1], lat: f[2], lon: f[3],
        x: f[4], y: f[5], z: f[6], h: f[7], f: f[8], inclination: f[9], declination: f[10],
      };
    });
}

const ROWS = loadTestValues();

test('fixture parses into the expected rows', () => {
  assert.equal(ROWS.length, 12);
  assert.deepEqual([...new Set(ROWS.map((r) => r.year))], [2025.0, 2027.5]);
  assert.deepEqual([...new Set(ROWS.map((r) => r.heightKm))], [0, 100]);
  assert.equal(ROWS[0].declination, 1.28);
});

test('WMM_EPOCH and validity window', () => {
  assert.equal(WMM_EPOCH, 2025.0);
  assert.equal(inValidity(new Date('2026-06-01T00:00:00Z')), true);
  assert.equal(inValidity(new Date('2024-01-01T00:00:00Z')), false);
  assert.equal(inValidity(new Date('2031-01-01T00:00:00Z')), false);
  assert.equal(inValidity(WMM_VALID.start), true);
  assert.equal(inValidity(WMM_VALID.end), true);
});

test('decimalYear and dateFromDecimalYear round-trip, leap years included', () => {
  assert.equal(decimalYear(new Date('2025-01-01T00:00:00Z')), 2025);
  // 2027.5 is noon on 2 July 2027 (365-day year: 182.5 days in)
  assert.equal(dateFromDecimalYear(2027.5).toISOString(), '2027-07-02T12:00:00.000Z');
  // 2028 is a leap year: 2028.5 is 183 days in
  assert.equal(dateFromDecimalYear(2028.5).toISOString(), '2028-07-02T00:00:00.000Z');
  for (const y of [2025.0, 2026.123, 2027.5, 2028.999]) {
    assert.ok(Math.abs(decimalYear(dateFromDecimalYear(y)) - y) < 1e-9, `round trip ${y}`);
  }
  // accepted input forms
  assert.equal(decimalYear(2026.25), 2026.25);                         // decimal year passthrough
  assert.ok(Math.abs(decimalYear(Date.UTC(2026, 0, 1)) - 2026) < 1e-9); // ms timestamp
  assert.ok(Math.abs(decimalYear('2026-01-01T00:00:00Z') - 2026) < 1e-9); // string
  assert.equal(decimalYear(new Date('garbage')), WMM_EPOCH);         // invalid -> epoch
});

test('declination matches every NOAA WMM2025 test value within 0.05 degrees', () => {
  for (const row of ROWS) {
    const date = dateFromDecimalYear(row.year);
    const d = declination(row.lat, row.lon, row.heightKm, date);
    const label = `${row.year} h=${row.heightKm} (${row.lat}, ${row.lon})`;
    assert.ok(Number.isFinite(d), `${label}: finite`);
    assert.ok(Math.abs(d - row.declination) <= 0.05, `${label}: D ${d.toFixed(4)} vs ${row.declination}`);
  }
});

test('field components X, Y, Z, H, F and inclination match the NOAA test values', () => {
  // The fixture is rounded to 0.1 nT / 0.01 degrees; a correct evaluator
  // agrees to well inside that.
  for (const row of ROWS) {
    const r = magneticField(row.lat, row.lon, row.heightKm, dateFromDecimalYear(row.year));
    const label = `${row.year} h=${row.heightKm} (${row.lat}, ${row.lon})`;
    assert.ok(Math.abs(r.x - row.x) <= 0.5, `${label}: X ${r.x} vs ${row.x}`);
    assert.ok(Math.abs(r.y - row.y) <= 0.5, `${label}: Y ${r.y} vs ${row.y}`);
    assert.ok(Math.abs(r.z - row.z) <= 0.5, `${label}: Z ${r.z} vs ${row.z}`);
    assert.ok(Math.abs(r.h - row.h) <= 0.5, `${label}: H ${r.h} vs ${row.h}`);
    assert.ok(Math.abs(r.f - row.f) <= 0.5, `${label}: F ${r.f} vs ${row.f}`);
    assert.ok(Math.abs(r.inclination - row.inclination) <= 0.05, `${label}: I ${r.inclination} vs ${row.inclination}`);
    assert.equal(r.extrapolated, false);
    assert.ok(Math.abs(r.decimalYear - row.year) < 1e-9);
  }
});

test('the date form does not matter: Date, decimal year and timestamp agree', () => {
  const row = ROWS[6]; // 2027.5, h 0, (80, 0)
  const viaDate = declination(row.lat, row.lon, 0, dateFromDecimalYear(row.year));
  const viaYear = declination(row.lat, row.lon, 0, row.year);
  const viaMs = declination(row.lat, row.lon, 0, dateFromDecimalYear(row.year).getTime());
  assert.ok(Math.abs(viaDate - viaYear) < 1e-9);
  assert.ok(Math.abs(viaDate - viaMs) < 1e-9);
  assert.ok(Math.abs(viaDate - row.declination) <= 0.05);
});

test('sanity: Portland OR is about +14.5 east, London about +1 in 2026', () => {
  const date = new Date('2026-06-01T00:00:00Z');
  const portland = declination(45.5, -122.7, 0, date);
  assert.ok(portland > 13.5 && portland < 15.5, `Portland ${portland}`);
  const london = declination(51.5, -0.1, 0, date);
  assert.ok(london > 0 && london < 2.5, `London ${london}`);
  // and the US east coast is west (negative)
  const boston = declination(42.4, -71.1, 0, date);
  assert.ok(boston < -12 && boston > -16, `Boston ${boston}`);
  // default date is "now": just finite and in a sane range for Portland
  const now = declination(45.5, -122.7);
  assert.ok(Number.isFinite(now) && now > 10 && now < 18, `Portland now ${now}`);
});

test('magneticToTrue adds the declination and wraps into [0, 360)', () => {
  const date = new Date('2026-06-01T00:00:00Z');
  const d = declination(45.5, -122.7, 0, date);
  const t = magneticToTrue(355, 45.5, -122.7, date);
  assert.ok(t >= 0 && t < 360, `wrapped ${t}`);
  assert.ok(Math.abs(t - ((355 + d) % 360)) < 1e-9);
  assert.ok(t > 9 && t < 11, `355 magnetic in Portland is about 9.5 true: ${t}`);
  // negative declination wraps the other way
  const b = magneticToTrue(5, 42.4, -71.1, date);
  assert.ok(b > 350 && b < 353, `5 magnetic in Boston is about 351 true: ${b}`);
  // exact wrap lands on 0, never 360
  const dB = declination(42.4, -71.1, 0, date);
  assert.equal(magneticToTrue(-dB, 42.4, -71.1, date), 0);
  assert.equal(magneticToTrue(360 - dB, 42.4, -71.1, date), 0);
  // non-finite heading -> null (no compass)
  assert.equal(magneticToTrue(null, 45.5, -122.7, date), null);
  assert.equal(magneticToTrue(NaN, 45.5, -122.7, date), null);
  // and the inverse
  assert.ok(Math.abs(trueToMagnetic(t, 45.5, -122.7, date) - 355) < 1e-9);
});

test('outside the validity window the model extrapolates and never throws', () => {
  for (const when of [new Date('2040-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'), new Date('1900-06-15T00:00:00Z'), 2100.5]) {
    const d = declination(45.5, -122.7, 0, when);
    assert.ok(Number.isFinite(d), `finite for ${when}: ${d}`);
    assert.equal(magneticField(45.5, -122.7, 0, when).extrapolated, true);
  }
  // an unparseable date evaluates at the epoch rather than throwing
  const bad = declination(45.5, -122.7, 0, new Date('not a date'));
  const atEpoch = declination(45.5, -122.7, 0, WMM_EPOCH);
  assert.ok(Math.abs(bad - atEpoch) < 1e-9);
  // 2025 -> 2027.5 at (80, 0) drifts by about +0.52 deg/yr (fixture Ddot), so
  // extrapolating a few years further keeps moving the same way
  const d2030 = declination(80, 0, 0, 2030.0);
  const d2027 = declination(80, 0, 0, 2027.5);
  assert.ok(d2030 > d2027, `${d2030} > ${d2027}`);
});

test('poles and odd inputs stay finite; bad coordinates throw a TypeError', () => {
  for (const [lat, lon] of [[90, 0], [-90, 45], [89.9999, 180], [0, -180], [0, 540], [45, 1e6]]) {
    const r = magneticField(lat, lon, 0, 2026.5);
    assert.ok(Number.isFinite(r.declination) && Number.isFinite(r.f), `(${lat}, ${lon})`);
  }
  // longitude is periodic
  assert.ok(Math.abs(declination(10, 200, 0, 2026.5) - declination(10, -160, 0, 2026.5)) < 1e-9);
  // latitude beyond the poles is clamped, altitude falls back to 0
  assert.ok(Number.isFinite(declination(95, 0, undefined, 2026.5)));
  assert.equal(declination(45, 10, NaN, 2026.5), declination(45, 10, 0, 2026.5));
  // altitude lowers the field strength
  assert.ok(magneticField(45, 10, 100, 2026.5).f < magneticField(45, 10, 0, 2026.5).f);
  assert.throws(() => declination(NaN, 0), TypeError);
  assert.throws(() => declination(45, undefined), TypeError);
});
