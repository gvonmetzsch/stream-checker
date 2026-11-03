// Demo mode: a synthetic creek for desks, sofas and places with no stream.
//
// `createDemoStream()` animates a plausible water texture on a canvas and hands
// it out as a MediaStream so app.js can treat it exactly like the camera.
// `DEMO` holds the fixture location, heading and hand-written map / elevation
// responses, and `demoFetch()` serves those instead of the network.
//
// Geometry note: the mapped creek is laid out so that its node-order bearing at
// the segment nearest DEMO.location equals the true bearing the demo water
// shows on screen:
//   true bearing = DEMO.headingMag + declination(DEMO.location) + DEMO.angleDeg
//                = 32 + (-13.57) + 30 = 48.4 degrees (NE)
// The declination is the WMM2025 value at the fixture location for late 2026;
// it drifts by less than 0.2 degrees over the model's five-year life, far
// inside the 60 degree RIGHT DIRECTION tolerance. The on-screen angle is kept
// well away from the vertical axis because block matching pixel-locks the
// small sideways component of near-vertical motion (14 degrees reads as 8).

import { OVERPASS_HOSTS, ELEVATION_URL } from './config.js';

const DEMO_LOCATION = { lat: 44.1735, lon: -72.912, accuracy: 9 };

// Demo Creek: waterway=stream, drawn downstream (OSM convention). The straight
// reach through the nearest point (14 m to the user's left) runs at 48.43
// degrees; the bends up- and downstream make it look like a creek rather than
// a ruler.
const CREEK_GEOMETRY = [
  { lat: 44.1722621, lon: -72.9146012 },
  { lat: 44.1727329, lon: -72.9136833 },
  { lat: 44.1732394, lon: -72.9131621 },
  { lat: 44.1733555, lon: -72.9124917 },
  { lat: 44.1738329, lon: -72.9117413 },
  { lat: 44.1743161, lon: -72.9114064 },
  { lat: 44.1745858, lon: -72.9105444 },
  { lat: 44.1752026, lon: -72.909466 },
];

export const DEMO = {
  location: DEMO_LOCATION,
  // Magnetic heading of "screen up" while filming; portrait phone, tilted down.
  headingMag: 32,
  screenAngle: 0,
  // Water moves up the screen and to the right (0 = up, clockwise).
  angleDeg: 30,
  // Pixels per captured frame at 30 fps, measured on the 640 px wide canvas.
  speed: 2.2,
  overpass: {
    version: 0.6,
    generator: 'Overpass API 0.7.62.7 (Stream Checker demo fixture)',
    osm3s: {
      timestamp_osm_base: '2026-11-02T08:15:04Z',
      copyright: 'The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.',
    },
    elements: [
      {
        type: 'way',
        id: 990000001,
        bounds: { minlat: 44.1722621, minlon: -72.9146012, maxlat: 44.1752026, maxlon: -72.909466 },
        nodes: [9900000001, 9900000002, 9900000003, 9900000004, 9900000005, 9900000006, 9900000007, 9900000008],
        geometry: CREEK_GEOMETRY,
        tags: {
          waterway: 'stream',
          name: 'Demo Creek',
          intermittent: 'no',
          width: '2',
          note: 'Fictional. Exists only inside Stream Checker.',
        },
      },
    ],
  },
  // Open-Meteo elevation for seven samples laid along the measured bearing,
  // ordered from 600 m behind the position to 600 m ahead: the ground drops
  // along the flow, as it should.
  elevation: { elevation: [621.4, 617.9, 616.2, 614.8, 613.1, 611.2, 607.6] },
};

/** Velocity in canvas pixels per second for a screen angle (0 = up, clockwise). */
export function velocityFor(angleDeg, speedPxPerFrame, fps = 30) {
  const a = (angleDeg * Math.PI) / 180;
  return { vx: Math.sin(a) * speedPxPerFrame * fps, vy: -Math.cos(a) * speedPxPerFrame * fps };
}

export function isOverpassUrl(url) {
  return OVERPASS_HOSTS.some((h) => url.startsWith(h)) || /overpass|\/api\/interpreter/i.test(url);
}

export function isElevationUrl(url) {
  return url.startsWith(ELEVATION_URL) || /open-meteo\.com/i.test(url);
}

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Wrap a fetch so Overpass and Open-Meteo requests are answered from the
 * fixtures (with a short, realistic delay). Anything else, including the
 * optional Claude scene check, passes through to `realFetch`.
 */
export function demoFetch(realFetch, { delayMs = 120 } = {}) {
  return async function fetchImpl(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (isOverpassUrl(url) || isElevationUrl(url)) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return jsonResponse(isOverpassUrl(url) ? DEMO.overpass : DEMO.elevation);
    }
    return realFetch(input, init);
  };
}

// ---------------------------------------------------------------------------
// Synthetic water

/** Small deterministic PRNG so the demo looks the same every time. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Tileable value noise, several octaves, returned as a Float32Array in 0..1.
 * The lattice wraps at `size`, so the tile can be scrolled seamlessly.
 */
