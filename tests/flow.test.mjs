// tests/flow.test.mjs — optical flow unit tests on synthetic water clips.
// Run with: node --test tests/flow.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  toGray,
  estimateFlow,
  blockGrid,
  FlowAccumulator,
  classifyMotion,
  imageAngleToBearing,
  vectorAngleDeg,
  AMBIGUITY_RATIO,
} from '../docs/flow.js';
import { FLOW, ANALYSIS_WIDTH } from '../docs/config.js';
import { makeClip, makeBlankClip, makeNoiseClip, makeWaterTexture, renderFrame, mulberry32 } from './helpers/synth.mjs';

const W = 160;
const H = 120;
const PAIRS = 60;

// Frame rate of the synthetic clips. The camera-jitter velocity between
// consecutive frames is 2 * amplitude * sin(pi * f / fps): for 1.2 px at 2 Hz
// that is 0.50 px/frame at 30 fps but 0.98 px/frame at 15 fps, which exceeds
// the slowest flow tested (0.6 px/frame) and makes the per-pair unit vectors
// swing through every direction. No per-pair statistic can call that
// consistent, so the clips are synthesised at a camera rate of 30 fps.
const SYNTH_FPS = 30;
const JITTER = { amplitude: 1.2, frequency: 2, fps: SYNTH_FPS, ratio: 1 };

const here = dirname(fileURLToPath(import.meta.url));
const VIDEO_DIR = join(here, 'fixtures', 'video');

/** Signed smallest difference a - b in (-180, 180]. */
function angleDiff(a, b) {
  return ((a - b + 540) % 360) - 180;
}

/** Run estimateFlow over consecutive frames, return the accumulator and timing stats. */
function runClip(clip, opts = {}) {
  const acc = new FlowAccumulator();
  const times = [];
  const { frames, width, height } = clip;
  for (let k = 0; k + 1 < frames.length; k++) {
    const t0 = performance.now();
    const r = estimateFlow(frames[k], frames[k + 1], width, height, opts);
    times.push(performance.now() - t0);
    acc.add(r);
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  return { acc, result: acc.result(), timing: { mean, median: times[times.length >> 1], max: times[times.length - 1] } };
}

function fmtTiming(t) {
  return `${t.mean.toFixed(2)} ms/pair mean, ${t.median.toFixed(2)} median, ${t.max.toFixed(2)} max`;
}

// ---------------------------------------------------------------------------
// toGray

test('toGray: Rec. 601 luma from RGBA', () => {
  const px = [
    [255, 255, 255, 255], // white -> 255
    [0, 0, 0, 255], // black -> 0
    [255, 0, 0, 255], // red -> ~76.5
    [0, 255, 0, 255], // green -> ~149.7
    [0, 0, 255, 255], // blue -> ~29.1
    [128, 128, 128, 0], // alpha ignored
  ];
  const data = new Uint8ClampedArray(px.flat());
  const gray = toGray({ data, width: 3, height: 2 });
  assert.ok(gray instanceof Uint8ClampedArray);
  assert.equal(gray.length, 6);
  const expected = [255, 0, 76, 150, 29, 128];
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(gray[i] - expected[i]) <= 1, `pixel ${i}: ${gray[i]} vs ${expected[i]}`);
  }
  assert.throws(() => toGray({ data: new Uint8ClampedArray(8), width: 3, height: 2 }), RangeError);
});

// ---------------------------------------------------------------------------
// blockGrid and estimateFlow basics

