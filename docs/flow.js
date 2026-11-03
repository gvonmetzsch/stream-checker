// docs/flow.js — block-matching optical flow for Stream Checker.
//
// Pure functions over grayscale frames (Uint8ClampedArray, row-major, one byte
// per pixel). No DOM, no allocations in the per-block hot loop, importable from
// Node for the tests in tests/flow.test.mjs.
//
// One frame pair (prev -> curr) is processed like this:
//
//   1. Lay a grid of `block` x `block` windows over `prev`, `stride` px apart,
//      inset by `range` so that every candidate match lies inside `curr`.
//   2. Texture gate: skip windows whose intensity variance is below
//      `minVariance`. Flat water, glare and sky cannot be matched.
//   3. Full search: for every integer displacement in [-range, range]^2 compute
//      the sum of absolute differences (SAD) between the prev window and the
//      shifted curr window. Integer arithmetic on typed arrays.
//   4. Ambiguity gate: the best SAD must be clearly below the median SAD of the
//      search. Sensor noise, or a window whose real motion is outside the
//      search range, gives a flat cost surface and is dropped.
//   5. Parabolic sub-pixel refinement of the minimum along x and then y.
//   6. The pair's vector is the median dx and the median dy over accepted
//      windows, which ignores outliers such as a leaf or a reflection.
//
// Coordinates follow the image: x to the right, y down. The accumulator turns
// vectors into a screen angle (0 = up the screen, clockwise positive), which
// app.js converts to a compass bearing with imageAngleToBearing().

import { FLOW } from './config.js';

/**
 * A block is accepted only when its best SAD is at most this fraction of the
 * median SAD over the whole search. Measured on the synthetic textures
 * (contrast 20-36 levels, noise 2-3): a true match passes 91-100% of the time,
 * a block whose content moved beyond the search range passes 10-21%, and pure
 * sensor noise never does. 0.6 would admit a third of the decorrelated blocks,
 * 0.4 starts dropping true matches on smooth water. A "second distinct
 * minimum" test was tried too and rejects decorrelated blocks better, but it
 * also throws away most true matches on smooth textures, whose cost surface is
 * a wide bowl inside a +/-6 px search.
 */
export const AMBIGUITY_RATIO = 0.5;

/**
 * Rec. 601 luma from an RGBA ImageData-like object {data, width, height}.
 * Integer weights 77/150/29 sum to 256, so (77R + 150G + 29B + 128) >> 8 is
 * 0.301R + 0.586G + 0.113B rounded, within one level of the exact 0.299/0.587/0.114.
 * @returns {Uint8ClampedArray} width*height gray values
 */
export function toGray(imageData) {
  const { data, width, height } = imageData;
  const n = width * height;
  if (!data || data.length < n * 4) {
    throw new RangeError(`toGray: need ${n * 4} RGBA bytes, got ${data ? data.length : 0}`);
  }
  const out = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[i] = (77 * data[p] + 150 * data[p + 1] + 29 * data[p + 2] + 128) >> 8;
  }
  return out;
}

/**
 * Where the matching windows sit. Windows are inset by `range` so the whole
 * search stays inside the frame, and the leftover margin is split evenly so
 * the grid is centred (handy for the overlay).
 * @returns {{x0:number, y0:number, nx:number, ny:number}} first window origin and counts
 */
export function blockGrid(width, height, block = FLOW.block, stride = FLOW.stride, range = FLOW.range) {
  const spanX = width - block - 2 * range;
  const spanY = height - block - 2 * range;
  if (spanX < 0 || spanY < 0 || block <= 0 || stride <= 0) return { x0: 0, y0: 0, nx: 0, ny: 0 };
  const nx = Math.floor(spanX / stride) + 1;
  const ny = Math.floor(spanY / stride) + 1;
  const x0 = range + Math.floor((spanX - (nx - 1) * stride) / 2);
  const y0 = range + Math.floor((spanY - (ny - 1) * stride) / 2);
  return { x0, y0, nx, ny };
}

