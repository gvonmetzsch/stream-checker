// tests/compass.test.mjs — heading helpers and the browser compass driven by
// fake DeviceOrientation events (iOS and Android shapes) in Node.
// Run with: node --test tests/compass.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  topEdgeHeading,
  cameraAxisHeading,
  blendedHeading,
  headingFromEvent,
  screenUpHeading,
  circularMean,
  circularStdDeg,
  cameraPitch,
  tiltOk,
  createCompass,
} from '../docs/compass.js';
import { COMPASS } from '../docs/config.js';

/** Smallest angular difference between two headings, 0..180. */
function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

function assertHeading(actual, expected, tol = 1e-6, msg = '') {
  assert.ok(Number.isFinite(actual), `${msg} expected ${expected}, got ${actual}`);
  assert.ok(actual >= 0 && actual < 360, `${msg} ${actual} not in [0, 360)`);
  assert.ok(angleDiff(actual, expected) <= tol, `${msg} expected ${expected}, got ${actual}`);
}

/** A window-like object with the pieces createCompass() touches. */
function fakeWindow({ DeviceOrientationEvent, screenAngle = 0, legacyOrientation } = {}) {
  const listeners = new Map();
  const win = {
    screen: { orientation: { angle: screenAngle } },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, ev) {
      for (const fn of listeners.get(type) || []) fn(ev);
    },
    listenerCount(type) {
      return listeners.get(type)?.size || 0;
    },
    setScreenAngle(angle) {
      win.screen.orientation.angle = angle;
    },
  };
  if (DeviceOrientationEvent !== undefined) win.DeviceOrientationEvent = DeviceOrientationEvent;
  if (legacyOrientation !== undefined) {
    win.screen = {}; // no screen.orientation at all, like old iOS
    win.orientation = legacyOrientation;
  }
  return win;
}

const ios = (heading, accuracy, beta = 45, gamma = 0) => ({
  webkitCompassHeading: heading, webkitCompassAccuracy: accuracy, alpha: 123, beta, gamma, absolute: false,
});
const android = (alpha, beta = 40, gamma = 0) => ({ absolute: true, alpha, beta, gamma });
const relative = (alpha, beta = 40, gamma = 0) => ({ absolute: false, alpha, beta, gamma });

// ---------------------------------------------------------------------------
// pure helpers

test('topEdgeHeading: 360 - alpha face up, 180 - alpha face down, null when upright', () => {
  assert.equal(topEdgeHeading(0, 0), 0);
  assert.equal(topEdgeHeading(90, 0), 270);
  assert.equal(topEdgeHeading(0, 180), 180);   // phone face down
  assert.equal(topEdgeHeading(45, 45), 315);
  assert.equal(topEdgeHeading(45, -45), 315);
  assert.equal(topEdgeHeading(30, 150), 150);  // past vertical, screen facing down
  for (const beta of [90, 89.5, 90.5, -90, 270]) {
    assert.equal(topEdgeHeading(0, beta), null, `beta ${beta}`);
  }
  assert.equal(topEdgeHeading(0, 85), 0);      // steep but still defined
  assert.equal(topEdgeHeading(null, 0), null);
  assert.equal(topEdgeHeading(0, NaN), null);
});

test('cameraAxisHeading: W3C appendix A.1, null when the camera points straight down or up', () => {
  assertHeading(cameraAxisHeading(0, 90, 0), 0);
  assertHeading(cameraAxisHeading(90, 90, 0), 270);
  // with beta = 90 the spec formula reduces to -(alpha + gamma)
  for (const [alpha, gamma] of [[0, 0], [30, 20], [200, -50], [350, 45]]) {
    assertHeading(cameraAxisHeading(alpha, 90, gamma), (720 - alpha - gamma) % 360, 1e-6, `alpha ${alpha} gamma ${gamma}`);
  }
  assert.equal(cameraAxisHeading(0, 0, 0), null);      // flat: camera straight down
  assert.equal(cameraAxisHeading(123, 0.5, -0.5), null);
  assert.equal(cameraAxisHeading(0, 180, 0), null);    // face down: camera straight up
  assert.equal(cameraAxisHeading(0, 0, 180), null);
  assertHeading(cameraAxisHeading(0, 45, 0), 0);        // pitched forward: camera looks north
  assertHeading(cameraAxisHeading(0, -45, 0), 180);     // pitched back: camera looks south
  // flat phone, top edge north, rolled to the right: camera looks east... and
  // rolled left looks west
  assertHeading(cameraAxisHeading(0, 0, 45), 270);
  assertHeading(cameraAxisHeading(0, 0, -45), 90);
  assert.equal(cameraAxisHeading(0, 45, undefined), null);
});

