// docs/declination.js — World Magnetic Model 2025 evaluator (pure, offline).
//
// Phone compasses report MAGNETIC north; OpenStreetMap bearings are TRUE north.
// The difference (declination) is 15–20° in parts of the US, so it has to be
// applied before a water direction is compared with the map. This module
// evaluates the WMM2025 spherical-harmonic model for a position and date and
// needs no network.
//
// Algorithm adapted from geomagnetism 0.2.0 by Natural Atlas
// (https://github.com/naturalatlas/geomagnetism), itself a port of NOAA's
// GeomagnetismLibrary.c.
//   Copyright (c) Natural Atlas, Inc.
//   Licensed under the Apache License, Version 2.0 (the "License"); you may not
//   use this file except in compliance with the License. A copy of the License
//   is in docs/data/wmm-2025.LICENSE.txt or at
//   http://www.apache.org/licenses/LICENSE-2.0. Distributed on an "AS IS" BASIS,
//   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
// Modifications for Stream Checker (2026): rewritten as a dependency-free ES
// module, WMM2025 coefficients inlined as an (n, m, g, h, gdot, hdot) table,
// exact decimal-year handling, no exceptions outside the validity window
// (the model is extrapolated with its secular variation instead), and only the
// elements this app needs are computed.
//
// The WMM2025 coefficients are published by NOAA/NCEI and the British
// Geological Survey (https://www.ncei.noaa.gov/products/world-magnetic-model)
// and are in the public domain. The same numbers live in
// docs/data/wmm-2025.json; the table below is the one the code uses so the
// evaluator keeps working with no fetch at all.

// ---------------------------------------------------------------------------
// Model constants

export const WMM_NAME = 'WMM-2025';
export const WMM_EPOCH = 2025.0;
/** Official validity window (inclusive). Outside it the model is extrapolated. */
export const WMM_VALID = Object.freeze({
  start: '2024-11-13T00:00:00Z',
  end: '2029-12-31T23:59:59Z',
});
const N_MAX = 12;                                  // degree and order of the model
const NUM_TERMS = ((N_MAX + 1) * (N_MAX + 2)) / 2; // 91 flat slots, index 0 unused

// WGS84 ellipsoid (km) and the geomagnetic reference radius used by the WMM.
const WGS84_A = 6378.137;
const WGS84_B = 6356.7523142;
const WGS84_EPSSQ = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A); // first eccentricity squared
const GEOMAG_RE = 6371.2;

const DEG = Math.PI / 180;

