// Stream Checker: orchestration.
//
// Owns the state machine idle -> permissions -> capturing -> analyzing ->
// judging -> verdict (-> idle), the camera plumbing, the flow overlay, the
// compass readout, settings, history, share, "Save streams near me", demo mode
// and the debug panel. Everything that touches window/document lives inside
// functions, so the pure helpers below can be imported and tested in Node.

import * as config from './config.js';
import { toGray, estimateFlow, FlowAccumulator, classifyMotion, imageAngleToBearing } from './flow.js';
import { createCompass, circularMean } from './compass.js';
import { magneticToTrue, declination } from './declination.js';
import { toCardinal, normalizeDeg } from './geo.js';
import { fetchFeatures, expectedFlow, nearbyWater, terrainSlope } from './waterways.js';
import { saveArea, cachedFeatures, savedAreas, clearSaved } from './offline.js';
import { classifyScene, frameToJpegBlob } from './scene.js';
import { decide, describeBearing } from './verdict.js';
import { DEMO, createDemoStream, demoFetch } from './demo.js';

// ---------------------------------------------------------------------------
// Constants

export const PHASES = ['idle', 'permissions', 'capturing', 'analyzing', 'judging', 'verdict', 'error'];

export const STALL_MESSAGE = 'Camera stalled. Close and reopen the app.';

const CAMERA_CONSTRAINTS = {
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } },
  audio: false,
};

const LOCATION_TIMEOUT_MS = 10000;
const MAP_WAIT_MS = 20000; // after capture, give the map lookup this long before falling back
const SCENE_WAIT_MS = 10000; // after capture, give the scene check this long
const FIRST_FRAME_MS = config.STALL_MS;
const HEADING_RING = 12; // samples used for the "jumping around" check
const JUMPY_R = 0.9; // mean resultant length below this -> calibrate hint
const SHARPNESS_MIN = 4; // mean |horizontal gradient| of 8-bit gray; first frame above this is sent to Claude
const SHARPNESS_GIVE_UP_FRAMES = 6;
const MAX_HEADING_SPREAD_R = 0.6; // window R below this -> heading unreliable

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: config.SCENE.models.default,
  sceneCheck: false,
  sideways: false,
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)

/** Validate a settings object from storage; unknown keys dropped, bad values reset. */
export function sanitizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.apiKey === 'string') out.apiKey = raw.apiKey.trim();
  const models = Object.values(config.SCENE.models);
  if (typeof raw.model === 'string' && models.includes(raw.model)) out.model = raw.model;
  out.sceneCheck = raw.sceneCheck === true;
  out.sideways = raw.sideways === true;
  return out;
}

/** Three-digit bearing, e.g. 41 -> "041". */
export function pad3(deg) {
  const d = Math.round(normalizeDeg(deg)) % 360;
  return String(d).padStart(3, '0');
}

/** "NE 041°" style readout text. */
export function formatHeading(deg) {
  if (deg == null || !Number.isFinite(deg)) return '—';
  return `${toCardinal(deg)} ${pad3(deg)}°`;
}

/**
 * Decide what the live heading readout shows.
 * status: compass permission status ('granted' | 'denied' | 'unsupported' | null while unknown)
 * recent: last few headings (degrees) for the "jumping around" check
 * waitedMs: time since the compass was started without a sample
 */
export function headingReadout(sample, { status = null, recent = [], waitedMs = 0 } = {}) {
  if (!sample || sample.headingMag == null || !Number.isFinite(sample.headingMag)) {
    // No sample yet: the permission answer and the clock decide what to say.
    if (status === 'denied' && waitedMs > 1500) return { value: '— — —', hint: 'no compass: motion access denied', kind: 'none' };
    if (status === 'unsupported' && waitedMs > 2000) return { value: '— — —', hint: 'no compass', kind: 'none' };
    if (waitedMs > 3000) return { value: '— — —', hint: 'no compass', kind: 'none' };
    return { value: '— — —', hint: 'reading compass…', kind: 'waiting' };
  }
  const value = formatHeading(sample.headingMag);
  if (sample.tiltOk === false) return { value, hint: 'tilt the phone down toward the water', kind: 'tilt' };
  let jumpy = false;
  if (recent.length >= 5) {
    const { R } = circularMean(recent);
    if (R != null && R < JUMPY_R) jumpy = true;
  }
  if (sample.accuracy != null && (sample.accuracy < 0 || sample.accuracy > 25)) jumpy = true;
  if (jumpy) return { value, hint: 'calibrate: move the phone in a figure 8', kind: 'calibrate' };
  return { value, hint: `magnetic · ${sample.source || 'sensor'}`, kind: 'ok' };
}

/** Relative age text for the map data behind a verdict. */
export function mapAgeText(map, now = Date.now()) {
  if (!map || !map.features) return 'map unavailable';
  if (map.status === 'cache') {
    const when = map.features.savedAt ? new Date(map.features.savedAt) : null;
    return when && !Number.isNaN(when.getTime())
      ? `saved map data from ${when.toLocaleDateString([], { day: 'numeric', month: 'short' })}`
      : 'saved map data';
  }
  const ts = map.features.timestamp ? Date.parse(map.features.timestamp) : NaN;
  if (Number.isNaN(ts)) return 'live map data';
  const ageMs = Math.max(0, now - ts);
  const hours = ageMs / 3600000;
  let text;
  if (hours < 1) text = 'map data current';
  else if (hours < 48) text = `map data ${Math.round(hours)} h old`;
  else text = `map data ${Math.round(hours / 24)} days old`;
  if (map.features.stale) text += ' (stale mirror)';
  return text;
}

/** Mean absolute horizontal gradient of a gray frame: cheap sharpness proxy. */
export function sharpness(gray, width, height) {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < height; y += 2) {
    const row = y * width;
    for (let x = 1; x < width; x += 2) {
      sum += Math.abs(gray[row + x] - gray[row + x - 1]);
      n++;
    }
  }
  return n ? sum / n : 0;
}

/**
 * Compass status for the verdict from the permission result and the capture
 * window. Behaviour wins over the permission answer: Chrome 151+ exposes
 * requestPermission() and may answer 'denied' while absolute orientation
 * events keep arriving, so samples in the window mean the compass works.
 */
export function compassStatusFrom(permission, win, cfg = config.COMPASS) {
  const samples = win && Number.isFinite(win.samples) ? win.samples : 0;
  const hasHeading = !!win && Number.isFinite(win.headingMag) && samples > 0;
  if (!hasHeading) {
    if (permission === 'denied') return { status: 'denied', headingMag: null, reason: 'motion access denied' };
    return { status: 'unsupported', headingMag: null, reason: 'no heading samples' };
  }
  if (win.samples < cfg.minSamples) return { status: 'unreliable', headingMag: win.headingMag, reason: `only ${win.samples} heading samples` };
  if (win.R != null && win.R < MAX_HEADING_SPREAD_R) {
    return { status: 'unreliable', headingMag: win.headingMag, reason: 'heading swung around during the capture' };
  }
  return { status: 'ok', headingMag: win.headingMag, reason: null };
}

