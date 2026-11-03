// docs/offline.js — "Save streams near me": an IndexedDB cache of map data.
//
// While the phone has signal, saveArea() downloads every mapped waterway,
// lake and coastline within a radius (geometry clipped to that box) and
// stores it. At the creek, cachedFeatures() picks the most recent saved area
// covering the position and applies the same radii the live query would
// have, so the nearest-feature code downstream sees the same shape either
// way. filterFeatures() is the pure part and is tested in Node; the storage
// functions only touch IndexedDB inside their bodies, guarded, so the module
// imports cleanly without a browser.

import * as config from './config.js';
import { haversineM, distanceToPolyline } from './geo.js';
import { buildAreaQuery, fetchFeatures, featureDistance, coastlineDistance } from './waterways.js';

const STORE = 'areas';
// An area download is a bigger query than the live lookup; give it the same
// budget the query's own [timeout:60] asks of the server.
const AREA_TIMEOUT_MS = 60000;

// ---------------------------------------------------------------------------
// Pure filtering

function isCoord(p) {
  return p != null && Number.isFinite(p.lat) && Number.isFinite(p.lon);
}

/**
 * Apply the live-query radii to a stored Features set: waterways whose
 * polyline comes within radii.waterway, water areas whose shore is within
 * radii.water or that contain the point (those also fill `containing`, the
 * offline stand-in for the live query's is_in), coastlines within radii.coast.
 */
