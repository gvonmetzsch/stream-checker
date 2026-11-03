// docs/compass.js — compass heading from device orientation events.
//
// Pure helpers (importable from Node) plus createCompass() for the browser.
// Conventions:
//   - headings are compass bearings: 0 = north, 90 = east, in [0, 360)
//   - alpha/beta/gamma follow the W3C DeviceOrientation spec: the device frame
//     has x to the right of the screen, y toward the top edge, z out of the
//     screen; the earth frame has x east, y north, z up; the rotation is
//     R = Rz(alpha) Rx(beta) Ry(gamma) (device -> earth)
//   - every heading here is MAGNETIC; declination.js turns it into true
//
// Two headings matter for "which way is up in the image":
//   topEdgeHeading   — where the phone's top edge points. Correct when the
//                      camera looks down at the water (phone flat-ish).
//   cameraAxisHeading — where the rear camera points. Correct when the phone is
//                      upright and "up in the image" means "away from me".
// They coincide whenever the phone is not rolled sideways (gamma = 0), so the
// tilt-weighted blend below only matters for rolled holds, where it smoothly
// hands over from one to the other.

import { COMPASS } from './config.js';

const DEG = Math.PI / 180;

/**
 * A direction whose horizontal projection is shorter than this (unit vector,
 * i.e. within ~1.4° of vertical) has no usable compass heading: sensor noise
 * would decide it. Both beta and gamma within 1° of 0 fall under it.
 */
const MIN_HORIZONTAL = 0.025;

/** Normalise degrees to [0, 360). */
function norm360(deg) {
  let r = deg % 360;
  if (r < 0) r += 360;          // a tiny negative (-1e-15) lands on 360.0 here...
  if (r >= 360 || r === 0) r = 0; // ...so fold 360 (and -0) back to 0
  return r;
}

// ---------------------------------------------------------------------------
// Pure heading helpers

/**
 * Heading of the device's top edge: (360 - alpha) when the screen faces up,
 * (180 - alpha) when it faces down (beta past 90). The top edge's direction
 * in the earth frame is (-sin a cos b, cos a cos b, sin b), so gamma plays no
 * part. Null when the edge points (almost) straight up or down.
 */
export function topEdgeHeading(alpha, beta) {
  if (!Number.isFinite(alpha) || !Number.isFinite(beta)) return null;
  const cosBeta = Math.cos(beta * DEG);
  if (Math.abs(cosBeta) < MIN_HORIZONTAL) return null;
  return norm360(cosBeta > 0 ? 360 - alpha : 180 - alpha);
}

/**
 * Heading of the rear camera's axis (the -z device axis), W3C DeviceOrientation
 * Event specification appendix A.1 ("worked example"): with x = beta,
 * y = gamma, z = alpha in radians,
 *   Vx = -cos(z) sin(y) - sin(z) sin(x) cos(y)      (east component)
 *   Vy = -sin(z) sin(y) + cos(z) sin(x) cos(y)      (north component)
 *   heading = atan2(Vx, Vy)
 * With beta = 90 this reduces to -(alpha + gamma). Null when the camera points
 * (almost) straight down or up, e.g. a flat phone (beta and gamma both ~0).
 */
export function cameraAxisHeading(alpha, beta, gamma) {
  if (!Number.isFinite(alpha) || !Number.isFinite(beta) || !Number.isFinite(gamma)) return null;
  const x = beta * DEG;
  const y = gamma * DEG;
  const z = alpha * DEG;
  const vx = -Math.cos(z) * Math.sin(y) - Math.sin(z) * Math.sin(x) * Math.cos(y);
  const vy = -Math.sin(z) * Math.sin(y) + Math.cos(z) * Math.sin(x) * Math.cos(y);
  if (Math.hypot(vx, vy) < MIN_HORIZONTAL) return null;
  return norm360(Math.atan2(vx, vy) / DEG);
}

/**
 * Heading of "up in the image": the top-edge heading weighted by the vertical
 * component of the screen normal, w = |cos(beta) cos(gamma)| (1 when the
 * phone is flat, 0 when upright), the camera-axis heading by 1 - w, combined
 * as a circular weighted mean. A null part is skipped; null when both are.
 *
 * screenAngle (optional, degrees from screen.orientation.angle) rotates the
 * top-edge part only: the top edge is what screen rotation moves, while the
 * camera keeps pointing where it points. With the default 0 (portrait) the
 * result is exactly the three-argument contract form.
 */