// Scratch buffers reused across calls (JS is single threaded per module
// instance, and estimateFlow is not re-entrant). Reallocated only when the
// search size or the block count changes.
let scratch = null;
function getScratch(nSearch, nBlocks) {
  if (!scratch || scratch.nSearch !== nSearch || scratch.nBlocks < nBlocks) {
    scratch = {
      nSearch,
      nBlocks,
      sads: new Int32Array(nSearch),     // SAD for every displacement of the current block
      sorted: new Int32Array(nSearch),   // copy of sads for the median (quickselect)
      dxs: new Float64Array(nBlocks),    // accepted per-block vectors
      dys: new Float64Array(nBlocks),
      tmp: new Float64Array(nBlocks),    // copy for the median
    };
  }
  return scratch;
}

/**
 * k-th smallest element of a[0..n) by in-place quickselect (Hoare partition).
 * Faster than sorting 169 values 234 times per frame pair, and allocation free.
 */
function nthElement(a, n, k) {
  let lo = 0;
  let hi = n - 1;
  while (hi > lo) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i]; a[i] = a[j]; a[j] = t;
        i++; j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}

/** Median of values[0..n) using `tmp` as scratch (values untouched). */
function medianOf(values, n, tmp) {
  tmp.set(values.subarray(0, n));
  const mid = n >> 1;
  const upper = nthElement(tmp, n, mid);
  if (n & 1) return upper;
  // Even count: the lower middle is the max of the left partition.
  let lower = -Infinity;
  for (let i = 0; i < mid; i++) if (tmp[i] > lower) lower = tmp[i];
  return 0.5 * (lower + upper);
}

/**
 * Parabolic sub-pixel offset of a minimum given the costs one step either side.
 * Fits s(t) = a t^2 + b t + c through (-1, sm), (0, s0), (1, sp) and returns the
 * vertex, clamped to [-0.5, 0.5]. With s0 the minimum the curvature is >= 0;
 * a flat triple (all equal) yields 0.
 */
function parabolicOffset(sm, s0, sp) {
  const denom = sm - 2 * s0 + sp;
  if (denom <= 0) return 0;
  const off = (sm - sp) / (2 * denom);
  return off < -0.5 ? -0.5 : off > 0.5 ? 0.5 : off;
}

/**
 * Estimate the global translation between two grayscale frames.
 *
 * @param {Uint8ClampedArray|Uint8Array} prev  earlier frame, width*height bytes
 * @param {Uint8ClampedArray|Uint8Array} curr  later frame, same size
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]  { block, stride, range, minVariance, returnVectors }
 *   defaults from config.FLOW; `ambiguityRatio` (default AMBIGUITY_RATIO) may also be given.
 * @returns {{dx:number, dy:number, accepted:number, total:number, vectors:Array|null}}
 *   dx, dy: median displacement of accepted blocks in px per pair (x right, y down),
 *   NaN when accepted === 0. vectors: [{x, y, dx, dy}] block centres and vectors
 *   when opts.returnVectors, else null.
 */