test('blockGrid: windows inset by the search range and centred', () => {
  const g = blockGrid(W, H, FLOW.block, FLOW.stride, FLOW.range);
  // spans 136 and 96 are exact multiples of the stride, so no extra margin
  assert.deepEqual(g, { x0: 6, y0: 6, nx: 18, ny: 13 });
  // an odd leftover is split: span 141 -> 17 steps of 8 = 136, margin 5 -> 2 each side
  assert.deepEqual(blockGrid(165, 125, FLOW.block, FLOW.stride, FLOW.range), { x0: 8, y0: 8, nx: 18, ny: 13 });
  // last window plus search range stays inside the frame
  assert.ok(g.x0 + (g.nx - 1) * FLOW.stride + FLOW.block + FLOW.range <= W);
  assert.ok(g.y0 + (g.ny - 1) * FLOW.stride + FLOW.block + FLOW.range <= H);
  assert.deepEqual(blockGrid(10, 10), { x0: 0, y0: 0, nx: 0, ny: 0 });
});

test('estimateFlow: exact integer translation is recovered on every block', () => {
  const tile = makeWaterTexture({ seed: 11 });
  const prev = renderFrame(tile, W, H, 0, 0);
  const curr = renderFrame(tile, W, H, 3, -2); // content moves 3 right, 2 up
  const r = estimateFlow(prev, curr, W, H, { returnVectors: true });
  assert.equal(r.total, 18 * 13);
  assert.ok(r.accepted >= 0.9 * r.total, `accepted ${r.accepted}/${r.total}`);
  assert.ok(Math.abs(r.dx - 3) < 0.05, `dx ${r.dx}`);
  assert.ok(Math.abs(r.dy + 2) < 0.05, `dy ${r.dy}`);
  assert.equal(r.vectors.length, r.accepted);
  for (const v of r.vectors) {
    assert.ok(v.x >= 0 && v.x <= W && v.y >= 0 && v.y <= H);
    // Per block the parabola through an asymmetric texture can wander by a
    // few hundredths of a pixel; the median above is exact to 0.05.
    assert.ok(Math.abs(v.dx - 3) < 0.15 && Math.abs(v.dy + 2) < 0.15, `block vector ${v.dx},${v.dy}`);
  }
  const noVec = estimateFlow(prev, curr, W, H);
  assert.equal(noVec.vectors, null);
});

test('estimateFlow: sub-pixel translation is refined within 0.25 px', () => {
  const tile = makeWaterTexture({ seed: 5 });
  const rng = mulberry32(99);
  const prev = renderFrame(tile, W, H, 0, 0, 2, rng);
  const curr = renderFrame(tile, W, H, -1.3, 0.45, 2, rng);
  const r = estimateFlow(prev, curr, W, H);
  assert.ok(r.accepted > 0.8 * r.total, `accepted ${r.accepted}/${r.total}`);
  assert.ok(Math.abs(r.dx + 1.3) < 0.25, `dx ${r.dx}`);
  assert.ok(Math.abs(r.dy - 0.45) < 0.25, `dy ${r.dy}`);
});

test('estimateFlow: motion beyond the search range is not accepted as something else', () => {
  const tile = makeWaterTexture({ seed: 8 });
  const prev = renderFrame(tile, W, H, 0, 0);
  const curr = renderFrame(tile, W, H, 40, 0); // far outside +/- range
  const r = estimateFlow(prev, curr, W, H);
  // A random alignment of the texture has no clear minimum; the ambiguity gate
  // drops most blocks instead of inventing vectors (measured: 10-21% slip
  // through at AMBIGUITY_RATIO 0.5, against 65% at 0.7). Without the gate
  // every block would be accepted.
  assert.ok(r.accepted <= 0.3 * r.total, `accepted ${r.accepted}/${r.total}`);
  const loose = estimateFlow(prev, curr, W, H, { ambiguityRatio: 2 });
  // (all but the odd flat patch that the texture gate skips)
  assert.ok(loose.accepted >= 0.95 * loose.total, `loose accepted ${loose.accepted}/${loose.total}`);
});

test('estimateFlow: flat frames fail the texture gate', () => {
  const blank = makeBlankClip({ width: W, height: H, frames: 2, noise: 1 });
  const r = estimateFlow(blank.frames[0], blank.frames[1], W, H);
  assert.equal(r.accepted, 0);
  assert.equal(r.total, 18 * 13);
  assert.ok(Number.isNaN(r.dx) && Number.isNaN(r.dy));
});