/** The source line under the verdict card. */
export function buildSourceLine({ verdict, expected, terrain, map, mapStatus, heading }) {
  const parts = [];
  if (verdict.source === 'osm' && expected) {
    const name = expected.name || `unnamed ${expected.kind || 'waterway'}`;
    const kind = expected.kind ? `OSM ${expected.kind}` : 'OSM waterway';
    const dist = Number.isFinite(expected.distanceM) ? `${Math.round(expected.distanceM)} m from the mapped channel` : null;
    parts.push([name, kind, dist].filter(Boolean).join(' · '));
    if (expected.confidence === 'medium') parts.push('canals and drains are drawn less consistently, so the expected direction is less certain');
    parts.push(mapAgeText(map));
  } else if (verdict.source === 'terrain' && terrain) {
    const drop = Number.isFinite(terrain.dropM) ? `${terrain.dropM >= 0 ? 'drops' : 'rises'} ${Math.abs(terrain.dropM).toFixed(1)} m` : 'slope';
    const span = Array.isArray(terrain.elevations) && terrain.elevations.length
      ? `${Math.round(Math.max(...terrain.elevations.map((e) => e.distanceM)) - Math.min(...terrain.elevations.map((e) => e.distanceM)))} m`
      : null;
    parts.push(`Terrain estimate (coarse): ground ${drop}${span ? ` over ${span}` : ''} along the measured bearing · Open-Meteo, Copernicus DEM GLO-90`);
    if (mapStatus === 'live' || mapStatus === 'cache') parts.push(`no mapped waterway within ${config.RADIUS.waterway} m · ${mapAgeText(map)}`);
    else parts.push('map unavailable');
  } else {
    if (mapStatus === 'skipped') parts.push('Unverified · no location fix, so the map was not consulted');
    else if (mapStatus === 'unavailable') parts.push('Unverified · map unreachable and no saved data covers this spot');
    else if (expected) parts.push(`${expected.name || `unnamed ${expected.kind || 'waterway'}`} · ${mapAgeText(map)}`);
    else parts.push(`Unverified · no mapped waterway within ${config.RADIUS.waterway} m · ${mapAgeText(map)}`);
  }
  if (heading) {
    if (heading.status === 'ok' && heading.headingTrue != null) {
      if (heading.declination != null) {
        const sign = heading.declination >= 0 ? '+' : '−';
        parts.push(`heading ${pad3(heading.headingMag)}° magnetic, declination ${sign}${Math.abs(heading.declination).toFixed(1)}° → ${pad3(heading.headingTrue)}° true`);
      } else {
        parts.push(`heading ${pad3(heading.headingMag)}° magnetic; no GPS fix, so declination was not applied`);
      }
    } else if (heading.reason) {
      parts.push(`compass: ${heading.reason}`);
    }
  }
  return parts.map(sentence).join(' ');
}

/** Capitalise the first letter and end with a full stop. */
function sentence(text) {
  const t = String(text).trim();
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.');
}

/** Compact history entry from a verdict. */
export function historyEntryFrom(verdict, { at = Date.now(), demo = false } = {}) {
  return {
    at: new Date(at).toISOString(),
    code: verdict.code,
    tone: verdict.tone,
    headline: verdict.headline,
    measuredBearing: Number.isFinite(verdict.measuredBearing) ? Math.round(verdict.measuredBearing) : null,
    expectedBearing: Number.isFinite(verdict.expectedBearing) ? Math.round(verdict.expectedBearing) : null,
    streamName: verdict.streamName || null,
    source: verdict.source || 'none',
    demo,
  };
}