// WMM2025 Gauss coefficients (nT) and their secular variation (nT/yr):
// [n, m, g(n,m), h(n,m), gdot(n,m), hdot(n,m)]  — matches NOAA's WMM.COF.
const COEFFICIENTS = [
  [ 1,  0,  -29351.8,        0,     12,      0],
  [ 1,  1,   -1410.8,   4545.4,    9.7,  -21.5],
  [ 2,  0,   -2556.6,        0,  -11.6,      0],
  [ 2,  1,    2951.1,  -3133.6,   -5.2,  -27.7],
  [ 2,  2,    1649.3,   -815.1,     -8,  -12.1],
  [ 3,  0,      1361,        0,   -1.3,      0],
  [ 3,  1,   -2404.1,    -56.6,   -4.2,      4],
  [ 3,  2,    1243.8,    237.5,    0.4,   -0.3],
  [ 3,  3,     453.6,   -549.5,  -15.6,   -4.1],
  [ 4,  0,       895,        0,   -1.6,      0],
  [ 4,  1,     799.5,    278.6,   -2.4,   -1.1],
  [ 4,  2,      55.7,   -133.9,     -6,    4.1],
  [ 4,  3,    -281.1,      212,    5.6,    1.6],
  [ 4,  4,      12.1,   -375.6,     -7,   -4.4],
  [ 5,  0,    -233.2,        0,    0.6,      0],
  [ 5,  1,     368.9,     45.4,    1.4,   -0.5],
  [ 5,  2,     187.2,    220.2,      0,    2.2],
  [ 5,  3,    -138.7,   -122.9,    0.6,    0.4],
  [ 5,  4,      -142,       43,    2.2,    1.7],
  [ 5,  5,      20.9,    106.1,    0.9,    1.9],
  [ 6,  0,      64.4,        0,   -0.2,      0],
  [ 6,  1,      63.8,    -18.4,   -0.4,    0.3],
  [ 6,  2,      76.9,     16.8,    0.9,   -1.6],
  [ 6,  3,    -115.7,     48.8,    1.2,   -0.4],
  [ 6,  4,     -40.9,    -59.8,   -0.9,    0.9],
  [ 6,  5,      14.9,     10.9,    0.3,    0.7],
  [ 6,  6,     -60.7,     72.7,    0.9,    0.9],
  [ 7,  0,      79.5,        0,      0,      0],
  [ 7,  1,       -77,    -48.9,   -0.1,    0.6],
  [ 7,  2,      -8.8,    -14.4,   -0.1,    0.5],
  [ 7,  3,      59.3,       -1,    0.5,   -0.8],
  [ 7,  4,      15.8,     23.4,   -0.1,      0],
  [ 7,  5,       2.5,     -7.4,   -0.8,     -1],
  [ 7,  6,     -11.1,    -25.1,   -0.8,    0.6],
  [ 7,  7,      14.2,     -2.3,    0.8,   -0.2],
  [ 8,  0,      23.2,        0,   -0.1,      0],
  [ 8,  1,      10.8,      7.1,    0.2,   -0.2],
  [ 8,  2,     -17.5,    -12.6,      0,    0.5],
  [ 8,  3,         2,     11.4,    0.5,   -0.4],
  [ 8,  4,     -21.7,     -9.7,   -0.1,    0.4],
  [ 8,  5,      16.9,     12.7,    0.3,   -0.5],
  [ 8,  6,        15,      0.7,    0.2,   -0.6],
  [ 8,  7,     -16.8,     -5.2,      0,    0.3],
  [ 8,  8,       0.9,      3.9,    0.2,    0.2],
  [ 9,  0,       4.6,        0,      0,      0],
  [ 9,  1,       7.8,    -24.8,   -0.1,   -0.3],
  [ 9,  2,         3,     12.2,    0.1,    0.3],
  [ 9,  3,      -0.2,      8.3,    0.3,   -0.3],
  [ 9,  4,      -2.5,     -3.3,   -0.3,    0.3],
  [ 9,  5,     -13.1,     -5.2,      0,    0.2],
  [ 9,  6,       2.4,      7.2,    0.3,   -0.1],
  [ 9,  7,       8.6,     -0.6,   -0.1,   -0.2],
  [ 9,  8,      -8.7,      0.8,    0.1,    0.4],
  [ 9,  9,     -12.9,       10,   -0.1,    0.1],
  [10,  0,      -1.3,        0,    0.1,      0],
  [10,  1,      -6.4,      3.3,      0,      0],
  [10,  2,       0.2,        0,    0.1,      0],
  [10,  3,         2,      2.4,    0.1,   -0.2],
  [10,  4,        -1,      5.3,      0,    0.1],
  [10,  5,      -0.6,     -9.1,   -0.3,   -0.1],
  [10,  6,      -0.9,      0.4,      0,    0.1],
  [10,  7,       1.5,     -4.2,   -0.1,      0],
  [10,  8,       0.9,     -3.8,   -0.1,   -0.1],
  [10,  9,      -2.7,      0.9,      0,    0.2],
  [10, 10,      -3.9,     -9.1,      0,      0],
  [11,  0,       2.9,        0,      0,      0],
  [11,  1,      -1.5,        0,      0,      0],
  [11,  2,      -2.5,      2.9,      0,    0.1],
  [11,  3,       2.4,     -0.6,      0,      0],
  [11,  4,      -0.6,      0.2,      0,    0.1],
  [11,  5,      -0.1,      0.5,   -0.1,      0],
  [11,  6,      -0.6,     -0.3,      0,      0],
  [11,  7,      -0.1,     -1.2,      0,    0.1],
  [11,  8,       1.1,     -1.7,   -0.1,      0],
  [11,  9,        -1,     -2.9,   -0.1,      0],
  [11, 10,      -0.2,     -1.8,   -0.1,      0],
  [11, 11,       2.6,     -2.3,   -0.1,      0],
  [12,  0,        -2,        0,      0,      0],
  [12,  1,      -0.2,     -1.3,      0,      0],
  [12,  2,       0.3,      0.7,      0,      0],
  [12,  3,       1.2,        1,      0,   -0.1],
  [12,  4,      -1.3,     -1.4,      0,    0.1],
  [12,  5,       0.6,        0,      0,      0],
  [12,  6,       0.6,      0.6,    0.1,      0],
  [12,  7,       0.5,     -0.1,      0,      0],
  [12,  8,      -0.1,      0.8,      0,      0],
  [12,  9,      -0.4,      0.1,      0,      0],
  [12, 10,      -0.2,       -1,   -0.1,      0],
  [12, 11,      -1.3,      0.1,      0,      0],
  [12, 12,      -0.7,      0.2,   -0.1,   -0.1],
];