test('blendedHeading equals topEdge when flat, cameraAxis when upright, and is continuous', () => {
  assert.equal(blendedHeading(30, 0, 0), topEdgeHeading(30, 0));
  assert.equal(blendedHeading(200, 0, 0), 160);
  assertHeading(blendedHeading(30, 90, 20), cameraAxisHeading(30, 90, 20));
  assertHeading(blendedHeading(30, 90, 0), 330);
  // null only when both parts are degenerate (never for real poses: upright
  // always has a camera heading, flat always has a top edge)
  assert.equal(blendedHeading(NaN, 0, 0), null);
  for (const gamma of [0, 20, 45]) {
    let prev = null;
    for (let beta = 0; beta <= 90; beta++) {
      const h = blendedHeading(30, beta, gamma);
      assert.ok(Number.isFinite(h), `beta ${beta} gamma ${gamma}`);
      if (prev != null) assert.ok(angleDiff(h, prev) < 5, `jump at beta ${beta} gamma ${gamma}: ${prev} -> ${h}`);
      prev = h;
    }
  }
  // constant alpha=30, gamma=0: both parts agree, so the blend is 330 throughout
  for (let beta = 0; beta <= 90; beta += 5) assertHeading(blendedHeading(30, beta, 0), 330, 1e-6, `beta ${beta}`);
});

test('blendedHeading with a screen angle rotates the top-edge part only', () => {
  // Portrait: identical to the three-argument form.
  assert.equal(blendedHeading(30, 45, 20, 0), blendedHeading(30, 45, 20));
  // Flat phone rotated to landscape-primary (angle 90): screen-up = top + 90.
  assertHeading(blendedHeading(90, 0, 0, 90), 0);
  // Upright landscape-primary (top edge west, camera north): the camera axis
  // already is screen-up, so the result stays north. Applying the angle to
  // the whole blend would have said east.
  assertHeading(blendedHeading(90, 0, -90, 90), 0);
  assertHeading(screenUpHeading(blendedHeading(90, 0, -90), 90), 90);
  // and the pitched landscape hold in between agrees with both ends
  assertHeading(blendedHeading(90, 0, -45, 90), 0);
});

test('headingFromEvent picks the source by behaviour', () => {
  const iosSample = headingFromEvent({ webkitCompassHeading: 123.4, webkitCompassAccuracy: 10, alpha: 55, beta: 45, gamma: 2 });
  assert.deepEqual(iosSample, { heading: 123.4, source: 'ios', accuracy: 10, pitch: 45, roll: 2 });
  // iOS says the compass is unreliable
  const bad = headingFromEvent({ webkitCompassHeading: 123.4, webkitCompassAccuracy: -1, alpha: 55, beta: 45, gamma: 2 });
  assert.equal(bad.heading, null);
  assert.equal(bad.source, 'none');
  assert.equal(bad.pitch, 45);
  // Android / Firefox absolute event
  const droid = headingFromEvent({ absolute: true, alpha: 300, beta: 40, gamma: 0 });
  assert.equal(droid.source, 'android');
  assert.equal(droid.accuracy, null);
  assertHeading(droid.heading, 60);
  assert.equal(droid.pitch, 40);
  assert.equal(droid.roll, 0);
  // relative event: no heading, tilt still reported
  assert.deepEqual(headingFromEvent({ absolute: false, alpha: 300, beta: 40, gamma: 0 }), { heading: null, source: 'none', accuracy: null, pitch: 40, roll: 0 });
  // absolute flag without a usable alpha
  assert.equal(headingFromEvent({ absolute: true, alpha: null, beta: 40, gamma: 0 }).heading, null);
  // garbage in
  assert.deepEqual(headingFromEvent(null), { heading: null, source: 'none', accuracy: null, pitch: null, roll: null });
  assert.deepEqual(headingFromEvent({}), { heading: null, source: 'none', accuracy: null, pitch: null, roll: null });
  // missing beta/gamma on Android: treated as flat, heading still produced
  assertHeading(headingFromEvent({ absolute: true, alpha: 10 }).heading, 350);
  assert.equal(headingFromEvent({ absolute: true, alpha: 10 }).pitch, null);
});