/** Human text for an offline.saveArea progress callback of unknown shape. */
export function progressText(p) {
  if (p == null) return 'Saving…';
  if (typeof p === 'string') return p;
  if (typeof p === 'number') return `Saving… ${Math.round(p * 100)}%`;
  if (typeof p.message === 'string') return p.message;
  const bits = [];
  if (p.stage) bits.push(String(p.stage));
  if (Number.isFinite(p.count)) bits.push(`${p.count} features`);
  if (Number.isFinite(p.bytes)) bits.push(`${formatBytes(p.bytes)}`);
  if (Number.isFinite(p.loaded) && Number.isFinite(p.total) && p.total > 0) bits.push(`${Math.round((100 * p.loaded) / p.total)}%`);
  return bits.length ? bits.join(' · ') : 'Saving…';
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function describeSceneError(err) {
  const code = err && err.code;
  switch (code) {
    case 'auth':
      return 'Scene check skipped: the API key was rejected.';
    case 'rate_limited':
      return 'Scene check skipped: rate limited.';
    case 'timeout':
      return 'Scene check skipped: Claude took too long.';
    case 'network':
      return 'Scene check skipped: no connection to api.anthropic.com.';
    case 'refusal':
      return 'Scene check skipped: Claude declined to classify the frame.';
    case 'bad_response':
      return 'Scene check skipped: unexpected answer from the API.';
    default:
      return `Scene check skipped${err && err.message ? `: ${err.message}` : '.'}`;
  }
}

export function describeCameraError(err) {
  const name = err && err.name;
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera access was denied. Allow the camera for this site, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'DevicesNotFoundError':
      return 'No usable camera found on this device.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera is busy or blocked. Close other apps that use it, then try again.';
    case 'SecurityError':
      return 'The camera needs a secure (https) page.';
    default:
      return `Camera error${name ? ` (${name})` : ''}. Try again.`;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch (err) {
    console.warn('[stream-checker]', err);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Browser state (only touched inside functions)

const state = {
  phase: 'idle',
  demo: false,
  debug: false,
  settings: { ...DEFAULT_SETTINGS },
  fetchOverride: null,
  stream: null,
  demoSource: null,
  stalled: false,
  loopGen: 0,
  lastFrameAt: 0,
  lastVideoTime: -1,
  frameCount: 0,
  firstFrameTimer: 0,
  muteTimer: 0,
  compass: null,
  compassPermission: null,
  compassStarted: false,
  compassStartedAt: 0,
  headingRing: [],
  lastSample: null,
  lastHeadingCheck: null,
  mapBackoffUntil: 0,
  run: null,
  runCounter: 0,
  analysis: null,
  history: [],
  toastTimer: 0,
  debugTimer: 0,
};

const el = {};

/** window.__sc: inspected by the end-to-end tests. */
const sc = {
  state: 'idle',
  lastVerdict: null,
  lastFlow: null,
  lastHeading: null,
  lastLocation: null,
  lastMap: null,
  lastScene: null,
  lastError: null,
  settings: null,
  version: config.APP_VERSION,
  demo: false,
  setFetch(fn) {
    state.fetchOverride = typeof fn === 'function' ? fn : null;
  },
};

function publicSettings() {
  // The key itself never goes on window; tests only need to know it is set.
  return { ...state.settings, apiKey: state.settings.apiKey ? '[set]' : '' };
}

function realFetch(...args) {
  return globalThis.fetch(...args);
}

function currentFetch() {
  if (state.fetchOverride) return state.fetchOverride;
  if (state.demo) return demoFetch(realFetch);
  return realFetch;
}

// ---------------------------------------------------------------------------
// Boot

function boot() {
  const params = new URLSearchParams(window.location.search);
  state.demo = params.get('demo') === '1' || window.location.hash === '#demo';
  state.debug = params.get('debug') === '1';
  sc.demo = state.demo;

  const ids = [
    'app', 'state', 'video', 'overlay', 'check-button', 'cancel-button', 'countdown', 'status', 'heading-readout',
    'verdict', 'verdict-headline', 'verdict-detail', 'measured-bearing', 'expected-bearing', 'verdict-source',
    'verdict-stats', 'scene-notice', 'share-button', 'again-button', 'history', 'history-count', 'save-area-button',
    'save-area-status', 'settings-button', 'settings', 'api-key', 'model-select', 'scene-toggle', 'sideways-toggle',
    'settings-close', 'help-button', 'help', 'help-close', 'demo-link', 'demo-badge', 'debug', 'toast', 'app-version',
    'clear-history-button', 'clear-saved-button',
  ];
  for (const id of ids) el[id] = document.getElementById(id);
  el.countdownValue = el.countdown.querySelector('.countdown-value');
  el.readoutValue = el['heading-readout'].querySelector('.readout-value');
  el.readoutHint = el['heading-readout'].querySelector('.readout-hint');

  window.__sc = sc;
  el['app-version'].textContent = `v${config.APP_VERSION}`;

  state.settings = loadSettings();
  applySettingsToForm();
  applySideways();
  sc.settings = publicSettings();

  state.history = loadHistory();
  renderHistory();
  renderSavedAreas();

  if (state.demo) {
    el['demo-badge'].hidden = false;
    el['demo-link'].textContent = 'Exit demo';
    el['demo-link'].href = './';
  }
  if (state.debug) {
    el.debug.hidden = false;
    state.debugTimer = setInterval(renderDebug, 500);
  }

  setupCompass();
  wireEvents();
  registerServiceWorker(params);
  setPhase('idle');
}

function wireEvents() {
  el['check-button'].addEventListener('click', onCheckClick);
  el['cancel-button'].addEventListener('click', () => cancelRun('Cancelled.'));
  el['again-button'].addEventListener('click', () => {
    hideVerdict();
    setPhase('idle');
    window.scrollTo({ top: 0 });
  });
  el['share-button'].addEventListener('click', onShareClick);
  el['save-area-button'].addEventListener('click', onSaveAreaClick);

  el['settings-button'].addEventListener('click', () => openSheet(el.settings));
  el['help-button'].addEventListener('click', () => openSheet(el.help));
  for (const sheet of [el.settings, el.help]) {
    // tap on the backdrop (the dialog itself, outside the form) closes it
    sheet.addEventListener('click', (ev) => {
      if (ev.target === sheet) closeSheet(sheet);
    });
  }

  // Save the key on every keystroke: a change event only fires on blur, and
  // on iOS the sheet may close before that happens.
  const saveKey = () => {
    if (el['api-key'].value.trim() !== state.settings.apiKey) updateSetting('apiKey', el['api-key'].value.trim());
  };
  el['api-key'].addEventListener('input', saveKey);
  el['api-key'].addEventListener('change', saveKey);
  el['model-select'].addEventListener('change', () => updateSetting('model', el['model-select'].value));
  el['settings-close'].addEventListener('click', (ev) => {
    ev.preventDefault();
    closeSheet(el.settings);
  });
  el['help-close'].addEventListener('click', (ev) => {
    ev.preventDefault();
    closeSheet(el.help);
  });
  el['scene-toggle'].addEventListener('change', () => updateSetting('sceneCheck', el['scene-toggle'].checked));
  el['sideways-toggle'].addEventListener('change', () => {
    updateSetting('sideways', el['sideways-toggle'].checked);
    applySideways();
  });
  el['clear-history-button'].addEventListener('click', () => {
    state.history = [];
    saveHistory();
    renderHistory();
    toast('Field log cleared.');
  });
  el['clear-saved-button'].addEventListener('click', async () => {
    try {
      await clearSaved();
      toast('Saved map data deleted.');
    } catch (err) {
      toast('Could not delete saved map data.');
      console.warn(err);
    }
    renderSavedAreas();
  });

  document.addEventListener('visibilitychange', onVisibilityChange);
  el.video.addEventListener('loadedmetadata', syncOverlaySize);
}

function registerServiceWorker(params) {
  if (!('serviceWorker' in navigator)) return;
  if (!/^https?:$/.test(window.location.protocol)) return;
  if (params.get('nosw') === '1') return;
  // Relative path and no explicit scope: on GitHub Pages this resolves to
  // /stream-checker/sw.js with scope /stream-checker/, locally to /sw.js.
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch((err) => console.warn('[sw]', err));
}

// ---------------------------------------------------------------------------
// Phases and status

function setPhase(phase) {
  state.phase = phase;
  sc.state = phase;
  el.state.dataset.state = phase;
  const busy = phase === 'permissions' || phase === 'capturing' || phase === 'analyzing' || phase === 'judging';
  el['check-button'].disabled = busy;
  el['check-button'].setAttribute('aria-busy', busy ? 'true' : 'false');
  el['check-button'].querySelector('.check-label').textContent = phase === 'error' ? 'Try again' : phase === 'verdict' ? 'Check again' : 'Check';
  switch (phase) {
    case 'idle':
      setStatus(idleStatus());
      break;
    case 'permissions':
      setStatus('Asking for camera, compass and location…');
      break;
    case 'capturing':
      setStatus('Hold still. Recording the flow…');
      break;
    case 'analyzing':
      setStatus('Measuring the flow…');
      break;
    case 'judging':
      setStatus('Looking up the mapped channel…');
      break;
    case 'verdict':
      setStatus('');
      break;
    default:
      break;
  }
}

function idleStatus() {
  if (state.demo) return 'Demo mode: synthetic creek, fixture location and map data. Tap Check.';
  if (state.stream) return 'Camera ready. Fill the frame with the water, then tap Check.';
  return 'Point the camera at moving water, then tap Check.';
}

function setStatus(text) {
  el.status.textContent = text;
}

function toast(text, ms = 2600) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, ms);
}

// ---------------------------------------------------------------------------
// Settings

function loadSettings() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(config.STORAGE.settings) || 'null');
    return sanitizeSettings(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    window.localStorage.setItem(config.STORAGE.settings, JSON.stringify(state.settings));
  } catch (err) {
    console.warn('[settings] not saved', err);
  }
  sc.settings = publicSettings();
}

