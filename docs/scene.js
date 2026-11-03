// Claude scene check for Stream Checker: "is this even water, and what is it?"
//
// One raw fetch to the Messages API, straight from the browser (no SDK: the
// page has no bundler and this is a single call). The request is built as a
// plain object so it can be unit-tested without a network, and the answer is
// constrained to a JSON schema so the parser never has to guess at prose.
//
// Everything that touches the DOM (canvas, FileReader) lives inside functions,
// so this module imports cleanly in Node for the tests.

import * as config from './config.js';

/**
 * Error with a stable `code` the UI turns into a one-line notice.
 * Codes: 'auth' | 'network' | 'rate_limited' | 'refusal' | 'bad_response' | 'timeout'
 * plus 'aborted' when the caller's own AbortSignal cancelled the check.
 */
export class SceneError extends Error {
  constructor(code, message, { status = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SceneError';
    this.code = code;
    this.status = status;
  }
}

export const SCENE_VALUES = ['flowing_water', 'still_water', 'not_water'];
export const BODY_TYPES = [
  'river', 'stream', 'creek', 'canal', 'waterfall', 'lake', 'pond', 'puddle',
  'ocean', 'pool', 'fountain', 'sink', 'other',
];
export const QUIP_MAX_CHARS = 90;

// Structured-output schema. The API rejects numeric and string-length
// constraints (minimum/maximum/maxLength), so the 0..1 confidence range and
// the quip length live in the prompt text and parseResponse clamps/trims.
export const SCENE_SCHEMA = deepFreeze({
  type: 'object',
  properties: {
    scene: {
      type: 'string',
      enum: SCENE_VALUES,
      description: 'Whether the frame shows visibly moving water, still water, or no water at all.',
    },
    bodyType: {
      type: 'string',
      enum: BODY_TYPES,
      description: 'The kind of water body, or "other" when none of the names fits.',
    },
    label: { type: 'string', description: 'What it is, in 2 to 4 words.' },
    confidence: { type: 'number', description: 'How sure you are, from 0 to 1.' },
    quip: {
      type: 'string',
      description: 'One dry, funny line about the scene. At most 90 characters. No emoji.',
    },
  },
  required: ['scene', 'bodyType', 'label', 'confidence', 'quip'],
  additionalProperties: false,
});

/** One paragraph fixing the task; the question in the user turn restates the fields. */
export const SYSTEM_PROMPT =
  'You are the scene check inside Stream Checker, a joke app that films a creek or river with a phone and ' +
  'judges whether the water is flowing in the right direction. The app measures motion on its own; your job ' +
  'is a literal reading of one camera frame: whether it shows water that is visibly moving, water that is ' +
  'still, or no water at all; what kind of body of water it is; a short label; how confident you are; and one ' +
  'dry line about it. Report only what is visible and never guess at what is outside the frame. A single ' +
  'frame cannot prove motion, so answer flowing_water only when the surface shows the texture of movement ' +
  '(riffles, white water, streaks, a visible current) and still_water when it is flat, glassy or mirror-like. ' +
  'Screens, paintings and printed pictures of water are not water. Keep the quip short, dry and free of ' +
  'emoji. Answer with the JSON object only.';

export const QUESTION =
  'What is in this frame? Fill in: scene (flowing_water, still_water or not_water), bodyType (river, stream, ' +
  'creek, canal, waterfall, lake, pond, puddle, ocean, pool, fountain, sink or other), label (what it is, in ' +
  '2 to 4 words), confidence (a number from 0 to 1) and quip (one dry, funny line, at most 90 characters, ' +
  'no emoji).';

/**
 * Server-side refusal fallback exists for Opus 5.5 only. Haiku 5.5 has none
 * (a fallback list is a 400 there and "default" is a no-op), so the beta
 * header and the `fallbacks` field are sent only for Opus.
 */
export function supportsServerFallback(model) {
  return typeof model === 'string' && model.startsWith('claude-opus-5-5');
}

/**
 * Build the Messages API request as data: { url, headers, body }.
 * Pure, so the exact wire shape is unit-tested without a network.
 */
export function buildRequest(base64Jpeg, { model, apiKey } = {}) {
  if (typeof base64Jpeg !== 'string' || base64Jpeg.length === 0) {
    throw new TypeError('buildRequest: base64Jpeg must be a non-empty base64 string');
  }
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new SceneError('auth', 'No API key. Add one in Settings to enable the scene check.');
  }
  const modelId = typeof model === 'string' && model.length > 0 ? model : config.SCENE.models.default;
  // Tolerate a full data: URL (what FileReader produces) by keeping only the payload.
  const data = stripDataUrl(base64Jpeg);

  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey.trim(),
    'anthropic-version': config.SCENE.apiVersion,
    // The header the official SDK sets for browser use; without it the API answers 401.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const body = {
    model: modelId,
    // The model's own brief reasoning counts toward this cap, hence more than the JSON needs.
    max_tokens: config.SCENE.maxTokens,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: QUESTION },
        ],
      },
    ],
    // Low effort: a classification, not a puzzle. No temperature/top_p/top_k
    // (a 400 on this API version) and never an assistant prefill (also a 400):
    // the schema is what fixes the output shape.
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: SCENE_SCHEMA },
    },
  };
  if (supportsServerFallback(modelId)) {
    headers['anthropic-beta'] = config.SCENE.fallbackBeta;
    body.fallbacks = 'default';
  }
  return { url: config.SCENE.apiUrl, headers, body };
}