// Flat arrays indexed by i = n(n+1)/2 + m, the layout the recursions below use.
const G = new Float64Array(NUM_TERMS);
const H = new Float64Array(NUM_TERMS);
const GDOT = new Float64Array(NUM_TERMS);
const HDOT = new Float64Array(NUM_TERMS);
for (const [n, m, g, h, gdot, hdot] of COEFFICIENTS) {
  const i = (n * (n + 1)) / 2 + m;
  G[i] = g;
  H[i] = h;
  GDOT[i] = gdot;
  HDOT[i] = hdot;
}

// ---------------------------------------------------------------------------
// Dates

/**
 * Decimal year of a date, with the exact year length (leap years included), so
 * 2027.5 is noon on 2 July 2027 UTC. Accepts a Date, a millisecond timestamp,
 * a date string, or a number below 3000 which is taken as a decimal year
 * already. An unparseable date evaluates at the model epoch.
 */
export function decimalYear(date = new Date()) {
  if (typeof date === 'number' && Number.isFinite(date) && date < 3000) return date;
  const d = date instanceof Date ? date : new Date(date);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return WMM_EPOCH;
  const year = d.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const next = Date.UTC(year + 1, 0, 1);
  return year + (ms - start) / (next - start);
}

/** Date (UTC) for a decimal year: the inverse of decimalYear(). */
export function dateFromDecimalYear(year) {
  const whole = Math.floor(year);
  const start = Date.UTC(whole, 0, 1);
  const next = Date.UTC(whole + 1, 0, 1);
  return new Date(start + (year - whole) * (next - start));
}

/** True when the date is inside the model's official validity window. */
export function inValidity(date = new Date()) {
  const y = decimalYear(date);
  return y >= decimalYear(WMM_VALID.start) && y <= decimalYear(WMM_VALID.end);
}

// ---------------------------------------------------------------------------
// Associated Legendre functions

/**
 * Schmidt semi-normalised associated Legendre functions P(n,m)(x) and their
 * derivatives with respect to geocentric latitude, for x = sin(latitude),
 * returned as flat arrays indexed by i = n(n+1)/2 + m. This is NOAA's
 * MAG_PcupLow: a Gauss-normalised recursion, converted to Schmidt
 * quasi-normalisation at the end. It is accurate for degrees up to 16, which
 * covers the WMM's 12.
 */