function updateSetting(key, value) {
  state.settings = sanitizeSettings({ ...state.settings, [key]: value });
  saveSettings();
  applySettingsToForm();
}

function applySettingsToForm() {
  el['api-key'].value = state.settings.apiKey;
  el['model-select'].value = state.settings.model;
  el['scene-toggle'].checked = state.settings.sceneCheck;
  el['sideways-toggle'].checked = state.settings.sideways;
}

function applySideways() {
  document.documentElement.classList.toggle('sideways', state.settings.sideways);
}

function sceneEnabled() {
  return state.settings.sceneCheck && state.settings.apiKey.length > 0;
}

function openSheet(dialog) {
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
}

function closeSheet(dialog) {
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

// ---------------------------------------------------------------------------
// History

function loadHistory() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(config.STORAGE.history) || '[]');
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e === 'object' && e.code).slice(0, config.HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    window.localStorage.setItem(config.STORAGE.history, JSON.stringify(state.history));
  } catch (err) {
    console.warn('[history] not saved', err);
  }
}

function pushHistory(entry) {
  state.history.unshift(entry);
  state.history = state.history.slice(0, config.HISTORY_MAX);
  saveHistory();
  renderHistory();
}

function renderHistory() {
  const list = el.history;
  list.textContent = '';
  el['history-count'].textContent = state.history.length ? `${state.history.length} / ${config.HISTORY_MAX}` : '';
  if (!state.history.length) {
    const li = document.createElement('li');
    li.className = 'history-empty';
    li.textContent = 'No checks yet.';
    list.appendChild(li);
    return;
  }
  for (const entry of state.history) {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.dataset.tone = entry.tone || 'neutral';
    li.dataset.code = entry.code;

    const when = new Date(entry.at);
    const time = document.createElement('time');
    time.className = 'history-time';
    time.dateTime = entry.at;
    time.textContent = Number.isNaN(when.getTime())
      ? ''
      : `${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}\n${when.toLocaleDateString([], { day: 'numeric', month: 'short' })}`;

    const headline = document.createElement('span');
    headline.className = 'history-headline';
    headline.textContent = (entry.headline || entry.code) + (entry.demo ? ' (demo)' : '');

    const bearings = document.createElement('span');
    bearings.className = 'history-bearings';
    const measured = entry.measuredBearing != null ? describeBearing(entry.measuredBearing) : '—';
    const expected = entry.expectedBearing != null ? describeBearing(entry.expectedBearing) : '—';
    bearings.textContent = `${measured} → ${expected}${entry.streamName ? ` · ${entry.streamName}` : ''}`;

    li.append(time, headline, bearings);
    list.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Compass

function setupCompass() {
  if (state.demo) {
    state.compass = createDemoCompass();
  } else {
    state.compass = safe(() => createCompass(), null) || createDemoCompass({ headingMag: null });
  }
  state.compass.onUpdate(onCompassSample);
}

/** A compass with the createCompass() interface but a fixed heading (demo). */
function createDemoCompass({ headingMag = DEMO.headingMag } = {}) {
  const listeners = new Set();
  let timer = 0;
  const current = () => ({
    headingMag,
    source: headingMag == null ? 'none' : 'demo',
    accuracy: headingMag == null ? null : 0,
    pitch: 45,
    roll: 0,
    tiltOk: true,
    updatedAt: Date.now(),
  });
  return {
    async requestPermission() {
      return headingMag == null ? 'unsupported' : 'granted';
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        for (const fn of listeners) fn(current());
      }, 500);
      for (const fn of listeners) fn(current());
    },
    stop() {
      clearInterval(timer);
      timer = 0;
    },
    current,
    beginWindow() {},
    endWindow() {
      return headingMag == null ? { headingMag: null, samples: 0, R: 0 } : { headingMag, samples: 60, R: 1 };
    },
    onUpdate(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

function onCompassSample(sample) {
  state.lastSample = sample;
  if (sample && Number.isFinite(sample.headingMag)) {
    state.headingRing.push(sample.headingMag);
    if (state.headingRing.length > HEADING_RING) state.headingRing.shift();
  }
  // Live sample plus the summary of the last check's heading window, so a
  // stream of sensor events never erases what the verdict was based on.
  sc.lastHeading = { ...(sample || {}), check: state.lastHeadingCheck || null };
  renderHeadingReadout();
}

function renderHeadingReadout() {
  const waitedMs = state.compassStartedAt ? performance.now() - state.compassStartedAt : 0;
  const r = headingReadout(state.lastSample, { status: state.compassPermission, recent: state.headingRing, waitedMs });
  el.readoutValue.textContent = r.value;
  el.readoutHint.textContent = r.hint;
  el['heading-readout'].dataset.hint = r.kind;
}

function startCompass() {
  if (state.compassStarted) return;
  state.compassStarted = true;
  state.compassStartedAt = performance.now();
  safe(() => state.compass.start());
  // keep the readout honest while no sample has arrived yet
  const tick = () => {
    if (state.lastSample && state.lastSample.headingMag != null) return;
    renderHeadingReadout();
    if (performance.now() - state.compassStartedAt < 4000) setTimeout(tick, 700);
  };
  setTimeout(tick, 700);
}

// ---------------------------------------------------------------------------
// Camera

function streamLive(stream) {
  const track = stream && stream.getVideoTracks()[0];
  return !!track && track.readyState === 'live';
}

/** Resolve with a live stream, acquiring one if needed. getUserMedia is called synchronously. */
function ensureCamera() {
  if (state.stream && streamLive(state.stream) && !state.stalled) return Promise.resolve(state.stream);
  if (state.stream && !streamLive(state.stream)) dropStream();
  if (state.stalled) {
    dropStream();
    state.stalled = false;
  }
  return acquireCamera();
}

async function acquireCamera() {
  let stream;
  if (state.demo) {
    if (state.demoSource) state.demoSource.stop();
    state.demoSource = createDemoStream({ angleDeg: DEMO.angleDeg, speed: DEMO.speed });
    stream = state.demoSource.stream;
  } else {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      const err = new Error('getUserMedia unavailable');
      err.name = 'SecurityError';
      throw err;
    }
    // Invoked synchronously from the click handler (no await above this line).
    stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
  }
  attachStream(stream);
  await playVideo();
  return stream;
}

function dropStream() {
  if (state.stream) {
    for (const track of state.stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
    }
  }
  if (state.demoSource) {
    state.demoSource.stop();
    state.demoSource = null;
  }
  state.stream = null;
  state.loopGen++;
}

function attachStream(stream) {
  state.stream = stream;
  state.stalled = false;
  el.video.srcObject = stream;
  const track = stream.getVideoTracks()[0];
  if (track) {
    track.addEventListener('mute', onTrackMute);
    track.addEventListener('unmute', onTrackUnmute);
    track.addEventListener('ended', onTrackEnded);
  }
  el.state.dataset.camera = 'on';
  state.lastFrameAt = performance.now();
  state.lastVideoTime = -1;
  startFrameLoop();
  armFirstFrameWatch();
  renderHeadingReadout();
}

async function playVideo() {
  try {
    await el.video.play();
  } catch (err) {
    // Autoplay policies or an interrupted load. The preview is muted and
    // inline, so this is rare; the frame loop keeps watching for frames.
    console.warn('[camera] play()', err);
  }
}

function syncOverlaySize() {
  const v = el.video;
  if (v.videoWidth && v.videoHeight && (el.overlay.width !== v.videoWidth || el.overlay.height !== v.videoHeight)) {
    el.overlay.width = v.videoWidth;
    el.overlay.height = v.videoHeight;
  }
}

/**
 * One loop per stream. requestVideoFrameCallback fires once per presented
 * frame (so a silent camera stops it: the watchdog notices); the rAF fallback
 * detects new frames by the video's currentTime advancing.
 */
function startFrameLoop() {
  const gen = ++state.loopGen;
  const video = el.video;
  const useRVFC = typeof video.requestVideoFrameCallback === 'function';
  const tick = (now) => {
    if (gen !== state.loopGen || !state.stream) return;
    const ts = typeof now === 'number' ? now : performance.now();
    if (useRVFC) {
      onVideoFrame(ts);
    } else if (video.currentTime !== state.lastVideoTime && video.readyState >= 2) {
      state.lastVideoTime = video.currentTime;
      onVideoFrame(ts);
    }
    schedule();
  };
  const schedule = () => {
    if (useRVFC) video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  };
  schedule();
}

function armFirstFrameWatch() {
  clearTimeout(state.firstFrameTimer);
  const count = state.frameCount;
  state.firstFrameTimer = setTimeout(() => {
    if (state.stream && state.frameCount === count && !document.hidden) cameraStalled();
  }, FIRST_FRAME_MS);
}

function onVideoFrame(now) {
  state.lastFrameAt = now;
  state.frameCount++;
  syncOverlaySize();
  const run = state.run;
  if (!run || run.phase !== 'capturing') return;
  // Process at most TARGET_FPS pairs per second; the 0.7 factor keeps a source
  // that already runs at TARGET_FPS from losing every other frame to timing
  // jitter, while a 30 fps camera still settles on every second frame.
  if (now - run.lastProcessed < (1000 / config.TARGET_FPS) * 0.7) return;
  run.lastProcessed = now;
  processFrame(run, now);
}

function onTrackMute() {
  if (document.hidden) return; // iOS mutes while backgrounded; that is normal
  clearTimeout(state.muteTimer);
  state.muteTimer = setTimeout(() => {
    const track = state.stream && state.stream.getVideoTracks()[0];
    if (track && track.muted && !document.hidden) cameraStalled();
  }, 1500);
}

function onTrackUnmute() {
  clearTimeout(state.muteTimer);
}

function onTrackEnded() {
  if (!document.hidden) {
    // Lost the camera while visible (another app took it). Re-acquire on next check.
    el.state.dataset.camera = 'off';
    if (state.run) failRun(state.run, new Error('Camera stopped'), 'The camera stopped. Tap Check to try again.');
  }
}

function cameraStalled() {
  if (state.stalled) return;
  state.stalled = true;
  sc.lastError = 'camera_stalled';
  if (state.run) abortRun(state.run);
  setPhase('error');
  setStatus(STALL_MESSAGE);
}

function onVisibilityChange() {
  if (document.hidden) return;
  if (!state.stream) return;
  const track = state.stream.getVideoTracks()[0];
  if (!track || track.readyState === 'ended') {
    // Safari ends the track when the page is backgrounded for a while.
    dropStream();
    acquireCamera().catch((err) => {
      el.state.dataset.camera = 'off';
      setStatus(describeCameraError(err));
    });
  } else {
    state.lastFrameAt = performance.now();
    playVideo();
  }
}

/** Offscreen canvas at the analysis resolution. */
function analysisCanvasFor(video) {
  const w = config.ANALYSIS_WIDTH;
  const h = Math.max(1, Math.round((video.videoHeight * w) / video.videoWidth));
  if (!state.analysis || state.analysis.w !== w || state.analysis.h !== h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    state.analysis = { canvas, ctx, w, h };
  }
  return state.analysis;
}

// ---------------------------------------------------------------------------
// Overlay

function clearOverlay() {
  const ctx = el.overlay.getContext('2d');
  ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
}

function arrow(ctx, x0, y0, x1, y1, head) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return;
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  const a = Math.atan2(dy, dx);
  const h = Math.min(head, len * 0.6);
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - h * Math.cos(a - 0.5), y1 - h * Math.sin(a - 0.5));
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - h * Math.cos(a + 0.5), y1 - h * Math.sin(a + 0.5));
}