test('screenUpHeading adds the screen angle modulo 360', () => {
  assert.equal(screenUpHeading(350, 90), 80);
  assert.equal(screenUpHeading(0, 0), 0);
  assert.equal(screenUpHeading(10, 270), 280);
  assert.equal(screenUpHeading(10, -90), 280);   // window.orientation style
  assert.equal(screenUpHeading(180, 180), 0);
  assert.equal(screenUpHeading(45, undefined), 45);
  assert.equal(screenUpHeading(null, 90), null);
});

test('circularMean handles wrap-around, spread and empty input', () => {
  const m = circularMean([350, 10]);
  assertHeading(m.mean, 0);
  assert.ok(Math.abs(m.R - Math.cos(10 * Math.PI / 180)) < 1e-9, `R ${m.R}`);
  assert.ok(m.R > 0.98 && m.R < 0.99);
  assert.deepEqual(circularMean([90]), { mean: 90, R: 1 });
  assert.deepEqual(circularMean([]), { mean: null, R: 0 });
  assert.deepEqual(circularMean(undefined), { mean: null, R: 0 });
  assert.deepEqual(circularMean([0, 180]), { mean: null, R: 0 });
  assert.deepEqual(circularMean([NaN, null, 90]), { mean: 90, R: 1 });
  const spread = circularMean([0, 90, 180, 270]);
  assert.equal(spread.mean, null);
  assertHeading(circularMean([80, 100]).mean, 90);
});

test('circularStdDeg is small for steady headings and large for jumpy ones', () => {
  assert.ok(circularStdDeg([0, 2, 358, 1, 359, 0, 1, 2, 359, 0]) < 5);
  assert.ok(circularStdDeg([0, 120, 0, 120, 0, 120, 0, 120, 0, 120]) > 25);
  assert.equal(circularStdDeg([0, 180]), Infinity);
  assert.equal(circularStdDeg([]), null);
  assert.equal(circularStdDeg([45, 45, 45]), 0);
});

test('cameraPitch generalises |beta| to rolled holds', () => {
  assert.ok(Math.abs(cameraPitch(45, 0) - 45) < 1e-9);
  assert.ok(Math.abs(cameraPitch(-45, 0) - 45) < 1e-9);
  assert.ok(Math.abs(cameraPitch(100, 0) - 100) < 1e-9);
  assert.ok(Math.abs(cameraPitch(0, -45) - 45) < 1e-9);   // landscape, pitched 45 down
  assert.ok(Math.abs(cameraPitch(0, 0)) < 1e-9);
  assert.ok(Math.abs(cameraPitch(180, 0) - 180) < 1e-9);
  assert.ok(Math.abs(cameraPitch(45) - 45) < 1e-9);         // gamma defaults to 0
  assert.equal(cameraPitch(null, 0), null);
});