/**
 * Turn a Messages API response body into a SceneResult.
 * Throws SceneError: 'refusal' (safety classifier declined), 'bad_response'
 * (cut off, not JSON, wrong shape, out-of-enum values).
 */
export function parseResponse(json) {
  if (!json || typeof json !== 'object') {
    throw new SceneError('bad_response', 'Empty answer from the API.');
  }
  if (json.type === 'error') {
    throw new SceneError('bad_response', apiErrorMessage(json) || 'The API returned an error.');
  }
  // stop_reason is checked before content: a refusal still carries content blocks.
  if (json.stop_reason === 'refusal') {
    const why = json.stop_details && typeof json.stop_details.explanation === 'string' ? json.stop_details.explanation : '';
    throw new SceneError('refusal', why ? `Claude declined: ${why}` : 'Claude declined to classify the frame.');
  }
  if (json.stop_reason === 'max_tokens') {
    throw new SceneError('bad_response', 'The answer was cut off before the JSON was complete (max_tokens).');
  }
  // Thinking blocks (and, after a server-side fallback, a `fallback` block)
  // come before the text; the first text block holds the JSON.
  const block = Array.isArray(json.content)
    ? json.content.find((b) => b && b.type === 'text' && typeof b.text === 'string')
    : null;
  if (!block) throw new SceneError('bad_response', 'No text block in the answer.');

  let data;
  try {
    data = JSON.parse(block.text);
  } catch {
    throw new SceneError('bad_response', 'The answer was not valid JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new SceneError('bad_response', 'The answer was not a JSON object.');
  }
  if (!SCENE_VALUES.includes(data.scene)) {
    throw new SceneError('bad_response', `Unexpected scene value ${JSON.stringify(data.scene)}.`);
  }
  if (!BODY_TYPES.includes(data.bodyType)) {
    throw new SceneError('bad_response', `Unexpected bodyType value ${JSON.stringify(data.bodyType)}.`);
  }
  if (typeof data.label !== 'string' || typeof data.quip !== 'string') {
    throw new SceneError('bad_response', 'label and quip must be strings.');
  }
  const confidence = toConfidence(data.confidence);
  if (confidence === null) {
    throw new SceneError('bad_response', `confidence must be a number, got ${JSON.stringify(data.confidence)}.`);
  }

  const label = squash(data.label) || data.bodyType.replace(/_/g, ' ');
  const quip = squash(data.quip);
  return {
    scene: data.scene,
    bodyType: data.bodyType,
    label,
    confidence,
    quip,
    model: typeof json.model === 'string' ? json.model : null,
  };
}

/**
 * Send one JPEG frame to Claude and return the SceneResult.
 * Network, HTTP and timeout failures all surface as SceneError with a code.
 */
export async function classifyScene(jpegBlob, {
  apiKey,
  model = config.SCENE.models.default,
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = config.SCENE.timeoutMs,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new SceneError('network', 'fetch is not available in this browser.');
  }
  const base64 = await blobToBase64(jpegBlob);
  const req = buildRequest(base64, { model, apiKey }); // throws 'auth' when the key is missing

  // One controller covers both the timeout and the caller's signal, so a
  // cancelled check also cancels the HTTP request.
  const controller = new AbortController();
  let timedOut = false;
  // Rejects when the controller aborts, so a fetch that ignores its signal
  // (a mock, an old polyfill) still cannot hang the check.
  const abortedPromise = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
  abortedPromise.catch(() => {}); // only ever raced; never left unhandled
  const race = (p) => {
    if (controller.signal.aborted) return Promise.reject(abortError());
    const pr = Promise.resolve(p);
    pr.catch(() => {}); // a late rejection after the race is settled must not be "unhandled"
    return Promise.race([pr, abortedPromise]);
  };
  const transportError = (err) => {
    if (timedOut) {
      return new SceneError('timeout', `Claude did not answer within ${Math.round(timeoutMs / 1000)} s.`, { cause: err });
    }
    if (controller.signal.aborted) {
      return new SceneError('aborted', 'The scene check was cancelled.', { cause: err });
    }
    const detail = err && err.message ? err.message : String(err);
    return new SceneError('network', `Could not reach the API: ${detail}`, { cause: err });
  };

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    // A check cancelled before the frame was ready never makes a request.
    if (controller.signal.aborted) throw transportError(abortError());
    let res;
    try {
      res = await race(fetchImpl(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: controller.signal,
      }));
    } catch (err) {
      throw transportError(err);
    }
    if (!res || typeof res !== 'object') {
      throw new SceneError('network', 'fetch returned no response.');
    }

    // The body read is raced too: a stalled download should also time out.
    let payload = null;
    try {
      payload = await race(res.json());
    } catch (err) {
      if (timedOut || controller.signal.aborted) throw transportError(err);
      payload = null; // not JSON (an HTML error page, say); decided by status below
    }
    if (!res.ok) throw httpError(res.status, payload);
    if (payload === null) throw new SceneError('bad_response', 'The API answer was not JSON.');
    return parseResponse(payload);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', forwardAbort);
  }
}