export function blendedHeading(alpha, beta, gamma, screenAngle = 0) {
  const top = topEdgeHeading(alpha, beta);
  const topUp = top == null ? null : screenUpHeading(top, screenAngle);
  const cam = cameraAxisHeading(alpha, beta, gamma);
  if (topUp == null && cam == null) return null;
  if (cam == null) return topUp;
  if (topUp == null) return cam;
  const w = Math.abs(Math.cos(beta * DEG) * Math.cos(gamma * DEG));
  return weightedCircularMean([[topUp, w], [cam, 1 - w]]);
}

/**
 * Heading and tilt from a DeviceOrientationEvent-like object, choosing the
 * source by behaviour rather than by platform sniffing:
 *   iOS: numeric webkitCompassHeading (Core Location's magnetic heading of the
 *        portrait top edge) with webkitCompassAccuracy >= 0; a negative
 *        accuracy means the compass is unreliable and the heading is dropped
 *   Android / Firefox: absolute === true with a numeric alpha -> blendedHeading
 *   anything else (relative events, no sensors): heading null
 * Returns { heading, source: 'ios'|'android'|'none', accuracy, pitch, roll }
 * with pitch = beta and roll = gamma (null when absent). The heading refers to
 * the device's top edge; apply screenUpHeading() for the current rotation.
 */
export function headingFromEvent(ev) {
  const e = ev && typeof ev === 'object' ? ev : {};
  const pitch = Number.isFinite(e.beta) ? e.beta : null;
  const roll = Number.isFinite(e.gamma) ? e.gamma : null;
  const none = { heading: null, source: 'none', accuracy: null, pitch, roll };
  if (Number.isFinite(e.webkitCompassHeading)) {
    const accuracy = e.webkitCompassAccuracy;
    if (Number.isFinite(accuracy) && accuracy >= 0) {
      return { heading: norm360(e.webkitCompassHeading), source: 'ios', accuracy, pitch, roll };
    }
    return none;
  }
  if (e.absolute === true && Number.isFinite(e.alpha)) {
    // Missing beta/gamma (rare) are taken as 0: flat phone, top edge rule.
    return { heading: blendedHeading(e.alpha, pitch ?? 0, roll ?? 0), source: 'android', accuracy: null, pitch, roll };
  }
  return none;
}

/**
 * Heading of "up on the screen" from the device-top heading and the screen
 * rotation: (deviceTopHeading + screenAngle) mod 360. screenAngle is
 * screen.orientation.angle (0, 90, 180, 270; window.orientation's -90 works
 * too). Null in, null out.
 */
export function screenUpHeading(deviceTopHeading, screenAngle) {
  if (!Number.isFinite(deviceTopHeading)) return null;
  const angle = Number.isFinite(screenAngle) ? screenAngle : 0;
  return norm360(deviceTopHeading + angle);
}

/**
 * Circular mean of headings in degrees -> { mean in [0, 360) | null, R }.
 * R is the mean resultant length (1 = all identical, 0 = evenly spread).
 * Non-finite entries are ignored; an empty (or fully cancelling) set gives
 * mean null and R 0.
 */
export function circularMean(degreesArray) {
  let s = 0;
  let c = 0;
  let n = 0;
  for (const d of degreesArray || []) {
    if (!Number.isFinite(d)) continue;
    s += Math.sin(d * DEG);
    c += Math.cos(d * DEG);
    n++;
  }
  if (n === 0) return { mean: null, R: 0 };
  const R = Math.min(1, Math.hypot(s, c) / n);
  if (R < 1e-9) return { mean: null, R: 0 };
  return { mean: norm360(Math.atan2(s, c) / DEG), R };
}

/**
 * Circular standard deviation in degrees, sqrt(-2 ln R) converted from
 * radians: ~0 for steady headings, large (Infinity for R = 0) for ones that
 * jump around. Null when there are no usable values.
 */
export function circularStdDeg(degreesArray) {
  const { mean, R } = circularMean(degreesArray);
  if (mean == null) return R === 0 && (degreesArray || []).some(Number.isFinite) ? Infinity : null;
  // Math.max(0, ...) turns the -0 of ln(1) into +0.
  return Math.sqrt(Math.max(0, -2 * Math.log(Math.max(R, Number.MIN_VALUE)))) / DEG;
}

