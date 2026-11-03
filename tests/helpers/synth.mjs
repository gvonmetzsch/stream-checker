// tests/helpers/synth.mjs — deterministic synthetic "water" clips for the
// optical-flow tests. scripts/make-test-video.py renders the same recipe with
// numpy for the Chromium fake camera.
//
// Recipe
//   * A periodic tile of layered value noise (four octaves, quintic smoothing)
//     normalised to a chosen contrast, plus sparse bright "glints".
//   * Each frame samples that tile bilinearly at (x - ox, y - oy), where
//     (ox, oy) is the accumulated image translation. Because the tile wraps,
//     any translation, including sub-pixel ones, is exact up to interpolation.
//   * The translation per frame is the flow velocity plus an optional
//     elliptical camera jitter, and each frame gets its own Gaussian noise.
//
// Conventions match docs/flow.js: x right, y down; a flow angle of 0 means the
// texture moves up the screen, 90 means to the right.

/** mulberry32: tiny seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample via Box-Muller (one of the pair is enough here). */
export function randn(rng) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Quintic smoothstep 6t^5 - 15t^4 + 10t^3: C2-continuous lattice interpolation. */
function smooth(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * One octave of tiling value noise: a `cells` x `cells` lattice of random
 * values interpolated over a `size` x `size` tile that wraps at its edges.
 * Values are in [0, 1).
 */
export function valueNoiseTile(size, cells, rng) {
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
  const out = new Float32Array(size * size);
  const scale = cells / size;
  for (let y = 0; y < size; y++) {
    const cy = y * scale;
    const j0 = Math.floor(cy);
    const fy = smooth(cy - j0);
    const r0 = (j0 % cells) * cells;
    const r1 = ((j0 + 1) % cells) * cells;
    for (let x = 0; x < size; x++) {
      const cx = x * scale;
      const i0 = Math.floor(cx);
      const fx = smooth(cx - i0);
      const c0 = i0 % cells;
      const c1 = (i0 + 1) % cells;
      const top = lattice[r0 + c0] + (lattice[r0 + c1] - lattice[r0 + c0]) * fx;
      const bottom = lattice[r1 + c0] + (lattice[r1 + c1] - lattice[r1 + c0]) * fx;
      out[y * size + x] = top + (bottom - top) * fy;
    }
  }
  return out;
}

/**
 * The water texture: a periodic `size` x `size` tile of gray values in [0, 255].
 *
 * @param {object} [opts]
 *   size            tile edge in px (default 256)
 *   seed            PRNG seed
 *   baseWavelength  coarsest octave wavelength in px (default 24); each further
 *                   octave halves it, so 24, 12, 6, 3 for four octaves
 *   octaves, persistence  amplitude falls by `persistence` per octave
 *   contrast        standard deviation of the result in gray levels (default 36)
 *   glints          number of bright specular spots (default 40)
 *   glintAmplitude, glintRadius  spot brightness and Gaussian radius in px
 * @returns {{size:number, data:Float32Array}}
 */
export function makeWaterTexture(opts = {}) {
  const {
    size = 256,
    seed = 1,
    baseWavelength = 24,
    octaves = 4,
    persistence = 0.5,
    contrast = 36,
    glints = 40,
    glintAmplitude = 90,
    glintRadius = 1.6,
  } = opts;
  const rng = mulberry32(seed);
  const data = new Float32Array(size * size);

  for (let k = 0; k < octaves; k++) {
    const wavelength = baseWavelength / 2 ** k;
    const cells = Math.max(1, Math.round(size / wavelength));
    const amp = persistence ** k;
    const octave = valueNoiseTile(size, cells, rng);
    for (let i = 0; i < data.length; i++) data[i] += amp * octave[i];
  }

  // Normalise to mean 128 and the requested standard deviation.
  let mean = 0;
  for (let i = 0; i < data.length; i++) mean += data[i];
  mean /= data.length;
  let variance = 0;
  for (let i = 0; i < data.length; i++) variance += (data[i] - mean) ** 2;
  const std = Math.sqrt(variance / data.length) || 1;
  for (let i = 0; i < data.length; i++) data[i] = 128 + (contrast * (data[i] - mean)) / std;

  // Glints: small Gaussian highlights that ride along with the water.
  for (let g = 0; g < glints; g++) {
    const cx = rng() * size;
    const cy = rng() * size;
    const r = glintRadius * (0.6 + 0.8 * rng());
    const a = glintAmplitude * (0.5 + rng());
    const reach = Math.ceil(3 * r);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const px = Math.floor(cx) + dx;
        const py = Math.floor(cy) + dy;
        const ddx = px + 0.5 - cx;
        const ddy = py + 0.5 - cy;
        const w = Math.exp(-(ddx * ddx + ddy * ddy) / (2 * r * r));
        const idx = (((py % size) + size) % size) * size + (((px % size) + size) % size);
        data[idx] += a * w;
      }
    }
  }

  for (let i = 0; i < data.length; i++) data[i] = Math.min(255, Math.max(0, data[i]));
  return { size, data };
}