test('estimateFlow: uncorrelated noise passes the texture gate but fails the ambiguity gate', () => {
  const noise = makeNoiseClip({ width: W, height: H, frames: 2, noise: 12 }); // variance 144 >= minVariance
  const r = estimateFlow(noise.frames[0], noise.frames[1], W, H);
  assert.ok(r.accepted <= 0.1 * r.total, `accepted ${r.accepted}/${r.total}`);
  // and with the gate switched off every block would be accepted
  const loose = estimateFlow(noise.frames[0], noise.frames[1], W, H, { ambiguityRatio: 2 });
  assert.equal(loose.accepted, loose.total);
  assert.ok(AMBIGUITY_RATIO > 0 && AMBIGUITY_RATIO < 1);
});

test('estimateFlow: honours block/stride/range options and validates sizes', () => {
  const tile = makeWaterTexture({ seed: 2 });
  const prev = renderFrame(tile, W, H, 0, 0);
  const curr = renderFrame(tile, W, H, 2, 1);
  const r = estimateFlow(prev, curr, W, H, { block: 8, stride: 16, range: 3 });
  const g = blockGrid(W, H, 8, 16, 3);
  assert.equal(r.total, g.nx * g.ny);
  assert.ok(Math.abs(r.dx - 2) < 0.1 && Math.abs(r.dy - 1) < 0.1, `${r.dx},${r.dy}`);
  assert.throws(() => estimateFlow(prev, curr.subarray(0, 100), W, H), RangeError);
  // plain Uint8Array input is accepted (copied to keep the hot loop monomorphic)
  const r2 = estimateFlow(new Uint8Array(prev), new Uint8Array(curr), W, H);
  assert.ok(Math.abs(r2.dx - 2) < 0.1);
});

// ---------------------------------------------------------------------------
// Performance

test('estimateFlow: a 160x120 pair runs well under 30 ms', (t) => {
  const tile = makeWaterTexture({ seed: 3 });
  const rng = mulberry32(1);
  const prev = renderFrame(tile, W, H, 0, 0, 2, rng);
  const curr = renderFrame(tile, W, H, 1.1, -1.0, 2, rng);
  for (let i = 0; i < 15; i++) estimateFlow(prev, curr, W, H); // warm up the JIT
  const times = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    estimateFlow(prev, curr, W, H);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[15];
  t.diagnostic(`estimateFlow 160x120 (234 blocks, 169 displacements each): median ${median.toFixed(2)} ms, min ${times[0].toFixed(2)} ms, max ${times[29].toFixed(2)} ms`);
  console.log(`  estimateFlow 160x120: median ${median.toFixed(2)} ms per pair (min ${times[0].toFixed(2)}, max ${times[29].toFixed(2)})`);
  assert.ok(median < 30, `median ${median.toFixed(2)} ms is not under 30 ms`);
});

// ---------------------------------------------------------------------------
// Accumulated flow on synthetic clips

test('flow direction and speed matrix with camera jitter', (t) => {
  const angles = [0, 45, 90, 135, 180, 225, 270, 315];
  const speeds = [0.6, 1.5, 3.5];
  let seed = 100;
  for (const speed of speeds) {
    for (const angle of angles) {
      const clip = makeClip({ width: W, height: H, frames: PAIRS + 1, angleDeg: angle, speed, jitter: JITTER, noise: 2, seed: seed++ });
      const { result, timing } = runClip(clip);
      const err = angleDiff(result.angleDeg, angle);
      const line = `angle ${String(angle).padStart(3)} speed ${speed}: est ${result.angleDeg.toFixed(1)} (err ${err.toFixed(1)}), speed ${result.speed.toFixed(2)}, R ${result.consistency.toFixed(2)}, cov ${result.coverage.toFixed(2)}, shake ${result.shake.toFixed(2)} -> ${classifyMotion(result)}; ${fmtTiming(timing)}`;
      t.diagnostic(line);
      console.log('  ' + line);
      assert.equal(result.frames, PAIRS);
      assert.ok(Math.abs(err) < 8, `angle ${angle} speed ${speed}: estimated ${result.angleDeg} (error ${err.toFixed(1)})`);
      assert.ok(result.consistency > 0.7, `angle ${angle} speed ${speed}: consistency ${result.consistency}`);
      assert.ok(result.coverage > 0.8, `coverage ${result.coverage}`);
      assert.ok(result.speed > 0.6 * speed && result.speed < 1.6 * speed, `speed ${result.speed} vs ${speed}`);
      assert.equal(classifyMotion(result), 'flowing');
    }
  }
});