/**
 * Pitch of the camera axis in degrees, generalising |beta| to rolled holds:
 * 0 = camera straight down (phone flat, screen up), 90 = horizontal,
 * 180 = camera straight up (phone face down). Equal to |beta| when gamma = 0.
 */
export function cameraPitch(beta, gamma = 0) {
  if (!Number.isFinite(beta)) return null;
  const g = Number.isFinite(gamma) ? gamma : 0;
  const up = Math.max(-1, Math.min(1, Math.cos(beta * DEG) * Math.cos(g * DEG))); // screen normal, vertical component
  return 90 - Math.asin(up) / DEG;
}

/** True when the hold is usable: pitchMin <= |pitch| <= pitchMax (config.COMPASS). */
export function tiltOk(pitch, cfg = COMPASS) {
  if (!Number.isFinite(pitch)) return false;
  const p = Math.abs(pitch);
  return p >= cfg.pitchMin && p <= cfg.pitchMax;
}

/** Circular mean of [heading, weight] pairs; null when nothing usable or fully cancelling. */
function weightedCircularMean(pairs) {
  let s = 0;
  let c = 0;
  let wsum = 0;
  for (const [deg, w] of pairs) {
    if (!Number.isFinite(deg) || !(w > 0)) continue;
    s += w * Math.sin(deg * DEG);
    c += w * Math.cos(deg * DEG);
    wsum += w;
  }
  if (wsum === 0 || Math.hypot(s, c) / wsum < 1e-9) return null;
  return norm360(Math.atan2(s, c) / DEG);
}

// ---------------------------------------------------------------------------
// Browser compass

/** Preference order between heading sources seen on the same device. */
const SOURCE_RANK = { ios: 2, android: 1, none: 0 };

function emptySample() {
  return {
    headingMag: null,
    source: 'none',
    accuracy: null,
    pitch: null,
    roll: null,
    tiltOk: false,
    updatedAt: null,
    needsCalibration: false,
    screenAngle: 0,
    cameraPitch: null,
  };
}

/**
 * Live compass for the browser. Everything degrades: with no window (Node) or
 * no sensors every method is a safe no-op and current() stays empty.
 *
 * opts: {
 *   win          window-like object (default: the global window when present);
 *                tests pass a fake with addEventListener/removeEventListener,
 *                screen.orientation.angle and DeviceOrientationEvent
 *   cfg          tilt thresholds (default config.COMPASS)
 *   jumpWindow   headings kept for the jumpiness check (default 10)
 *   jumpStdDeg   circular std dev above which needsCalibration is set (25)
 *   now          clock for updatedAt (default Date.now)
 * }
 * -> { requestPermission, start, stop, current, beginWindow, endWindow, onUpdate }
 */