export function estimateFlow(prev, curr, width, height, opts = {}) {
  const block = opts.block ?? FLOW.block;
  const stride = opts.stride ?? FLOW.stride;
  const range = opts.range ?? FLOW.range;
  const minVariance = opts.minVariance ?? FLOW.minVariance;
  const ambiguityRatio = opts.ambiguityRatio ?? AMBIGUITY_RATIO;
  const returnVectors = Boolean(opts.returnVectors);

  const n = width * height;
  if (!prev || !curr || prev.length < n || curr.length < n) {
    throw new RangeError(`estimateFlow: frames must hold ${n} pixels (got ${prev && prev.length}, ${curr && curr.length})`);
  }
  // V8 keeps the hot loop fast only while the element accesses stay
  // monomorphic, so every frame goes in as a Uint8ClampedArray (toGray and the
  // canvas both produce one; anything else is copied, which costs microseconds).
  if (!(prev instanceof Uint8ClampedArray)) prev = Uint8ClampedArray.from(prev);
  if (!(curr instanceof Uint8ClampedArray)) curr = Uint8ClampedArray.from(curr);

  const { x0, y0, nx, ny } = blockGrid(width, height, block, stride, range);
  const span = 2 * range + 1;
  const nSearch = span * span;
  const S = getScratch(nSearch, nx * ny);
  const { sads, sorted, dxs, dys } = S;
  const vectors = returnVectors ? [] : null;
  const pixels = block * block;
  const half = block / 2;

  let total = 0;
  let accepted = 0;

  for (let row = 0; row < ny; row++) {
    const by = y0 + row * stride;
    for (let col = 0; col < nx; col++) {
      const bx = x0 + col * stride;
      const base = by * width + bx;
      total++;

      // --- 2. texture gate: population variance of the prev window ---
      let sum = 0;
      let sumSq = 0;
      for (let j = 0, p = base; j < block; j++, p += width) {
        for (let i = 0; i < block; i++) {
          const v = prev[p + i];
          sum += v;
          sumSq += v * v;
        }
      }
      const variance = (sumSq - (sum * sum) / pixels) / pixels;
      if (variance < minVariance) continue;

      // --- 3. full search over every integer displacement ---
      // Four horizontal displacements are scored per pass over the window: each
      // prev pixel is loaded once for four candidates, and the four independent
      // sums keep the CPU busy. Math.abs beats a ternary here because V8 turns
      // it into a branch-free instruction. Measured on 160x120: ~7 ms per pair
      // against ~26 ms for the plain one-displacement loop.
      let best = 0x7fffffff;
      let bestK = 0;
      let k = 0;
      for (let ddy = -range; ddy <= range; ddy++) {
        let ddx = -range;
        for (; ddx + 3 <= range; ddx += 4) {
          let s0 = 0;
          let s1 = 0;
          let s2 = 0;
          let s3 = 0;
          let p = base;
          let c = base + ddy * width + ddx;
          for (let j = 0; j < block; j++) {
            for (let i = 0; i < block; i++) {
              const pv = prev[p + i];
              const ci = c + i;
              s0 += Math.abs(pv - curr[ci]);
              s1 += Math.abs(pv - curr[ci + 1]);
              s2 += Math.abs(pv - curr[ci + 2]);
              s3 += Math.abs(pv - curr[ci + 3]);
            }
            p += width;
            c += width;
          }
          sads[k] = s0;
          sads[k + 1] = s1;
          sads[k + 2] = s2;
          sads[k + 3] = s3;
          if (s0 < best) { best = s0; bestK = k; }
          if (s1 < best) { best = s1; bestK = k + 1; }
          if (s2 < best) { best = s2; bestK = k + 2; }
          if (s3 < best) { best = s3; bestK = k + 3; }
          k += 4;
        }
        for (; ddx <= range; ddx++) {
          // Remainder when the search width is not a multiple of four.
          let sad = 0;
          let p = base;
          let c = base + ddy * width + ddx;
          for (let j = 0; j < block; j++) {
            for (let i = 0; i < block; i++) sad += Math.abs(prev[p + i] - curr[c + i]);
            p += width;
            c += width;
          }
          sads[k] = sad;
          if (sad < best) { best = sad; bestK = k; }
          k++;
        }
      }

      // --- 4. ambiguity gate against the median SAD of the search ---
      sorted.set(sads);
      const median = nthElement(sorted, nSearch, nSearch >> 1);
      if (!(best <= ambiguityRatio * median)) continue;

      // --- 5. parabolic sub-pixel refinement along x, then y ---
      const kx = bestK % span;
      const ky = (bestK - kx) / span;
      let dx = kx - range;
      let dy = ky - range;
      if (kx > 0 && kx < span - 1) {
        dx += parabolicOffset(sads[bestK - 1], best, sads[bestK + 1]);
      }
      if (ky > 0 && ky < span - 1) {
        dy += parabolicOffset(sads[bestK - span], best, sads[bestK + span]);
      }

      dxs[accepted] = dx;
      dys[accepted] = dy;
      accepted++;
      if (vectors) vectors.push({ x: bx + half, y: by + half, dx, dy });
    }
  }

  // --- 6. median over accepted blocks ---
  const dx = accepted ? medianOf(dxs, accepted, S.tmp) : NaN;
  const dy = accepted ? medianOf(dys, accepted, S.tmp) : NaN;
  return { dx, dy, accepted, total, vectors };
}

/** Degrees in [0, 360). */
function normalizeDeg(d) {
  const r = d % 360;
  return r < 0 ? r + 360 : r;
}

/**
 * Screen angle of an image vector: 0 = up the screen (-y), clockwise positive,
 * so right (+x) = 90 and down (+y) = 180. atan2(dx, -dy) does exactly that.
 */
export function vectorAngleDeg(dx, dy) {
  return normalizeDeg((Math.atan2(dx, -dy) * 180) / Math.PI);
}

