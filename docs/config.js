// Shared constants for Stream Checker. Every module imports from here so the
// numbers that define behaviour live in one place.

export const APP_NAME = 'Stream Checker';
export const APP_VERSION = '0.1.0';

// Capture and analysis
export const CAPTURE_MS = 4000;          // how long one check records
export const ANALYSIS_WIDTH = 160;       // frames are downscaled to this width (px) before optical flow
export const TARGET_FPS = 15;            // frame pairs per second fed to the flow estimator
export const STALL_MS = 3000;            // no camera frame within this -> "relaunch the app" hint

// Optical flow thresholds (tuned against the synthetic clips in tests/)
export const FLOW = {
  block: 12,        // block size in px (analysis resolution)
  stride: 8,        // grid stride in px
  range: 6,         // max displacement searched, px per frame pair
  minVariance: 40,  // texture gate: per-block intensity variance below this is ignored
  minSpeed: 0.3,    // px/frame below this counts as still water
  minConsistency: 0.5, // mean resultant length below this -> inconsistent / still
  minCoverage: 0.12,   // share of textured blocks below this -> can't see detail
  maxShakeRel: 0.6,    // variance of the per-pair vectors divided by speed^2 above this -> hold still
                       // (relative, so fast rivers with natural turbulence are not called shaky)
};

// Verdict geometry (degrees)
export const ANGLE = {
  rightMax: 60,     // |delta| <= this -> RIGHT DIRECTION
  wrongMin: 120,    // |delta| >= this -> WRONG WAY ; in between -> SIDEWAYS
};

// Map lookup radii (metres)
export const RADIUS = {
  waterway: 200,
  water: 60,
  coast: 300,
  offline: 5000,    // "Save streams near me" radius
};

export const OVERPASS_HOSTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
export const OVERPASS_TIMEOUT_MS = 12000;
export const OVERPASS_BACKOFF_MS = 30000;   // after a 429, pause map lookups this long
export const OVERPASS_STALE_MS = 3 * 24 * 3600 * 1000; // label data older than this

export const ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation';
export const TERRAIN_DISTANCES_M = [150, 300, 600];
export const TERRAIN_MIN_DROP_M = 2;  // less than this over the sampled span -> flat

// Compass
export const COMPASS = {
  pitchMin: 10,     // degrees; below this the phone is flat-ish (top-edge heading dominates)
  pitchMax: 80,     // above this the phone is upright (camera-axis heading dominates)
  minSamples: 5,
};

// Claude scene check
export const SCENE = {
  models: {
    default: 'claude-opus-5-5',
    cheap: 'claude-haiku-5-5',
  },
  maxEdge: 512,         // px, longest edge of the frame sent
  jpegQuality: 0.8,
  apiUrl: 'https://api.anthropic.com/v1/messages',
  apiVersion: '2026-10-21',
  fallbackBeta: 'server-side-fallback-2026-07-01',
  maxTokens: 1024,
  timeoutMs: 20000,
};

// localStorage / IndexedDB keys
export const STORAGE = {
  settings: 'streamchecker.settings.v1',
  history: 'streamchecker.history.v1',
  db: 'streamchecker',
  dbVersion: 1,
};

export const HISTORY_MAX = 12;