test('tiltOk ranges from config.COMPASS', () => {
  assert.equal(COMPASS.pitchMin, 10);
  assert.equal(COMPASS.pitchMax, 80);
  assert.equal(tiltOk(0), false);
  assert.equal(tiltOk(9.9), false);
  assert.equal(tiltOk(10), true);
  assert.equal(tiltOk(45), true);
  assert.equal(tiltOk(80), true);
  assert.equal(tiltOk(80.1), false);
  assert.equal(tiltOk(-45), true);
  assert.equal(tiltOk(100), false);
  assert.equal(tiltOk(null), false);
  assert.equal(tiltOk(NaN), false);
  assert.equal(tiltOk(5, { pitchMin: 0, pitchMax: 90 }), true);
});

// ---------------------------------------------------------------------------
// createCompass

test('createCompass without a window is a bundle of safe no-ops', async () => {
  for (const compass of [createCompass(), createCompass({ win: undefined })]) {
    assert.equal(await compass.requestPermission(), 'unsupported');
    compass.start();
    compass.start();
    compass.beginWindow();
    assert.deepEqual(compass.endWindow(), { headingMag: null, samples: 0, R: 0 });
    assert.deepEqual(compass.endWindow(), { headingMag: null, samples: 0, R: 0 });
    const c = compass.current();
    assert.equal(c.headingMag, null);
    assert.equal(c.source, 'none');
    assert.equal(c.tiltOk, false);
    assert.equal(c.needsCalibration, false);
    const off = compass.onUpdate(() => {});
    assert.equal(typeof off, 'function');
    off();
    compass.stop();
    compass.stop();
  }
});

test('requestPermission calls DeviceOrientationEvent.requestPermission(true) synchronously', async () => {
  let calls = [];
  const DOE = { requestPermission: (...args) => { calls.push(args); return Promise.resolve('granted'); } };
  const compass = createCompass({ win: fakeWindow({ DeviceOrientationEvent: DOE }) });
  const p = compass.requestPermission();
  // invoked before the microtask queue runs: still inside the click's activation
  assert.deepEqual(calls, [[true]]);
  assert.equal(await p, 'granted');

  const denied = createCompass({ win: fakeWindow({ DeviceOrientationEvent: { requestPermission: async () => 'denied' } }) });
  assert.equal(await denied.requestPermission(), 'denied');

  // iOS rejects with NotAllowedError when called without a gesture (or after an earlier "Don't Allow")
  const rejecting = createCompass({ win: fakeWindow({ DeviceOrientationEvent: { requestPermission: () => Promise.reject(new Error('NotAllowedError')) } }) });
  assert.equal(await rejecting.requestPermission(), 'denied');

  // Android Chrome / Firefox before 151: the event exists, the function does not
  const plain = createCompass({ win: fakeWindow({ DeviceOrientationEvent: function DeviceOrientationEvent() {} }) });
  assert.equal(await plain.requestPermission(), 'granted');

  // desktop without sensors
  const none = createCompass({ win: fakeWindow() });
  assert.equal(await none.requestPermission(), 'unsupported');
});

test('start() listens on both event names, stop() removes both', () => {
  const win = fakeWindow();
  const compass = createCompass({ win });
  compass.start();
  compass.start();
  assert.equal(win.listenerCount('deviceorientationabsolute'), 1);
  assert.equal(win.listenerCount('deviceorientation'), 1);
  compass.stop();
  assert.equal(win.listenerCount('deviceorientationabsolute'), 0);
  assert.equal(win.listenerCount('deviceorientation'), 0);
  win.dispatch('deviceorientation', ios(100, 5));
  assert.equal(compass.current().headingMag, null);
});