/** Draw block vectors (analysis px) and the running mean on the overlay. */
function drawOverlay(vectors, w, h, run) {
  const canvas = el.overlay;
  if (!canvas.width || !canvas.height) return;
  const ctx = canvas.getContext('2d');
  const sx = canvas.width / w;
  const sy = canvas.height / h;
  // Adaptive gain: the typical block vector draws at about 5 % of the frame
  // width (one grid stride) whatever the flow speed, so slow creeks are as
  // readable as torrents and neighbouring arrows do not pile up.
  const typical = run && run.pairs > 0 ? Math.hypot(run.sumDx, run.sumDy) / run.pairs : 0;
  const gain = Math.min(40, Math.max(4, (0.05 * w) / Math.max(typical, 0.3)));
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (Array.isArray(vectors) && vectors.length) {
    ctx.lineWidth = Math.max(1.5, canvas.width / 320);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(143, 216, 223, 0.85)';
    ctx.beginPath();
    for (const v of vectors) {
      arrow(ctx, v.x * sx, v.y * sy, (v.x + v.dx * gain) * sx, (v.y + v.dy * gain) * sy, 5 * sx);
    }
    ctx.stroke();
  }

  if (run && run.pairs > 0) {
    const mdx = run.sumDx / run.pairs;
    const mdy = run.sumDy / run.pairs;
    const mag = Math.hypot(mdx, mdy);
    if (mag > 0.05) {
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const len = canvas.height * 0.22;
      const ux = mdx / mag;
      const uy = mdy / mag;
      ctx.lineWidth = Math.max(5, canvas.width / 110);
      ctx.strokeStyle = 'rgba(8, 18, 20, 0.55)';
      ctx.beginPath();
      arrow(ctx, cx - ux * len * 0.5, cy - uy * len * 0.5, cx + ux * len * 0.5, cy + uy * len * 0.5, 16 * sx);
      ctx.stroke();
      ctx.lineWidth = Math.max(3, canvas.width / 200);
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      arrow(ctx, cx - ux * len * 0.5, cy - uy * len * 0.5, cx + ux * len * 0.5, cy + uy * len * 0.5, 16 * sx);
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// Location and map

function getLocation(signal) {
  if (state.demo) return Promise.resolve({ ...DEMO.location });
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    if (signal) signal.addEventListener('abort', () => finish(null), { once: true });
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => finish({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        (err) => {
          state.locationError = err && err.code === 1 ? 'location denied' : err && err.code === 3 ? 'no GPS fix in time' : 'location unavailable';
          finish(null);
        },
        { enableHighAccuracy: true, timeout: LOCATION_TIMEOUT_MS, maximumAge: 30000 },
      );
    } catch (err) {
      state.locationError = 'location unavailable';
      finish(null);
    }
  });
}

/** Live Overpass, else the saved area, else nothing. */
async function lookupMap(point, run) {
  const fetchImpl = currentFetch();
  const out = { status: 'unavailable', features: null, expected: null, water: null, error: null };
  if (Date.now() < state.mapBackoffUntil) {
    out.error = 'rate limited; waiting before asking Overpass again';
  } else {
    try {
      out.features = await fetchFeatures(point, { fetchImpl, signal: run.mapAbort.signal });
      out.status = 'live';
    } catch (err) {
      out.error = err && (err.code || err.message || String(err));
      if (err && err.code === 'rate_limited') state.mapBackoffUntil = Date.now() + config.OVERPASS_BACKOFF_MS;
    }
  }
  if (!out.features) {
    try {
      const cached = await cachedFeatures(point);
      if (cached) {
        out.features = cached;
        out.status = 'cache';
      }
    } catch (err) {
      console.warn('[offline]', err);
    }
  }
  if (out.features) {
    out.expected = safe(() => expectedFlow(out.features, point));
    out.water = safe(() => nearbyWater(out.features, point));
  }
  sc.lastMap = {
    status: out.status,
    error: out.error ? String(out.error) : null,
    host: out.features && out.features.host ? out.features.host : null,
    timestamp: out.features ? out.features.timestamp || null : null,
    waterways: out.features && out.features.waterways ? out.features.waterways.length : 0,
    expected: out.expected,
    water: out.water,
  };
  return out;
}

// ---------------------------------------------------------------------------
// The check

function createRun() {
  const abort = new AbortController();
  const mapAbort = new AbortController();
  abort.signal.addEventListener('abort', () => mapAbort.abort(), { once: true });
  return {
    id: ++state.runCounter,
    phase: 'permissions',
    abort,
    mapAbort,
    cancelled: false,
    startedAt: performance.now(),
    captureStart: 0,
    lastProcessed: -Infinity,
    frames: 0,
    pairs: 0,
    sumDx: 0,
    sumDy: 0,
    acc: new FlowAccumulator(),
    prevGray: null,
    lastEstimate: null,
    sceneStarted: false,
    scenePromise: null,
    scene: null,
    sceneError: null,
    location: null,
    map: null,
    ticker: 0,
  };
}

function onCheckClick() {
  if (state.run) return;
  const run = createRun();
  state.run = run;
  state.locationError = null;
  sc.lastError = null;
  hideVerdict();
  clearOverlay();
  setPhase('permissions');

  // Everything that needs the tap's user activation is called right here,
  // synchronously: iOS rejects DeviceOrientationEvent.requestPermission()
  // without a gesture, and the camera prompt is friendlier from one too.
  let compassPermission;
  try {
    compassPermission = Promise.resolve(state.compass.requestPermission());
  } catch (err) {
    compassPermission = Promise.resolve('unsupported');
  }
  const cameraReady = ensureCamera();
  run.location = getLocation(run.abort.signal);
  run.map = run.location.then((loc) => (loc ? lookupMap(loc, run) : null)).catch((err) => {
    console.warn('[map]', err);
    return null;
  });
  run.location.then((loc) => {
    sc.lastLocation = loc ? { ...loc } : null;
  });

  continueCheck(run, compassPermission, cameraReady).catch((err) => failRun(run, err));
}

async function continueCheck(run, compassPermission, cameraReady) {
  const permission = await compassPermission.catch(() => 'unsupported');
  state.compassPermission = permission;
  startCompass();
  renderHeadingReadout();

  try {
    await cameraReady;
  } catch (err) {
    el.state.dataset.camera = 'off';
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { userMessage: describeCameraError(err) });
  }
  if (run.cancelled) return;

  await waitForFirstFrame(run);
  if (run.cancelled) return;

  // ---- capturing
  run.phase = 'capturing';
  run.captureStart = performance.now();
  state.lastFrameAt = run.captureStart;
  safe(() => state.compass.beginWindow());
  setPhase('capturing');
  await captureClip(run);
  if (run.cancelled) return;

  // ---- analyzing
  run.phase = 'analyzing';
  setPhase('analyzing');
  const win = safe(() => state.compass.endWindow(), null);
  const flowResult = run.acc.result();
  const motion = safe(() => classifyMotion(flowResult), 'insufficient');
  const compassInfo = compassStatusFrom(permission, win);

  // ---- judging
  run.phase = 'judging';
  setPhase('judging');
  const location = await run.location;
  if (run.cancelled) return;

  let headingTrue = null;
  let decl = null;
  if (compassInfo.status === 'ok') {
    if (location) {
      decl = safe(() => declination(location.lat, location.lon), null);
      headingTrue = safe(() => magneticToTrue(compassInfo.headingMag, location.lat, location.lon), compassInfo.headingMag);
    } else {
      headingTrue = compassInfo.headingMag; // magnetic; noted in the source line
    }
  }
  const imageAngle = flowResult.angleDeg == null ? null : normalizeDeg(flowResult.angleDeg + (state.settings.sideways ? 90 : 0));
  const flowBearing = imageAngle != null && headingTrue != null ? imageAngleToBearing(imageAngle, headingTrue) : null;

  sc.lastFlow = { ...flowResult, motion, imageAngle, flowBearing };
  state.lastHeadingCheck = {
    window: win,
    status: compassInfo.status,
    headingMag: compassInfo.headingMag,
    headingTrue,
    declination: decl,
    reason: compassInfo.reason,
  };
  sc.lastHeading = { ...(state.lastSample || {}), check: state.lastHeadingCheck };

  // Map: already in flight since the GPS fix arrived; cap the wait.
  let map = null;
  if (location) {
    map = await Promise.race([
      run.map,
      delay(MAP_WAIT_MS).then(() => {
        run.mapAbort.abort();
        return run.map;
      }),
    ]);
  }
  if (run.cancelled) return;
  const expected = map ? map.expected : null;
  const water = map ? map.water : null;
  const mapStatus = location ? (map ? map.status : 'unavailable') : 'skipped';

  let terrain = null;
  if (!expected && flowBearing != null && location && motion === 'flowing') {
    setStatus('No mapped channel. Checking the terrain…');
    terrain = await safeAsync(() => terrainSlope(location, flowBearing, { fetchImpl: currentFetch(), signal: run.abort.signal }), null);
    if (run.cancelled) return;
  }

  let scene = null;
  if (run.scenePromise) {
    setStatus('Asking Claude what this is…');
    scene = await Promise.race([run.scenePromise, delay(SCENE_WAIT_MS).then(() => null)]);
    if (run.cancelled) return;
    if (!scene && !run.sceneError) run.sceneError = { code: 'timeout' };
  }

  const input = {
    motion,
    flow: flowResult,
    flowBearing,
    compass: { status: compassInfo.status, headingTrue },
    location,
    expected,
    water,
    terrain,
    scene,
    mapStatus,
  };
  const verdict = decide(input);
  run.phase = 'verdict';
  sc.lastVerdict = { ...verdict, input: { ...input, flow: { ...flowResult } } };

  renderVerdict(verdict, {
    expected,
    terrain,
    map,
    mapStatus,
    flow: flowResult,
    win,
    heading: { ...compassInfo, headingTrue, declination: decl },
    sceneError: run.sceneError,
    scene,
  });
  pushHistory(historyEntryFrom(verdict, { demo: state.demo }));
  finishRun(run);
  setPhase('verdict');
}