/**
 * Browser only: draw a video or canvas frame onto a canvas scaled so its
 * longest edge is `maxEdge` px (never upscaled) and encode it as a JPEG Blob.
 */
export async function frameToJpegBlob(source, maxEdge = config.SCENE.maxEdge, quality = config.SCENE.jpegQuality) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new Error('frameToJpegBlob needs a browser (canvas and toBlob).');
  }
  if (!source) throw new Error('frameToJpegBlob: no frame source.');
  // A <video> only has pixels once readyState >= HAVE_CURRENT_DATA (2);
  // drawing it earlier gives a black or empty frame.
  if (typeof source.readyState === 'number' && 'videoWidth' in source && source.readyState < 2) {
    throw new Error('The camera has not produced a frame yet.');
  }
  const sw = source.videoWidth || source.naturalWidth || source.width || 0;
  const sh = source.videoHeight || source.naturalHeight || source.height || 0;
  if (!(sw > 0 && sh > 0)) throw new Error('The frame source has no size yet.');

  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2d canvas context.');
  ctx.drawImage(source, 0, 0, w, h);

  const blob = await new Promise((resolve, reject) => {
    try {
      canvas.toBlob(resolve, 'image/jpeg', quality);
    } catch (err) {
      reject(err);
    }
  });
  if (!blob) throw new Error('The browser could not encode the frame as JPEG.');
  return blob;
}

/**
 * Blob -> base64 string without the data: prefix. FileReader in the browser
 * (streams large blobs without building a binary string), Buffer in Node.
 * Also accepts bytes (Uint8Array/ArrayBuffer) and passes strings through.
 */
export function blobToBase64(blob) {
  if (typeof blob === 'string') return Promise.resolve(stripDataUrl(blob));
  if (!blob) return Promise.reject(new TypeError('blobToBase64: nothing to encode'));
  if (typeof FileReader === 'function' && typeof Blob === 'function' && blob instanceof Blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(stripDataUrl(String(reader.result)));
      reader.onerror = () => reject(reader.error || new Error('Could not read the frame.'));
      reader.readAsDataURL(blob);
    });
  }
  return bytesOf(blob).then(bytesToBase64);
}

// ---------------------------------------------------------------------------
// helpers

function stripDataUrl(s) {
  return s.startsWith('data:') ? s.slice(s.indexOf(',') + 1) : s;
}

function apiErrorMessage(payload) {
  return payload && payload.error && typeof payload.error.message === 'string' ? payload.error.message : '';
}

/** Map an HTTP failure to a SceneError. The API's own message is kept when the body had one. */
function httpError(status, payload) {
  const apiMessage = apiErrorMessage(payload);
  const tail = apiMessage ? `: ${apiMessage}` : ` (HTTP ${status})`;
  if (status === 401 || status === 403) return new SceneError('auth', `The API rejected the key${tail}`, { status });
  if (status === 429) return new SceneError('rate_limited', `Rate limited by the API${tail}`, { status });
  // Other 4xx (400 bad request, 404 unknown model, 413 image too large) are
  // faults in the request, not connectivity, so they read as bad_response.
  if (status >= 400 && status < 500) return new SceneError('bad_response', `The API rejected the request${tail}`, { status });
  return new SceneError('network', `The API is unavailable${tail}`, { status });
}

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The scene check was aborted.', 'AbortError');
  const err = new Error('The scene check was aborted.');
  err.name = 'AbortError';
  return err;
}

/** Number in [0, 1] from a number or numeric string; null when it is neither. */
function toConfidence(raw) {
  const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/** Collapse whitespace (the model may wrap lines) and trim. */
function squash(s) {
  return s.replace(/\s+/g, ' ').trim();
}

async function bytesOf(blob) {
  if (blob instanceof Uint8Array) return blob;
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  throw new TypeError('blobToBase64: unsupported input');
}

function bytesToBase64(bytes) {
  if (typeof Buffer === 'function') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  // A browser without FileReader: btoa over a binary string, built in chunks
  // so String.fromCharCode never sees a huge argument list.
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
}