test('static textured clip -> still', (t) => {
  const clip = makeClip({ width: W, height: H, frames: PAIRS + 1, angleDeg: 0, speed: 0, noise: 2, seed: 7 });
  const { result, timing } = runClip(clip);
  t.diagnostic(`static: speed ${result.speed.toFixed(3)}, coverage ${result.coverage.toFixed(2)}, shake ${result.shake.toFixed(4)}; ${fmtTiming(timing)}`);
  assert.ok(result.coverage > 0.8);
  assert.ok(result.speed < FLOW.minSpeed, `speed ${result.speed}`);
  assert.equal(classifyMotion(result), 'still');
});

test('blank clip -> no_texture', (t) => {
  const clip = makeBlankClip({ width: W, height: H, frames: PAIRS + 1, noise: 1.5, seed: 9 });
  const { result, timing } = runClip(clip);
  t.diagnostic(`blank: coverage ${result.coverage}, frames ${result.frames}; ${fmtTiming(timing)}`);
  assert.equal(result.frames, PAIRS);
  assert.equal(result.angleDeg, null);
  assert.ok(result.coverage < FLOW.minCoverage);
  assert.equal(classifyMotion(result), 'no_texture');
});

test('low-contrast texture below the variance gate -> no_texture', () => {
  const clip = makeClip({ width: W, height: H, frames: 12, angleDeg: 90, speed: 1, noise: 1, seed: 4, texture: { contrast: 3, glints: 0 } });
  const { result } = runClip(clip);
  assert.ok(result.coverage < FLOW.minCoverage, `coverage ${result.coverage}`);
  assert.equal(classifyMotion(result), 'no_texture');
});

test('pure camera jitter (3 px, no net motion) -> still or shaky, never flowing', (t) => {
  for (const ratio of [1, 0]) {
    const clip = makeClip({
      width: W, height: H, frames: PAIRS + 1, angleDeg: 0, speed: 0, noise: 2, seed: 21 + ratio,
      jitter: { amplitude: 3, frequency: 2, fps: SYNTH_FPS, ratio },
    });
    const { result, timing } = runClip(clip);
    const motion = classifyMotion(result);
    t.diagnostic(`jitter-only ratio ${ratio}: speed ${result.speed.toFixed(2)}, R ${result.consistency.toFixed(3)}, shake ${result.shake.toFixed(2)}, |mean| ${Math.hypot(result.meanDx, result.meanDy).toFixed(3)} -> ${motion}; ${fmtTiming(timing)}`);
    assert.ok(motion === 'still' || motion === 'shaky', `got ${motion}`);
    assert.notEqual(motion, 'flowing');
    assert.ok(Math.hypot(result.meanDx, result.meanDy) < 0.1, 'jitter cancels in the mean vector');
    assert.ok(result.consistency < FLOW.minConsistency);
  }
  // Violent shake at the analysis rate of 15 fps trips the shake score.
  const violent = makeClip({
    width: W, height: H, frames: PAIRS + 1, angleDeg: 0, speed: 0, noise: 2, seed: 23,
    jitter: { amplitude: 3, frequency: 2, fps: 15, ratio: 1 },
  });
  const { result } = runClip(violent);
  assert.ok(result.shakeRel > FLOW.maxShakeRel, `shakeRel ${result.shakeRel}`);
  assert.equal(classifyMotion(result), 'shaky');
});