export function filterFeatures(all, point, radii = config.RADIUS) {
  const out = {
    waterways: [],
    waterAreas: [],
    coastlines: [],
    containing: [],
    timestamp: all && typeof all.timestamp === 'string' ? all.timestamp : null,
    remark: all && typeof all.remark === 'string' ? all.remark : null,
  };
  if (!all || !isCoord(point)) return out;
  const r = { ...config.RADIUS, ...(radii || {}) };

  for (const w of Array.isArray(all.waterways) ? all.waterways : []) {
    if (!w || !Array.isArray(w.geometry)) continue;
    if (distanceToPolyline(point, w.geometry) <= r.waterway) out.waterways.push(w);
  }

  for (const a of Array.isArray(all.waterAreas) ? all.waterAreas : []) {
    const d = featureDistance(a, point);
    if (!d) continue;
    if (d.contains) {
      out.waterAreas.push(a);
      out.containing.push({ id: a.id, name: a.name || null, kind: a.kind || 'water', tags: a.tags || {} });
    } else if (d.distanceM <= r.water) {
      out.waterAreas.push(a);
    }
  }

  for (const c of Array.isArray(all.coastlines) ? all.coastlines : []) {
    const d = coastlineDistance(c, point); // open polylines, never rings
    if (d && d.distanceM <= r.coast) out.coastlines.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing (browser only; every entry point checks for it)

function idb() {
  return typeof globalThis !== 'undefined' && globalThis.indexedDB ? globalThis.indexedDB : null;
}

const NO_IDB_MESSAGE = 'IndexedDB is not available here (private browsing or an old browser), so map data cannot be saved offline.';

function openDb() {
  return new Promise((resolve, reject) => {
    const factory = idb();
    if (!factory) {
      reject(new Error(NO_IDB_MESSAGE));
      return;
    }
    let request;
    try {
      request = factory.open(config.STORAGE.db, config.STORAGE.dbVersion);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('could not open the offline map database'));
    request.onblocked = () => reject(new Error('the offline map database is open in another tab; close it and retry'));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

/**
 * Run `fn(store)` inside one transaction and wait for it to commit. `fn`
 * must only await IndexedDB requests: any other await lets the transaction
 * auto-commit underneath it (the browser closes a transaction as soon as no
 * request is pending when control returns to the event loop).
 */
async function withStore(mode, fn) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = await fn(store);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
    return result;
  } finally {
    if (typeof db.close === 'function') db.close();
  }
}

function byteLength(text) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  return text.length;
}

function savedAtMs(record) {
  const t = record && record.savedAt ? Date.parse(record.savedAt) : NaN;
  return Number.isFinite(t) ? t : Number(record && record.id) || 0;
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Download everything mapped within `radiusM` of `center` and store it.
 * Resolves { count, bytes, savedAt, center, radiusM }; rejects when
 * IndexedDB is missing or no Overpass host answers (an OverpassError).
 * `onProgress` receives { stage, message, count?, bytes? } objects.
 */
export async function saveArea(center, { radiusM = config.RADIUS.offline, fetchImpl = fetch, hosts, onProgress } = {}) {
  if (!idb()) throw new Error(NO_IDB_MESSAGE);
  if (!isCoord(center)) throw new Error('saveArea needs a {lat, lon} centre');
  const progress = (p) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress(p);
    } catch (err) {
      /* a broken progress display must not fail the save */
    }
  };
  const km = Math.round(radiusM / 100) / 10;
  progress({ stage: 'downloading', message: `Downloading mapped water within ${km} km…` });

  const query = buildAreaQuery(center, radiusM);
  const live = await fetchFeatures(center, { fetchImpl, hosts, query, timeoutMs: AREA_TIMEOUT_MS });
  const features = {
    waterways: live.waterways,
    waterAreas: live.waterAreas,
    coastlines: live.coastlines,
    containing: [],
    timestamp: live.timestamp,
    remark: null,
    host: live.host,
  };
  const count = features.waterways.length + features.waterAreas.length + features.coastlines.length;
  const bytes = byteLength(JSON.stringify(features));
  progress({ stage: 'saving', message: `Saving ${count} features…`, count, bytes });

  const savedAt = new Date().toISOString();
  const record = {
    id: String(Date.now()),
    center: { lat: center.lat, lon: center.lon },
    radiusM,
    savedAt,
    count,
    bytes,
    features,
  };
  await withStore('readwrite', (store) => requestToPromise(store.put(record)));
  progress({ stage: 'saved', message: `Saved ${count} features.`, count, bytes });
  return { count, bytes, savedAt, center: record.center, radiusM, id: record.id, host: live.host, timestamp: live.timestamp };
}

/**
 * Features around `point` from the most recently saved area whose circle
 * covers it, filtered with the live radii, or null when nothing covers it
 * (or IndexedDB is unavailable or unreadable).
 */
export async function cachedFeatures(point) {
  if (!idb() || !isCoord(point)) return null;
  let records;
  try {
    records = await withStore('readonly', (store) => requestToPromise(store.getAll()));
  } catch (err) {
    if (typeof console !== 'undefined') console.warn('[offline] could not read saved areas', err);
    return null;
  }
  // A saved area only "covers" a point when every lookup radius around that
  // point still lies inside the saved circle; at the edge the data would be
  // silently incomplete and a verdict could miss the real nearest stream.
  const margin = Math.max(config.RADIUS.waterway, config.RADIUS.water, config.RADIUS.coast);
  const covering = (Array.isArray(records) ? records : []).filter(
    (r) => r && isCoord(r.center) && Number.isFinite(r.radiusM) && r.features && haversineM(point, r.center) + margin <= r.radiusM,
  );
  if (!covering.length) return null;
  covering.sort((a, b) => savedAtMs(b) - savedAtMs(a));
  const rec = covering[0];
  return {
    ...filterFeatures(rec.features, point),
    source: 'cache',
    savedAt: rec.savedAt,
    areaId: rec.id,
    host: rec.features.host || null,
  };
}

/** Saved areas, most recent first, without their feature payloads. */
export async function savedAreas() {
  if (!idb()) return [];
  const records = await withStore('readonly', (store) => requestToPromise(store.getAll()));
  return (Array.isArray(records) ? records : [])
    .filter((r) => r && r.id != null)
    .sort((a, b) => savedAtMs(b) - savedAtMs(a))
    .map((r) => ({ id: r.id, center: r.center, radiusM: r.radiusM, savedAt: r.savedAt, count: r.count, bytes: r.bytes }));
}

/** Delete every saved area. Resolves quietly when there is no IndexedDB. */
export async function clearSaved() {
  if (!idb()) return;
  await withStore('readwrite', (store) => requestToPromise(store.clear()));
}