function safeAsync(fn, fallback) {
  try {
    return Promise.resolve(fn()).catch((err) => {
      console.warn('[stream-checker]', err);
      return fallback;
    });
  } catch (err) {
    console.warn('[stream-checker]', err);
    return Promise.resolve(fallback);
  }
}

/** Resolve once the preview has produced a frame, or reject as stalled. */
function waitForFirstFrame(run) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const count = state.frameCount;
    const check = () => {
      if (run.cancelled) return resolve();
      if (state.frameCount > count && el.video.videoWidth > 0) return resolve();
      if (performance.now() - start > FIRST_FRAME_MS) {
        cameraStalled();
        return reject(Object.assign(new Error('stalled'), { userMessage: STALL_MESSAGE }));
      }
      setTimeout(check, 50);
    };
    check();
  });
}

/** Run the countdown and the stall watchdog until the clip is complete. */
function captureClip(run) {
  return new Promise((resolve) => {
    const total = config.CAPTURE_MS;
    const tick = () => {
      if (run.cancelled || state.run !== run) {
        clearInterval(run.ticker);
        return resolve();
      }
      const now = performance.now();
      const elapsed = now - run.captureStart;
      const remaining = Math.max(0, total - elapsed);
      el.countdown.style.setProperty('--p', String(Math.min(1, elapsed / total)));
      el.countdownValue.textContent = (remaining / 1000).toFixed(1);
      const track = state.stream && state.stream.getVideoTracks()[0];
      const muted = !!(track && track.muted);
      if (!document.hidden && (now - state.lastFrameAt > config.STALL_MS || muted)) {
        clearInterval(run.ticker);
        cameraStalled();
        return resolve();
      }
      if (elapsed >= total) {
        clearInterval(run.ticker);
        el.countdown.style.setProperty('--p', '1');
        return resolve();
      }
    };
    run.ticker = setInterval(tick, 100);
    tick();
  });
}