test('sub-pixel flow of 0.4 px/frame -> angle within 12 degrees', (t) => {
  let seed = 300;
  for (const angle of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const clip = makeClip({ width: W, height: H, frames: PAIRS + 1, angleDeg: angle, speed: 0.4, jitter: JITTER, noise: 2, seed: seed++ });
    const { result, timing } = runClip(clip);
    const err = angleDiff(result.angleDeg, angle);
    t.diagnostic(`sub-pixel angle ${angle}: est ${result.angleDeg.toFixed(1)} (err ${err.toFixed(1)}), speed ${result.speed.toFixed(2)}, R ${result.consistency.toFixed(2)}; ${fmtTiming(timing)}`);
    assert.ok(Math.abs(err) < 12, `angle ${angle}: estimated ${result.angleDeg} (error ${err.toFixed(1)})`);
  }
  // and without jitter the slow flow is still recognised as flowing
  const calm = makeClip({ width: W, height: H, frames: PAIRS + 1, angleDeg: 30, speed: 0.4, noise: 2, seed: 400 });
  const { result } = runClip(calm);
  t.diagnostic(`sub-pixel no jitter: est ${result.angleDeg.toFixed(1)}, speed ${result.speed.toFixed(2)}, R ${result.consistency.toFixed(2)} -> ${classifyMotion(result)}`);
  assert.ok(Math.abs(angleDiff(result.angleDeg, 30)) < 12);
  assert.equal(classifyMotion(result), 'flowing');
});

// ---------------------------------------------------------------------------
// FlowAccumulator and classifyMotion on hand-made inputs

test('vectorAngleDeg: 0 = up, clockwise positive', () => {
  assert.equal(vectorAngleDeg(0, -1), 0);
  assert.equal(vectorAngleDeg(1, 0), 90);
  assert.equal(vectorAngleDeg(0, 1), 180);
  assert.equal(vectorAngleDeg(-1, 0), 270);
  assert.ok(Math.abs(vectorAngleDeg(1, -1) - 45) < 1e-9);
});

test('FlowAccumulator: circular statistics on known vectors', () => {
  const acc = new FlowAccumulator();
  assert.equal(acc.frames, 0);
  assert.deepEqual(acc.result(), { angleDeg: null, speed: 0, consistency: 0, coverage: 0, shake: 0, shakeRel: 0, frames: 0, meanDx: 0, meanDy: 0 });

  acc.add({ dx: 1, dy: 0, accepted: 50, total: 100 }); // right
  acc.add({ dx: 0, dy: -1, accepted: 100, total: 100 }); // up
  acc.add({ dx: NaN, dy: NaN, accepted: 0, total: 100 }); // coverage only
  assert.equal(acc.frames, 3);
  const r = acc.result();
  assert.equal(r.frames, 3);
  assert.ok(Math.abs(r.coverage - 0.5) < 1e-12);
  assert.ok(Math.abs(r.meanDx - 0.5) < 1e-12 && Math.abs(r.meanDy + 0.5) < 1e-12);
  assert.ok(Math.abs(r.angleDeg - 45) < 1e-9);
  assert.ok(Math.abs(r.speed - 1) < 1e-12);
  assert.ok(Math.abs(r.consistency - Math.SQRT1_2) < 1e-12); // two unit vectors 90 degrees apart
  assert.ok(Math.abs(r.shake - 0.5) < 1e-12); // each vector is sqrt(0.5) from the mean

  acc.reset();
  assert.equal(acc.frames, 0);
  assert.equal(acc.result().angleDeg, null);

  // opposite vectors: no direction, zero consistency
  acc.add({ dx: 2, dy: 0, accepted: 10, total: 10 });
  acc.add({ dx: -2, dy: 0, accepted: 10, total: 10 });
  const o = acc.result();
  assert.equal(o.angleDeg, null);
  assert.ok(o.consistency < 1e-12);
  assert.equal(o.speed, 2);
  assert.equal(o.shake, 4);

  // thresholds are overridable
  assert.equal(new FlowAccumulator({ minSpeed: 9 }).opts.minSpeed, 9);
  assert.equal(new FlowAccumulator().opts.minSpeed, FLOW.minSpeed);
});