function legendre(x, nMax) {
  const z = Math.sqrt((1 - x) * (1 + x)); // cos(latitude), >= 0
  const p = new Float64Array(NUM_TERMS);
  const dp = new Float64Array(NUM_TERMS);
  const norm = new Float64Array(NUM_TERMS);
  p[0] = 1;
  dp[0] = 0;
  norm[0] = 1;

  for (let n = 1; n <= nMax; n++) {
    for (let m = 0; m <= n; m++) {
      const i = (n * (n + 1)) / 2 + m;
      if (n === m) {
        // diagonal: P(n,n) = cos(lat) * P(n-1,n-1)
        const i1 = ((n - 1) * n) / 2 + m - 1;
        p[i] = z * p[i1];
        dp[i] = z * dp[i1] + x * p[i1];
      } else if (n === 1 && m === 0) {
        p[i] = x * p[0];
        dp[i] = x * dp[0] - z * p[0];
      } else {
        // n > 1, m < n: three-term recursion in n
        const i1 = ((n - 2) * (n - 1)) / 2 + m; // P(n-2,m), absent when m = n-1
        const i2 = ((n - 1) * n) / 2 + m;       // P(n-1,m)
        if (m > n - 2) {
          p[i] = x * p[i2];
          dp[i] = x * dp[i2] - z * p[i2];
        } else {
          const k = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
          p[i] = x * p[i2] - k * p[i1];
          dp[i] = x * dp[i2] - z * p[i2] - k * dp[i1];
        }
      }
    }
  }

  // Ratio between the Gauss-normalised and the Schmidt quasi-normalised
  // functions: sqrt((m==0?1:2) (n-m)!/(n+m)!) (2n-1)!!/(n-m)!, built up recursively.
  for (let n = 1; n <= nMax; n++) {
    const i0 = (n * (n + 1)) / 2;
    norm[i0] = (norm[((n - 1) * n) / 2] * (2 * n - 1)) / n;
    for (let m = 1; m <= n; m++) {
      const i = i0 + m;
      norm[i] = norm[i - 1] * Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m));
    }
  }
  for (let i = 1; i < NUM_TERMS; i++) {
    p[i] *= norm[i];
    dp[i] *= -norm[i]; // the recursion above produced -dP/dlat
  }
  return { p, dp };
}

// ---------------------------------------------------------------------------
// Field evaluation

/**
 * Magnetic field elements at a geodetic position.
 *   lat, lon: degrees (WGS84); altitudeKm: height above the ellipsoid (km)
 *   date: see decimalYear()
 * -> { x, y, z, h, f, inclination, declination, decimalYear, extrapolated }
 *    x north, y east, z down (nT); h horizontal intensity; f total intensity;
 *    inclination and declination in degrees (declination east positive).
 * Throws a TypeError for a non-finite latitude or longitude; never throws for
 * a date, even far outside the validity window (extrapolated flag set).
 */
export function magneticField(lat, lon, altitudeKm = 0, date = new Date()) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new TypeError(`magneticField: latitude and longitude must be finite numbers (got ${lat}, ${lon})`);
  }
  const phi = Math.max(-90, Math.min(90, lat)) * DEG; // geodetic latitude
  const lambda = lon * DEG;
  const height = Number.isFinite(altitudeKm) ? altitudeKm : 0;
  const year = decimalYear(date);
  const dt = year - WMM_EPOCH;

  // Geodetic -> geocentric spherical coordinates on the WGS84 ellipsoid.
  const sinLat = Math.sin(phi);
  const cosLat = Math.cos(phi);
  const rc = WGS84_A / Math.sqrt(1 - WGS84_EPSSQ * sinLat * sinLat); // radius of curvature in the prime vertical
  const xp = (rc + height) * cosLat;
  const zp = (rc * (1 - WGS84_EPSSQ) + height) * sinLat;
  const r = Math.sqrt(xp * xp + zp * zp);     // distance from the Earth's centre (km)
  const phig = Math.asin(zp / r);              // geocentric latitude (rad)

  // Harmonic variables: (RE/r)^(n+2) and cos/sin of m*longitude.
  const ratio = GEOMAG_RE / r;
  const rrp = new Float64Array(N_MAX + 1);
  rrp[0] = ratio * ratio;
  for (let n = 1; n <= N_MAX; n++) rrp[n] = rrp[n - 1] * ratio;
  const cosLam = Math.cos(lambda);
  const sinLam = Math.sin(lambda);
  const cosM = new Float64Array(N_MAX + 1);
  const sinM = new Float64Array(N_MAX + 1);
  cosM[0] = 1;
  sinM[0] = 0;
  cosM[1] = cosLam;
  sinM[1] = sinLam;
  for (let m = 2; m <= N_MAX; m++) {
    cosM[m] = cosM[m - 1] * cosLam - sinM[m - 1] * sinLam;
    sinM[m] = cosM[m - 1] * sinLam + sinM[m - 1] * cosLam;
  }

  const sinPhig = Math.sin(phig);
  const cosPhig = Math.cos(phig);
  const { p, dp } = legendre(sinPhig, N_MAX);

  // Spherical-harmonic summation in the geocentric frame
  // (X' north, Y' east, Z' down), WMM technical report equations 10–12,
  // with the Gauss coefficients moved to the requested date.
  let bx = 0;
  let by = 0;
  let bz = 0;
  for (let n = 1; n <= N_MAX; n++) {
    for (let m = 0; m <= n; m++) {
      const i = (n * (n + 1)) / 2 + m;
      const g = G[i] + dt * GDOT[i];
      const h = H[i] + dt * HDOT[i];
      const gc = g * cosM[m] + h * sinM[m];
      bz -= rrp[n] * gc * (n + 1) * p[i];
      by += rrp[n] * (g * sinM[m] - h * cosM[m]) * m * p[i];
      bx -= rrp[n] * gc * dp[i];
    }
  }
  if (Math.abs(cosPhig) > 1e-10) {
    by /= cosPhig;
  } else {
    by = polarEastComponent(sinPhig, rrp, cosM, sinM, dt);
  }

  // Rotate from the geocentric to the geodetic frame (Y is unchanged).
  const psi = phig - phi;
  const x = bx * Math.cos(psi) - bz * Math.sin(psi);
  const z = bx * Math.sin(psi) + bz * Math.cos(psi);
  const y = by;
  const hIntensity = Math.sqrt(x * x + y * y);
  return {
    x,
    y,
    z,
    h: hIntensity,
    f: Math.sqrt(hIntensity * hIntensity + z * z),
    inclination: Math.atan2(z, hIntensity) / DEG,
    declination: Math.atan2(y, x) / DEG,
    decimalYear: year,
    extrapolated: !inValidity(year),
  };
}