test('iOS events: webkitCompassHeading, screen-up corrected, accuracy and tilt reported', () => {
  const win = fakeWindow({ screenAngle: 0 });
  const compass = createCompass({ win, now: () => 1234 });
  const seen = [];
  compass.onUpdate((s) => seen.push(s));
  compass.start();
  win.dispatch('deviceorientation', ios(100, 10, 45, 0));
  let c = compass.current();
  assert.equal(c.headingMag, 100);
  assert.equal(c.source, 'ios');
  assert.equal(c.accuracy, 10);
  assert.equal(c.pitch, 45);
  assert.equal(c.roll, 0);
  assert.equal(c.tiltOk, true);
  assert.equal(c.updatedAt, 1234);
  assert.equal(c.needsCalibration, false);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], c);
  // flat phone: tilt not ok; current() is a copy, not shared state
  win.dispatch('deviceorientation', ios(100, 10, 3, 0));
  assert.equal(compass.current().tiltOk, false);
  seen[1].headingMag = -1;
  assert.equal(compass.current().headingMag, 100);
  // landscape: screen.orientation.angle is added
  win.setScreenAngle(90);
  win.dispatch('deviceorientation', ios(350, 10, 0, -45));
  c = compass.current();
  assert.equal(c.headingMag, 80);
  assert.equal(c.screenAngle, 90);
  assert.equal(c.tiltOk, true); // landscape hold pitched 45 down counts as a good tilt
  // iOS accuracy worse than the jump threshold -> calibrate
  win.setScreenAngle(0);
  win.dispatch('deviceorientation', ios(100, 40));
  assert.equal(compass.current().needsCalibration, true);
  win.dispatch('deviceorientation', ios(100, 5));
  assert.equal(compass.current().needsCalibration, false);
});

test('iOS unreliable compass (accuracy < 0): heading dropped, calibration flagged once', () => {
  const win = fakeWindow();
  const compass = createCompass({ win });
  const seen = [];
  compass.onUpdate((s) => seen.push(s));
  compass.start();
  win.dispatch('deviceorientation', ios(100, -1, 45, 0));
  win.dispatch('deviceorientation', ios(100, -1, 45, 0));
  let c = compass.current();
  assert.equal(c.headingMag, null);
  assert.equal(c.needsCalibration, true);
  assert.equal(c.pitch, 45);
  assert.equal(c.tiltOk, true);
  assert.equal(seen.length, 1, 'notified once when the flag turned on');
  // a good sample clears it
  win.dispatch('deviceorientation', ios(100, 5, 45, 0));
  c = compass.current();
  assert.equal(c.headingMag, 100);
  assert.equal(c.needsCalibration, false);
  assert.equal(seen.length, 2);
});

test('Android events: absolute accepted, relative ignored, screen angle on the top-edge part', () => {
  const win = fakeWindow();
  const compass = createCompass({ win });
  let updates = 0;
  compass.onUpdate(() => updates++);
  compass.start();
  win.dispatch('deviceorientationabsolute', android(300, 40, 0));
  let c = compass.current();
  assertHeading(c.headingMag, 60);
  assert.equal(c.source, 'android');
  assert.equal(c.accuracy, null);
  assert.equal(c.pitch, 40);
  assert.equal(c.tiltOk, true);
  assert.equal(updates, 1);
  // Chrome also fires relative 'deviceorientation' events: no heading from them
  win.dispatch('deviceorientation', relative(10, 5, 0));
  c = compass.current();
  assertHeading(c.headingMag, 60);
  assert.equal(c.pitch, 5, 'tilt still follows the latest event');
  assert.equal(c.tiltOk, false);
  assert.equal(updates, 1, 'no notification for a relative event');
  // Firefox fires absolute events under the plain name
  win.dispatch('deviceorientation', android(270, 40, 0));
  assertHeading(compass.current().headingMag, 90);
  assert.equal(updates, 2);
  // landscape-primary, upright: the camera axis is screen-up already
  win.setScreenAngle(90);
  win.dispatch('deviceorientationabsolute', android(90, 0, -90));
  c = compass.current();
  assertHeading(c.headingMag, 0);
  assert.equal(c.screenAngle, 90);
  // landscape-primary, flat: top edge + 90
  win.dispatch('deviceorientationabsolute', android(90, 0, 0));
  assertHeading(compass.current().headingMag, 0);
  // the deprecated window.orientation (-90 = landscape-secondary, top edge to
  // the right) is used when screen.orientation is missing
  const legacy = fakeWindow({ legacyOrientation: -90 });
  const compass2 = createCompass({ win: legacy });
  compass2.start();
  legacy.dispatch('deviceorientationabsolute', android(0, 0, 0)); // flat, top edge north: screen-up is west
  assertHeading(compass2.current().headingMag, 270);
  assert.equal(compass2.current().screenAngle, 270);
  legacy.dispatch('deviceorientationabsolute', android(270, 0, 90)); // upright, top edge east, camera north
  assertHeading(compass2.current().headingMag, 0);
});