/**
 * Accumulates per-pair vectors over a capture and summarises them with
 * circular statistics.
 *
 *   angleDeg     direction of the mean vector (0 = up, clockwise), null when no
 *                accepted pairs (or a mean vector of exactly zero length)
 *   speed        mean magnitude of the accepted per-pair vectors, px/frame
 *   consistency  mean resultant length of the per-pair unit vectors, 0..1
 *   coverage     mean of accepted/total over every pair added, 0..1
 *   shake        mean squared deviation of per-pair vectors from the mean vector,
 *                px^2: an oscillating camera raises it, steady flow does not
 *   frames       pairs added, including pairs with no accepted block
 *
 * Hand tremor is oscillatory, so it cancels in the mean vector over a 4 s
 * capture while real flow accumulates; the shake score catches the violent case.
 */
export class FlowAccumulator {
  constructor(opts = {}) {
    this.opts = { ...FLOW, ...opts };
    this.reset();
  }

  reset() {
    this._frames = 0;
    this._coverageSum = 0;
    this._dx = [];
    this._dy = [];
  }

  /** Pairs added so far. */
  get frames() {
    return this._frames;
  }

  /** Add one estimateFlow() result. Pairs with accepted === 0 count toward coverage only. */
  add(result) {
    if (!result) return;
    const total = result.total > 0 ? result.total : 0;
    const accepted = result.accepted > 0 ? result.accepted : 0;
    this._frames++;
    this._coverageSum += total > 0 ? accepted / total : 0;
    if (accepted > 0 && Number.isFinite(result.dx) && Number.isFinite(result.dy)) {
      this._dx.push(result.dx);
      this._dy.push(result.dy);
    }
  }

  result() {
    const frames = this._frames;
    const n = this._dx.length;
    const coverage = frames > 0 ? this._coverageSum / frames : 0;
    if (n === 0) {
      return { angleDeg: null, speed: 0, consistency: 0, coverage, shake: 0, frames, meanDx: 0, meanDy: 0 };
    }
    let sx = 0;
    let sy = 0;
    let sumMag = 0;
    let sumSq = 0;
    let ux = 0;
    let uy = 0;
    for (let i = 0; i < n; i++) {
      const dx = this._dx[i];
      const dy = this._dy[i];
      const m = Math.hypot(dx, dy);
      sx += dx;
      sy += dy;
      sumMag += m;
      sumSq += dx * dx + dy * dy;
      if (m > 0) {
        // Unit vector; a zero-length pair has no direction and adds nothing
        // to the resultant, which lowers consistency as it should.
        ux += dx / m;
        uy += dy / m;
      }
    }
    const meanDx = sx / n;
    const meanDy = sy / n;
    const speed = sumMag / n;
    const consistency = Math.min(1, Math.hypot(ux, uy) / n);
    // Var(v) = E|v|^2 - |E v|^2, clamped against rounding.
    const shake = Math.max(0, sumSq / n - (meanDx * meanDx + meanDy * meanDy));
    const angleDeg = meanDx === 0 && meanDy === 0 ? null : vectorAngleDeg(meanDx, meanDy);
    return { angleDeg, speed, consistency, coverage, shake, frames, meanDx, meanDy };
  }
}

/**
 * Turn an accumulator result into one of
 * 'flowing' | 'still' | 'no_texture' | 'shaky' | 'insufficient', checked in
 * that order of precedence (insufficient first). Thresholds default to
 * config.FLOW; a partial object overrides individual values.
 */
export function classifyMotion(result, thresholds = FLOW) {
  const t = { ...FLOW, ...thresholds };
  if (!result || !(result.frames >= 10)) return 'insufficient';
  if (!(result.coverage >= t.minCoverage)) return 'no_texture';
  if (result.shake > t.maxShake) return 'shaky';
  if (result.angleDeg == null || !(result.speed >= t.minSpeed) || !(result.consistency >= t.minConsistency)) {
    return 'still';
  }
  return 'flowing';
}

/**
 * Compass bearing of a screen angle: (screenUpHeading + angleDeg) mod 360.
 * screenUpHeading is the heading of "up" on the screen (device top edge
 * corrected by screen.orientation.angle). Returns null when either input is
 * missing, so a lost compass propagates as null rather than NaN.
 */
export function imageAngleToBearing(angleDeg, screenUpHeading) {
  if (!Number.isFinite(angleDeg) || !Number.isFinite(screenUpHeading)) return null;
  return normalizeDeg(screenUpHeading + angleDeg);
}