export function createCompass(opts = {}) {
  const {
    win = typeof window !== 'undefined' ? window : undefined,
    cfg = COMPASS,
    jumpWindow = 10,
    jumpStdDeg = 25,
    now = () => Date.now(),
  } = opts;

  const subscribers = new Set();
  const recent = [];                 // last jumpWindow accepted headings (screen-up)
  let state = emptySample();
  let bestRank = 0;                  // best source seen so far; lesser sources are ignored
  let started = false;
  let windowSamples = null;          // array while a capture window is open
  let lastWindow = { headingMag: null, samples: 0, R: 0 };

  /** screen.orientation.angle, falling back to the deprecated window.orientation. */
  function screenAngle() {
    if (!win) return 0;
    const orientation = win.screen && win.screen.orientation;
    const raw = (orientation && orientation.angle) || win.orientation || 0;
    const n = Number(raw);
    return Number.isFinite(n) ? norm360(n) : 0;
  }

  function notify() {
    for (const fn of subscribers) {
      try {
        fn(current());
      } catch (err) {
        // one broken subscriber must not stop the others, or the sensor stream
        console.error('[compass] onUpdate subscriber failed', err);
      }
    }
  }

  function onEvent(ev) {
    const sample = headingFromEvent(ev);
    const angle = screenAngle();
    const pitch = sample.pitch;
    const roll = sample.roll;
    const camPitch = cameraPitch(pitch, roll ?? 0);
    const tilt = tiltOk(camPitch, cfg);
    const rank = SOURCE_RANK[sample.source] || 0;

    // Android events: the blend applies the screen angle to the top-edge part
    // only. iOS: webkitCompassHeading is the top edge, so rotate it whole.
    let headingMag = null;
    if (sample.heading != null && rank >= bestRank) {
      headingMag = sample.source === 'android'
        ? blendedHeading(ev.alpha, pitch ?? 0, roll ?? 0, angle)
        : screenUpHeading(sample.heading, angle);
    }

    if (headingMag == null) {
      // No usable heading (relative event, lesser source, degenerate pose,
      // or iOS saying its compass is unreliable): keep the tilt fresh, flag
      // an unreliable iOS compass, and tell subscribers only when that flag
      // newly turns on.
      const unreliableIos = !!ev && Number.isFinite(ev.webkitCompassHeading)
        && Number.isFinite(ev.webkitCompassAccuracy) && ev.webkitCompassAccuracy < 0;
      const flipped = unreliableIos && !state.needsCalibration;
      state = { ...state, pitch, roll, tiltOk: tilt, cameraPitch: camPitch, screenAngle: angle };
      if (unreliableIos) state.needsCalibration = true;
      if (flipped) notify();
      return;
    }

    bestRank = rank;
    recent.push(headingMag);
    if (recent.length > jumpWindow) recent.shift();
    // Jumpy readings (Android gives no accuracy figure) or a poor iOS accuracy
    // both mean "wave the phone in a figure 8".
    let needsCalibration = false;
    if (recent.length >= Math.min(jumpWindow, cfg.minSamples || 5)) {
      const std = circularStdDeg(recent);
      needsCalibration = std != null && std > jumpStdDeg;
    }
    if (sample.accuracy != null && sample.accuracy > jumpStdDeg) needsCalibration = true;

    state = {
      headingMag,
      source: sample.source,
      accuracy: sample.accuracy,
      pitch,
      roll,
      tiltOk: tilt,
      updatedAt: now(),
      needsCalibration,
      screenAngle: angle,
      cameraPitch: camPitch,
    };
    if (windowSamples) windowSamples.push(headingMag);
    notify();
  }

  function current() {
    return { ...state };
  }

  return {
    /**
     * Ask for motion access. MUST be called from a click/touchend handler:
     * DeviceOrientationEvent.requestPermission is invoked synchronously here,
     * before any await, so the tap's user activation still applies (iOS
     * rejects calls made without a gesture; Chrome 151+ also exposes the
     * function and currently answers 'granted' without a prompt).
     * -> 'granted' | 'denied' | 'unsupported'
     */
    async requestPermission() {
      if (!win || !('DeviceOrientationEvent' in win) || !win.DeviceOrientationEvent) return 'unsupported';
      const DOE = win.DeviceOrientationEvent;
      if (typeof DOE.requestPermission !== 'function') return 'granted';
      let result;
      try {
        result = await DOE.requestPermission(true);
      } catch (err) {
        return 'denied'; // NotAllowedError: no gesture, or the user said no earlier
      }
      // 'prompt' (Chromium with the setting still at Allow, or an http origin)
      // means no decision was made and events may still flow, so only an
      // explicit refusal counts as denied; the app judges the compass by
      // whether samples actually arrive.
      return result === 'denied' ? 'denied' : 'granted';
    },

    /** Listen on both event names; the handler keeps the best source (idempotent). */
    start() {
      if (!win || started || typeof win.addEventListener !== 'function') return;
      started = true;
      win.addEventListener('deviceorientationabsolute', onEvent);
      win.addEventListener('deviceorientation', onEvent);
    },

    stop() {
      if (!win || !started) return;
      started = false;
      if (typeof win.removeEventListener === 'function') {
        win.removeEventListener('deviceorientationabsolute', onEvent);
        win.removeEventListener('deviceorientation', onEvent);
      }
    },

    /** Latest sample; headingMag is magnetic and already screen-up corrected. */
    current,

    /** Start collecting headings for the capture window (resets an open one). */
    beginWindow() {
      windowSamples = [];
    },

    /**
     * Circular mean of the headings collected since beginWindow():
     * { headingMag, samples, R }. Closes the window; a later call without a
     * new beginWindow() returns the same summary.
     */
    endWindow() {
      if (windowSamples) {
        const { mean, R } = circularMean(windowSamples);
        lastWindow = { headingMag: mean, samples: windowSamples.length, R };
        windowSamples = null;
      }
      return { ...lastWindow };
    },

    /** fn(current()) after every accepted event; returns an unsubscribe function. */
    onUpdate(fn) {
      if (typeof fn !== 'function') return () => {};
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
}