test('source preference: an iOS heading is kept over a later absolute event', () => {
  const win = fakeWindow();
  const compass = createCompass({ win });
  compass.start();
  win.dispatch('deviceorientationabsolute', android(300));
  assertHeading(compass.current().headingMag, 60);
  win.dispatch('deviceorientation', ios(123, 5));
  assert.equal(compass.current().headingMag, 123);
  win.dispatch('deviceorientationabsolute', android(300));
  assert.equal(compass.current().headingMag, 123, 'lesser source ignored once iOS was seen');
  assert.equal(compass.current().source, 'ios');
});

test('beginWindow/endWindow: circular mean of the samples in the window', () => {
  const win = fakeWindow();
  const compass = createCompass({ win });
  compass.start();
  win.dispatch('deviceorientation', ios(200, 5));   // before the window: not counted
  compass.beginWindow();
  for (const h of [350, 10, 0, 355, 5]) win.dispatch('deviceorientation', ios(h, 5));
  win.dispatch('deviceorientation', relative(90)); // ignored
  const w = compass.endWindow();
  assert.equal(w.samples, 5);
  assertHeading(w.headingMag, 0);
  assert.ok(w.R > 0.99 && w.R <= 1, `R ${w.R}`);
  // the window is closed: later samples do not change the summary
  win.dispatch('deviceorientation', ios(180, 5));
  assert.deepEqual(compass.endWindow(), w);
  // a new window starts empty
  compass.beginWindow();
  assert.deepEqual(compass.endWindow(), { headingMag: null, samples: 0, R: 0 });
  // samples are screen-up corrected
  win.setScreenAngle(90);
  compass.beginWindow();
  win.dispatch('deviceorientation', ios(350, 5));
  assert.equal(compass.endWindow().headingMag, 80);
});

test('jumpy headings set needsCalibration, steady ones clear it', () => {
  const win = fakeWindow();
  const compass = createCompass({ win });
  compass.start();
  const jumpy = [0, 120, 240, 10, 130, 250, 5, 115, 235, 20];
  for (const h of jumpy) win.dispatch('deviceorientation', ios(h, 5));
  assert.equal(compass.current().needsCalibration, true);
  for (let i = 0; i < 10; i++) win.dispatch('deviceorientation', ios(90 + (i % 2), 5));
  assert.equal(compass.current().needsCalibration, false);
  // the threshold is the circular standard deviation of the last 10 headings
  const strict = createCompass({ win, jumpStdDeg: 2 });
  strict.start();
  for (let i = 0; i < 10; i++) win.dispatch('deviceorientation', ios(i % 2 ? 95 : 85, 5));
  assert.equal(strict.current().needsCalibration, true);
});

test('onUpdate: subscribers get current() per accepted event; unsubscribe works; a throwing subscriber does not break the others', () => {
  const win = fakeWindow();
  const compass = createCompass({ win });
  const a = [];
  const b = [];
  const offA = compass.onUpdate((s) => a.push(s.headingMag));
  const originalError = console.error;
  console.error = () => {};
  try {
    compass.onUpdate(() => { throw new Error('boom'); });
    compass.onUpdate((s) => b.push(s.headingMag));
    compass.start();
    win.dispatch('deviceorientation', ios(10, 5));
    win.dispatch('deviceorientation', ios(20, 5));
    offA();
    win.dispatch('deviceorientation', ios(30, 5));
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(a, [10, 20]);
  assert.deepEqual(b, [10, 20, 30]);
  assert.equal(typeof compass.onUpdate(null), 'function');
});