function processFrame(run, now = performance.now()) {
  const video = el.video;
  if (!video.videoWidth || !video.videoHeight) return;
  const { ctx, w, h } = analysisCanvasFor(video);
  ctx.drawImage(video, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const gray = toGray(img);
  run.frames++;
  if (!run.sceneStarted) considerSceneFrame(run, gray, w, h);
  if (run.prevGray) {
    const r = estimateFlow(run.prevGray, gray, w, h, { returnVectors: true });
    // Normalise the pair to the nominal frame interval: cameras drop and
    // bunch frames, and a pair spanning two frames must not read as a burst
    // of speed (which would inflate the shake score on steady water).
    const nominal = 1000 / config.TARGET_FPS;
    const dt = run.prevFrameAt > 0 ? now - run.prevFrameAt : nominal;
    const scale = Math.min(4, Math.max(0.25, nominal / Math.max(1, dt)));
    run.acc.add(r, scale);
    if (r.accepted > 0 && Number.isFinite(r.dx) && Number.isFinite(r.dy)) {
      run.sumDx += r.dx * scale;
      run.sumDy += r.dy * scale;
      run.pairs++;
    }
    run.lastEstimate = { dx: r.dx, dy: r.dy, accepted: r.accepted, total: r.total, dtMs: dt };
    drawOverlay(r.vectors, w, h, run);
  }
  run.prevGray = gray;
  run.prevFrameAt = now;
}

function considerSceneFrame(run, gray, w, h) {
  if (!sceneEnabled()) {
    run.sceneStarted = true;
    return;
  }
  const s = sharpness(gray, w, h);
  if (s >= SHARPNESS_MIN || run.frames >= SHARPNESS_GIVE_UP_FRAMES) {
    run.sceneStarted = true;
    run.scenePromise = startScene(run);
  }
}

async function startScene(run) {
  try {
    const blob = await frameToJpegBlob(el.video);
    const result = await classifyScene(blob, {
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      fetchImpl: currentFetch(),
      signal: run.abort.signal,
    });
    run.scene = result;
    sc.lastScene = result;
    return result;
  } catch (err) {
    run.sceneError = err;
    sc.lastScene = { error: err && err.code ? err.code : 'error', message: err && err.message ? err.message : String(err) };
    return null;
  }
}

function finishRun(run) {
  clearInterval(run.ticker);
  if (state.run === run) state.run = null;
}

function abortRun(run) {
  run.cancelled = true;
  run.abort.abort();
  clearInterval(run.ticker);
  safe(() => state.compass.endWindow());
  if (state.run === run) state.run = null;
}

function cancelRun(message) {
  const run = state.run;
  if (!run) return;
  abortRun(run);
  clearOverlay();
  setPhase('idle');
  if (message) setStatus(message);
}

function failRun(run, err, message) {
  console.error('[stream-checker]', err);
  abortRun(run);
  sc.lastError = err && (err.name || err.code || err.message) ? String(err.name || err.code || err.message) : 'error';
  if (!state.stalled) {
    setPhase('error');
    setStatus(message || (err && err.userMessage) || `Something went wrong: ${err && err.message ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// Verdict card

function hideVerdict() {
  el.verdict.hidden = true;
  el.verdict.dataset.code = '';
  el.verdict.dataset.tone = '';
}

function statItem(label, value) {
  const div = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  div.append(dt, dd);
  return div;
}

function renderVerdict(verdict, ctx) {
  el.verdict.dataset.code = verdict.code || '';
  el.verdict.dataset.tone = verdict.tone || 'neutral';
  el['verdict-headline'].textContent = verdict.headline || verdict.code || '';
  el['verdict-detail'].textContent = verdict.detail || '';
  el['measured-bearing'].textContent = Number.isFinite(verdict.measuredBearing) ? describeBearing(verdict.measuredBearing) : '—';
  el['expected-bearing'].textContent = Number.isFinite(verdict.expectedBearing) ? describeBearing(verdict.expectedBearing) : '—';

  const stats = el['verdict-stats'];
  stats.textContent = '';
  const f = ctx.flow || {};
  if (Number.isFinite(verdict.delta)) stats.appendChild(statItem('Δ', `${Math.round(Math.abs(verdict.delta))}°`));
  if (Number.isFinite(f.consistency)) stats.appendChild(statItem('consistency', f.consistency.toFixed(2)));
  if (Number.isFinite(f.speed)) stats.appendChild(statItem('speed', `${f.speed.toFixed(1)} px/f`));
  if (Number.isFinite(f.coverage)) stats.appendChild(statItem('coverage', `${Math.round(f.coverage * 100)}%`));
  if (Number.isFinite(f.shake)) stats.appendChild(statItem('shake', f.shake.toFixed(1)));
  if (Number.isFinite(f.frames)) stats.appendChild(statItem('pairs', String(f.frames)));
  if (ctx.win && Number.isFinite(ctx.win.samples)) stats.appendChild(statItem('heading n', `${ctx.win.samples}${Number.isFinite(ctx.win.R) ? ` R ${ctx.win.R.toFixed(2)}` : ''}`));
  if (ctx.expected && Number.isFinite(ctx.expected.distanceM)) stats.appendChild(statItem('channel', `${Math.round(ctx.expected.distanceM)} m`));

  el['verdict-source'].textContent = buildSourceLine({
    verdict,
    expected: ctx.expected,
    terrain: ctx.terrain,
    map: ctx.map,
    mapStatus: ctx.mapStatus,
    heading: ctx.heading,
  });

  const notice = el['scene-notice'];
  if (ctx.scene && ctx.scene.quip) {
    notice.textContent = `Claude (${ctx.scene.model || state.settings.model}): “${ctx.scene.quip}” — ${ctx.scene.label || ctx.scene.bodyType || ctx.scene.scene}, ${Math.round((ctx.scene.confidence || 0) * 100)}% sure.`;
    notice.hidden = false;
  } else if (ctx.sceneError) {
    notice.textContent = describeSceneError(ctx.sceneError);
    notice.hidden = false;
  } else if (!sceneEnabled()) {
    notice.textContent = 'Scene check off: assuming that is water. Turn it on in Settings to have Claude look.';
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }

  el.verdict.hidden = false;
  el.verdict.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function onShareClick() {
  const v = sc.lastVerdict;
  if (!v) return;
  const text = v.shareText || `${v.headline}. ${v.detail || ''}`.trim();
  const url = `${window.location.origin}${window.location.pathname}`;
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: config.APP_NAME, text, url });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      // fall through to the clipboard
    }
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    toast('Copied to the clipboard.');
  } catch {
    toast('Could not share or copy on this browser.');
  }
}

// ---------------------------------------------------------------------------
// Save streams near me

async function onSaveAreaClick() {
  const button = el['save-area-button'];
  const status = el['save-area-status'];
  if (button.disabled) return;
  button.disabled = true;
  status.textContent = 'Getting your position…';
  try {
    const point = await getLocation();
    if (!point) {
      status.textContent = `Could not get a position (${state.locationError || 'unknown'}).`;
      return;
    }
    status.textContent = `Position ${point.lat.toFixed(4)}, ${point.lon.toFixed(4)} (±${Math.round(point.accuracy || 0)} m). Downloading…`;
    const result = await saveArea(point, {
      fetchImpl: currentFetch(),
      onProgress: (p) => {
        status.textContent = progressText(p);
      },
    });
    const count = result && Number.isFinite(result.count) ? result.count : null;
    status.textContent = `Saved${count != null ? ` ${count} features` : ''}${result && Number.isFinite(result.bytes) ? ` (${formatBytes(result.bytes)})` : ''} within ${Math.round((result && result.radiusM ? result.radiusM : config.RADIUS.offline) / 1000)} km.`;
    toast('Map data saved on this phone.');
  } catch (err) {
    console.warn('[save-area]', err);
    status.textContent = `Could not save: ${err && (err.code || err.message) ? err.code || err.message : err}`;
  } finally {
    button.disabled = false;
    renderSavedAreas();
  }
}

async function renderSavedAreas() {
  const status = el['save-area-status'];
  try {
    const areas = await savedAreas();
    if (!Array.isArray(areas) || !areas.length) {
      if (!status.textContent) status.textContent = 'No saved areas yet.';
      return;
    }
    const lines = areas.slice(0, 3).map((a) => {
      const when = a.savedAt ? new Date(a.savedAt) : null;
      const date = when && !Number.isNaN(when.getTime()) ? when.toLocaleDateString([], { day: 'numeric', month: 'short' }) : '';
      const where = a.center ? `${a.center.lat.toFixed(3)}, ${a.center.lon.toFixed(3)}` : '';
      return `${Math.round((a.radiusM || config.RADIUS.offline) / 1000)} km around ${where}${date ? ` · ${date}` : ''}${Number.isFinite(a.count) ? ` · ${a.count} features` : ''}`;
    });
    status.textContent = `${areas.length} saved area${areas.length === 1 ? '' : 's'}: ${lines.join(' | ')}`;
  } catch (err) {
    console.warn('[offline] savedAreas', err);
  }
}

// ---------------------------------------------------------------------------
// Debug panel

function renderDebug() {
  const run = state.run;
  const dump = {
    state: sc.state,
    camera: state.stream ? (streamLive(state.stream) ? 'live' : 'ended') : 'off',
    frames: state.frameCount,
    live: run && run.lastEstimate ? run.lastEstimate : null,
    flow: sc.lastFlow,
    heading: sc.lastHeading,
    headingSamples: state.headingRing.map((h) => Math.round(h)),
    location: sc.lastLocation,
    locationError: state.locationError || null,
    map: sc.lastMap,
    scene: sc.lastScene,
    verdict: sc.lastVerdict ? { code: sc.lastVerdict.code, delta: sc.lastVerdict.delta, source: sc.lastVerdict.source } : null,
    error: sc.lastError,
  };
  el.debug.textContent = JSON.stringify(dump, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v), 1);
}

// ---------------------------------------------------------------------------

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