export function makeNoise(size, seed, octaves = [[32, 1], [16, 0.5], [8, 0.3]]) {
  const rand = mulberry32(seed);
  const out = new Float32Array(size * size);
  let total = 0;
  for (const [spacing, amp] of octaves) {
    const cells = Math.max(1, Math.round(size / spacing));
    const lattice = new Float32Array(cells * cells);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
    const step = size / cells;
    for (let y = 0; y < size; y++) {
      const gy = y / step;
      const y0 = Math.floor(gy) % cells;
      const y1 = (y0 + 1) % cells;
      const ty = smooth(gy - Math.floor(gy));
      for (let x = 0; x < size; x++) {
        const gx = x / step;
        const x0 = Math.floor(gx) % cells;
        const x1 = (x0 + 1) % cells;
        const tx = smooth(gx - Math.floor(gx));
        const a = lattice[y0 * cells + x0];
        const b = lattice[y0 * cells + x1];
        const c = lattice[y1 * cells + x0];
        const d = lattice[y1 * cells + x1];
        const v = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
        out[y * size + x] += v * amp;
      }
    }
    total += amp;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

/** Paint a noise field as a tinted RGBA tile on a fresh canvas. */
function noiseTile(size, seed, tint) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const noise = makeNoise(size, seed);
  for (let i = 0; i < noise.length; i++) {
    // Contrast curve so the texture has crisp ridges and troughs.
    const v = Math.min(1, Math.max(0, (noise[i] - 0.5) * 2.2 + 0.5));
    img.data[i * 4] = tint.r0 + (tint.r1 - tint.r0) * v;
    img.data[i * 4 + 1] = tint.g0 + (tint.g1 - tint.g0) * v;
    img.data[i * 4 + 2] = tint.b0 + (tint.b1 - tint.b0) * v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Animated flowing water on a canvas, captured as a MediaStream.
 * Browser only. Returns { stream, stop(), canvas }.
 */
export function createDemoStream({ angleDeg = DEMO.angleDeg, speed = DEMO.speed, width = 640, height = 480 } = {}) {
  if (typeof document === 'undefined') throw new Error('createDemoStream needs a browser');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const TILE = 256;
  // Two scrolling layers: the main water texture and a fainter, slightly
  // slower shimmer that breaks up the tiling. Both move with the flow.
  const tileA = noiseTile(TILE, 7, { r0: 22, g0: 72, b0: 84, r1: 118, g1: 182, b1: 190 });
  const tileB = noiseTile(TILE, 23, { r0: 10, g0: 50, b0: 62, r1: 150, g1: 205, b1: 208 });
  const patA = ctx.createPattern(tileA, 'repeat');
  const patB = ctx.createPattern(tileB, 'repeat');
  const { vx, vy } = velocityFor(angleDeg, speed);

  const rand = mulberry32(99);
  const GLINTS = 48;
  const glints = [];
  for (let i = 0; i < GLINTS; i++) {
    glints.push({ x: rand() * width, y: rand() * height, phase: rand() * Math.PI * 2, f: 2 + rand() * 4, r: 1.5 + rand() * 2.5 });
  }

  let ox = 0;
  let oy = 0;
  let last = null;
  let raf = 0;
  let running = true;

  function wrap(v, m) {
    return ((v % m) + m) % m;
  }

  function draw(now) {
    if (!running) return;
    const dt = last == null ? 1 / 30 : Math.min(0.1, (now - last) / 1000);
    last = now;
    ox += vx * dt;
    oy += vy * dt;
    const t = now / 1000;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#1b4f5a';
    ctx.fillRect(0, 0, width, height);

    // Layer A: the texture itself.
    ctx.save();
    ctx.translate(wrap(ox, TILE), wrap(oy, TILE));
    ctx.fillStyle = patA;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(-TILE, -TILE, width + 2 * TILE, height + 2 * TILE);
    ctx.restore();

    // Layer B: shimmer, 85 % of the speed plus a gentle sideways sway.
    ctx.save();
    const sway = Math.sin(t * 0.7) * 6;
    ctx.translate(wrap(ox * 0.85 + sway, TILE), wrap(oy * 0.85, TILE));
    ctx.fillStyle = patB;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(-TILE, -TILE, width + 2 * TILE, height + 2 * TILE);
    ctx.restore();

    // Glints ride the flow and flicker.
    for (const g of glints) {
      g.x = wrap(g.x + vx * dt, width);
      g.y = wrap(g.y + vy * dt, height);
      const a = 0.25 + 0.75 * Math.abs(Math.sin(t * g.f + g.phase));
      ctx.globalAlpha = a * 0.85;
      ctx.fillStyle = '#e9fbff';
      ctx.beginPath();
      ctx.ellipse(g.x, g.y, g.r * 2.2, g.r, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Soft vignette so the frame reads as a photograph, not a texture swatch.
    const grad = ctx.createRadialGradient(width / 2, height / 2, height * 0.35, width / 2, height / 2, height * 0.95);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,10,14,0.35)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    raf = requestAnimationFrame(draw);
  }
  raf = requestAnimationFrame(draw);

  const stream = canvas.captureStream(30);
  return {
    stream,
    canvas,
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      for (const track of stream.getTracks()) track.stop();
    },
  };
}