test('classifyMotion: each outcome and its precedence', () => {
  const base = { angleDeg: 90, speed: 2, consistency: 0.9, coverage: 0.8, shake: 0.2, frames: 60 };
  assert.equal(classifyMotion(base), 'flowing');
  assert.equal(classifyMotion({ ...base, frames: 9 }), 'insufficient');
  assert.equal(classifyMotion({ ...base, frames: 10 }), 'flowing');
  assert.equal(classifyMotion({ ...base, coverage: FLOW.minCoverage - 0.01 }), 'no_texture');
  assert.equal(classifyMotion({ ...base, shakeRel: FLOW.maxShakeRel + 0.1 }), 'shaky');
  assert.equal(classifyMotion({ ...base, speed: FLOW.minSpeed - 0.01 }), 'still');
  assert.equal(classifyMotion({ ...base, consistency: FLOW.minConsistency - 0.01 }), 'still');
  assert.equal(classifyMotion({ ...base, angleDeg: null, speed: 0, consistency: 0 }), 'still');
  // precedence: insufficient beats no_texture beats still (no motion) beats shaky beats still (no direction)
  assert.equal(classifyMotion({ ...base, frames: 2, coverage: 0, shake: 9, speed: 0 }), 'insufficient');
  assert.equal(classifyMotion({ ...base, coverage: 0, shake: 9, speed: 0 }), 'no_texture');
  assert.equal(classifyMotion({ ...base, shake: 9, speed: 0 }), 'still');
  assert.equal(classifyMotion({ ...base, shake: 9, speed: 3, consistency: 0.1 }), 'shaky');
  // custom thresholds, partial objects allowed
  assert.equal(classifyMotion(base, { minSpeed: 3 }), 'still');
  assert.equal(classifyMotion(base, { maxShakeRel: 0.01 }), 'shaky');
  assert.equal(classifyMotion(null), 'insufficient');
  assert.equal(classifyMotion(undefined), 'insufficient');
});

test('imageAngleToBearing: (screenUpHeading + angle) mod 360', () => {
  assert.equal(imageAngleToBearing(0, 0), 0);
  assert.equal(imageAngleToBearing(20, 350), 10);
  assert.equal(imageAngleToBearing(90, 45), 135);
  assert.equal(imageAngleToBearing(180, 270), 90);
  assert.equal(imageAngleToBearing(359.5, 0.5), 0);
  assert.equal(imageAngleToBearing(null, 100), null);
  assert.equal(imageAngleToBearing(100, null), null);
  assert.equal(imageAngleToBearing(NaN, 100), null);
});

// ---------------------------------------------------------------------------
// Optional: the y4m fixtures written by scripts/make-test-video.py, downscaled
// the way the app does it (box filter to ANALYSIS_WIDTH). Skipped when the
// fixtures (gitignored) have not been generated.