/** Bilinear sample of a wrapping tile at continuous coordinates (x, y). */
export function sampleTile(tile, x, y) {
  const { size, data } = tile;
  x = ((x % size) + size) % size;
  y = ((y % size) + size) % size;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const x1 = (x0 + 1) % size;
  const y1 = (y0 + 1) % size;
  const r0 = y0 * size;
  const r1 = y1 * size;
  const top = data[r0 + x0] + (data[r0 + x1] - data[r0 + x0]) * fx;
  const bottom = data[r1 + x0] + (data[r1 + x1] - data[r1 + x0]) * fx;
  return top + (bottom - top) * fy;
}

/**
 * Render one width x height frame of the tile translated by (ox, oy) px
 * (the content moves right/down by ox/oy), with optional Gaussian noise.
 * @returns {Uint8ClampedArray}
 */
export function renderFrame(tile, width, height, ox, oy, noise = 0, rng = null) {
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = sampleTile(tile, x - ox, y - oy);
      if (noise > 0 && rng) v += noise * randn(rng);
      out[y * width + x] = v; // Uint8ClampedArray rounds and clamps
    }
  }
  return out;
}

/** Image-axis velocity for a screen angle (0 = up, clockwise) and speed in px/frame. */
export function velocityFromAngle(angleDeg, speed) {
  const rad = (angleDeg * Math.PI) / 180;
  return { dx: speed * Math.sin(rad), dy: -speed * Math.cos(rad) };
}

/**
 * Camera jitter offset at frame k: an ellipse traced at `frequency` Hz.
 *   x = amplitude * sin(2 pi f t + phase), y = amplitude * ratio * cos(2 pi f t + phase)
 * ratio 1 is a circle (constant jitter speed, every direction relative to the
 * flow), ratio 0 is a horizontal line.
 */
export function jitterOffset(jitter, k) {
  if (!jitter || !(jitter.amplitude > 0)) return { x: 0, y: 0 };
  const { amplitude, frequency = 2, fps = 30, phase = 0, ratio = 1 } = jitter;
  const t = (2 * Math.PI * frequency * k) / fps + phase;
  return { x: amplitude * Math.sin(t), y: amplitude * ratio * Math.cos(t) };
}

/**
 * A full clip: `frames` frames of the texture moving at `speed` px/frame in
 * direction `angleDeg`, with jitter and per-frame noise.
 *
 * @param {object} opts
 *   width, height   frame size (default 160 x 120)
 *   frames          number of frames (default 61, i.e. 60 pairs)
 *   angleDeg, speed flow direction (0 = up, clockwise) and px/frame
 *   jitter          { amplitude, frequency, fps, phase, ratio } or null
 *   noise           per-frame Gaussian noise std in gray levels (default 2)
 *   seed            PRNG seed for texture and noise
 *   texture         overrides for makeWaterTexture
 * @returns {{width, height, frames:Uint8ClampedArray[], offsets:{x,y}[], velocity:{dx,dy}, angleDeg, speed}}
 */
export function makeClip(opts = {}) {
  const {
    width = 160,
    height = 120,
    frames = 61,
    angleDeg = 0,
    speed = 0,
    jitter = null,
    noise = 2,
    seed = 1,
    texture = {},
  } = opts;
  const tile = makeWaterTexture({ seed, ...texture });
  const rng = mulberry32(seed * 7919 + 17);
  const velocity = velocityFromAngle(angleDeg, speed);
  const out = [];
  const offsets = [];
  for (let k = 0; k < frames; k++) {
    const j = jitterOffset(jitter, k);
    const ox = k * velocity.dx + j.x;
    const oy = k * velocity.dy + j.y;
    offsets.push({ x: ox, y: oy });
    out.push(renderFrame(tile, width, height, ox, oy, noise, rng));
  }
  return { width, height, frames: out, offsets, velocity, angleDeg, speed };
}

/** A flat clip: constant gray `level` plus per-frame noise (no texture at all). */
export function makeBlankClip(opts = {}) {
  const { width = 160, height = 120, frames = 61, level = 128, noise = 1, seed = 1 } = opts;
  const rng = mulberry32(seed * 31 + 5);
  const out = [];
  for (let k = 0; k < frames; k++) {
    const f = new Uint8ClampedArray(width * height);
    for (let i = 0; i < f.length; i++) f[i] = level + (noise > 0 ? noise * randn(rng) : 0);
    out.push(f);
  }
  return { width, height, frames: out, offsets: out.map(() => ({ x: 0, y: 0 })), velocity: { dx: 0, dy: 0 }, angleDeg: 0, speed: 0 };
}

/** Pure uncorrelated noise frames (passes the texture gate, should fail the ambiguity gate). */
export function makeNoiseClip(opts = {}) {
  const { width = 160, height = 120, frames = 2, level = 128, noise = 12, seed = 1 } = opts;
  return makeBlankClip({ width, height, frames, level, noise, seed });
}
