// STUB (test only): offline.js per CONTRACTS.md. No IndexedDB; nothing is saved.
import { RADIUS } from './config.js';
export function filterFeatures(all, point, radii = RADIUS) { return all; }
export async function saveArea(center, { radiusM = RADIUS.offline, fetchImpl = fetch, hosts, onProgress } = {}) {
  if (onProgress) { onProgress({ stage: 'downloading', loaded: 0, total: 1 }); onProgress({ stage: 'saving', count: 3, bytes: 4096 }); }
  return { count: 3, bytes: 4096, savedAt: Date.now(), center, radiusM };
}
export async function cachedFeatures(point) { return null; }
export async function savedAreas() { return []; }
export async function clearSaved() {}
