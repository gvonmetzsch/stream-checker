// STUB (test only): scene.js per CONTRACTS.md. Always fails with a network SceneError.
import { SCENE } from './config.js';
export class SceneError extends Error { constructor(code, message) { super(message || code); this.code = code; } }
export const SCENE_SCHEMA = { type: 'object', additionalProperties: false, properties: {} };
export function buildRequest(base64Jpeg, { model, apiKey }) { return { url: SCENE.apiUrl, headers: { 'x-api-key': apiKey }, body: { model } }; }
export function parseResponse(json) { throw new SceneError('bad_response', 'stub'); }
export async function classifyScene(jpegBlob, { apiKey, model = SCENE.models.default, fetchImpl = fetch, signal, timeoutMs } = {}) {
  try {
    const res = await fetchImpl(SCENE.apiUrl, { method: 'POST', headers: { 'x-api-key': apiKey, 'content-type': 'application/json' }, body: '{}', signal });
    if (res.status === 401) throw new SceneError('auth', 'bad key');
    const json = await res.json();
    const text = json && json.content && json.content[0] && json.content[0].text;
    if (!text) throw new SceneError('bad_response', 'no content');
    return { ...JSON.parse(text), model };
  } catch (err) {
    if (err instanceof SceneError) throw err;
    throw new SceneError('network', String(err));
  }
}
export async function frameToJpegBlob(source, maxEdge = SCENE.maxEdge, quality = SCENE.jpegQuality) {
  const canvas = document.createElement('canvas');
  const w = source.videoWidth || source.width || 1, h = source.videoHeight || source.height || 1;
  const s = Math.min(1, maxEdge / Math.max(w, h));
  canvas.width = Math.max(1, Math.round(w * s)); canvas.height = Math.max(1, Math.round(h * s));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = reject; r.readAsDataURL(blob); });
}