/**
 * Y' at the geographic poles, where the m*P(n,m)/cos(lat) term above is 0/0.
 * Only the m = 1 terms survive; NOAA's MAG_SummationSpecial evaluates them
 * with a dedicated recursion for P(n,1)/cos(lat).
 */
function polarEastComponent(sinPhig, rrp, cosM, sinM, dt) {
  let by = 0;
  let norm1 = 1;
  const pcupS = [1];
  for (let n = 1; n <= N_MAX; n++) {
    const i = (n * (n + 1)) / 2 + 1;
    const norm2 = (norm1 * (2 * n - 1)) / n;
    const norm3 = norm2 * Math.sqrt((2 * n) / (n + 1));
    norm1 = norm2;
    if (n === 1) {
      pcupS[n] = pcupS[n - 1];
    } else {
      const k = ((n - 1) * (n - 1) - 1) / ((2 * n - 1) * (2 * n - 3));
      pcupS[n] = sinPhig * pcupS[n - 1] - k * pcupS[n - 2];
    }
    const g = G[i] + dt * GDOT[i];
    const h = H[i] + dt * HDOT[i];
    by += rrp[n] * (g * sinM[1] - h * cosM[1]) * pcupS[n] * norm3;
  }
  return by;
}

// ---------------------------------------------------------------------------
// Public API (see CONTRACTS.md)

/**
 * Magnetic declination in degrees, east positive: add it to a magnetic
 * heading to get a true heading. Never throws for a date; extrapolates with
 * the secular variation outside the validity window.
 */
export function declination(lat, lon, altitudeKm = 0, date = new Date()) {
  return magneticField(lat, lon, altitudeKm, date).declination;
}

/**
 * True heading for a magnetic heading at a position: (headingMag + declination)
 * normalised to [0, 360). Returns null when the heading is not a finite number.
 */
export function magneticToTrue(headingMag, lat, lon, date = new Date()) {
  if (!Number.isFinite(headingMag)) return null;
  const d = declination(lat, lon, 0, date);
  return normalize360(headingMag + d);
}

/** Inverse of magneticToTrue: (headingTrue - declination) in [0, 360). */
export function trueToMagnetic(headingTrue, lat, lon, date = new Date()) {
  if (!Number.isFinite(headingTrue)) return null;
  const d = declination(lat, lon, 0, date);
  return normalize360(headingTrue - d);
}

function normalize360(deg) {
  const r = deg % 360;
  return r < 0 ? r + 360 : r === 0 ? 0 : r; // "r === 0" folds -0 into 0
}