/** Parse a YUV4MPEG2 I420 file into gray frames downscaled to targetWidth. */
function readY4mGray(path, targetWidth) {
  const buf = readFileSync(path);
  const nl = buf.indexOf(0x0a);
  const header = buf.toString('latin1', 0, nl).split(' ');
  assert.equal(header[0], 'YUV4MPEG2');
  const width = Number(header.find((h) => h[0] === 'W').slice(1));
  const height = Number(header.find((h) => h[0] === 'H').slice(1));
  const [fnum, fden] = header.find((h) => h[0] === 'F').slice(1).split(':').map(Number);
  const scale = width / targetWidth;
  assert.ok(Number.isInteger(scale), 'frame width must be a multiple of the analysis width');
  const tw = targetWidth;
  const th = height / scale;
  const frameBytes = (width * height * 3) / 2;
  const frames = [];
  let pos = nl + 1;
  while (pos < buf.length) {
    const end = buf.indexOf(0x0a, pos);
    assert.equal(buf.toString('latin1', pos, pos + 5), 'FRAME');
    pos = end + 1;
    const y = buf.subarray(pos, pos + width * height);
    const out = new Uint8ClampedArray(tw * th);
    for (let oy = 0; oy < th; oy++) {
      for (let ox = 0; ox < tw; ox++) {
        let sum = 0;
        for (let j = 0; j < scale; j++) {
          const row = (oy * scale + j) * width + ox * scale;
          for (let i = 0; i < scale; i++) sum += y[row + i];
        }
        out[oy * tw + ox] = sum / (scale * scale);
      }
    }
    frames.push(out);
    pos += frameBytes;
  }
  return { width: tw, height: th, frames, fps: fnum / fden, sourceWidth: width, sourceHeight: height };
}

/** Pairs (k, k+1 mod n) starting at `start`, so a window crossing the loop seam can be tested. */
function runY4m(clip, start, pairs) {
  const acc = new FlowAccumulator();
  const times = [];
  const n = clip.frames.length;
  for (let p = 0; p < pairs; p++) {
    const a = (start + p) % n;
    const b = (start + p + 1) % n;
    const t0 = performance.now();
    acc.add(estimateFlow(clip.frames[a], clip.frames[b], clip.width, clip.height));
    times.push(performance.now() - t0);
  }
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  return { result: acc.result(), meanMs: mean };
}

const fixtures = [
  { file: 'flow-ne.y4m', angle: 45, motion: 'flowing' },
  { file: 'flow-s.y4m', angle: 180, motion: 'flowing' },
  { file: 'still.y4m', angle: null, motion: 'still' },
  { file: 'blank.y4m', angle: null, motion: 'no_texture' },
];

for (const fx of fixtures) {
  const path = join(VIDEO_DIR, fx.file);
  test(`y4m fixture ${fx.file} -> ${fx.motion}`, { skip: existsSync(path) ? false : 'fixture not generated (python3 scripts/make-test-video.py)' }, (t) => {
    const clip = readY4mGray(path, ANALYSIS_WIDTH);
    assert.equal(clip.sourceWidth, 640);
    assert.equal(clip.sourceHeight, 480);
    assert.equal(clip.width, 160);
    assert.equal(clip.height, 120);
    assert.ok(clip.frames.length >= PAIRS + 1, `only ${clip.frames.length} frames`);
    // 4 s at the clip's frame rate, placed so the window crosses the loop seam.
    const pairs = Math.min(PAIRS, Math.round(4 * clip.fps));
    const start = clip.frames.length - Math.floor(pairs / 2);
    const { result, meanMs } = runY4m(clip, start, pairs);
    const motion = classifyMotion(result);
    t.diagnostic(`${fx.file}: ${clip.frames.length} frames @ ${clip.fps} fps; est ${result.angleDeg == null ? 'null' : result.angleDeg.toFixed(1)}, speed ${result.speed.toFixed(2)}, R ${result.consistency.toFixed(2)}, cov ${result.coverage.toFixed(2)}, shake ${result.shake.toFixed(2)} -> ${motion}; ${meanMs.toFixed(2)} ms/pair`);
    assert.equal(motion, fx.motion);
    if (fx.angle != null) {
      const err = angleDiff(result.angleDeg, fx.angle);
      assert.ok(Math.abs(err) < 8, `${fx.file}: estimated ${result.angleDeg} (error ${err.toFixed(1)})`);
      assert.ok(result.consistency > 0.7, `consistency ${result.consistency}`);
    }
  });
}
