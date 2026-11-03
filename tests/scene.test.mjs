// Unit tests for docs/scene.js: request shape, response parsing, HTTP/timeout mapping.
// Every network call is mocked; nothing here talks to api.anthropic.com.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as config from '../docs/config.js';
import {
  SCENE_SCHEMA,
  SCENE_VALUES,
  BODY_TYPES,
  SYSTEM_PROMPT,
  QUESTION,
  SceneError,
  supportsServerFallback,
  buildRequest,
  parseResponse,
  classifyScene,
  blobToBase64,
  frameToJpegBlob,
} from '../docs/scene.js';

const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const JPEG_B64 = Buffer.from(JPEG_BYTES).toString('base64');
const KEY = 'sk-ant-test-key';
const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';

const jpegBlob = () => new Blob([JPEG_BYTES], { type: 'image/jpeg' });

const GOOD = { scene: 'flowing_water', bodyType: 'creek', label: 'a rocky creek', confidence: 0.91, quip: 'Water, doing its thing.' };

/** A Messages API reply shaped like the real thing. */
const reply = (fields = GOOD, over = {}) => ({
  id: 'msg_01',
  type: 'message',
  role: 'assistant',
  model: OPUS,
  stop_reason: 'end_turn',
  stop_sequence: null,
  content: [{ type: 'text', text: JSON.stringify(fields) }],
  usage: { input_tokens: 420, output_tokens: 64 },
  ...over,
});

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const apiError = (type, message) => ({ type: 'error', error: { type, message } });

/** fetch stand-in that records each call and answers from `responder`. */
function mockFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return typeof responder === 'function' ? responder(url, init) : responder;
  };
  fn.calls = calls;
  return fn;
}

const rejectsWithCode = (promise, code, messageRe) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof SceneError, `expected SceneError, got ${err && err.constructor && err.constructor.name}: ${err && err.message}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code} (${err.message})`);
    if (messageRe) assert.match(err.message, messageRe);
    return true;
  });

// ---------------------------------------------------------------------------
// schema and request

test('SCENE_SCHEMA is a closed object with the five required fields and the enums', () => {
  assert.equal(SCENE_SCHEMA.type, 'object');
  assert.equal(SCENE_SCHEMA.additionalProperties, false);
  assert.deepEqual([...SCENE_SCHEMA.required].sort(), ['bodyType', 'confidence', 'label', 'quip', 'scene']);
  assert.deepEqual(Object.keys(SCENE_SCHEMA.properties).sort(), ['bodyType', 'confidence', 'label', 'quip', 'scene']);
  assert.deepEqual(SCENE_SCHEMA.properties.scene.enum, ['flowing_water', 'still_water', 'not_water']);
  assert.deepEqual(SCENE_SCHEMA.properties.bodyType.enum, [
    'river', 'stream', 'creek', 'canal', 'waterfall', 'lake', 'pond', 'puddle', 'ocean', 'pool', 'fountain', 'sink', 'other',
  ]);
  assert.equal(SCENE_SCHEMA.properties.confidence.type, 'number');
  assert.equal(SCENE_SCHEMA.properties.label.type, 'string');
  assert.equal(SCENE_SCHEMA.properties.quip.type, 'string');
  // Numeric and string-length constraints are rejected by the API; they must not appear.
  const text = JSON.stringify(SCENE_SCHEMA);
  for (const banned of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern']) {
    assert.ok(!text.includes(`"${banned}"`), `schema must not use ${banned}`);
  }
  assert.ok(Object.isFrozen(SCENE_SCHEMA) && Object.isFrozen(SCENE_SCHEMA.properties.scene));
  assert.deepEqual(SCENE_VALUES, SCENE_SCHEMA.properties.scene.enum);
  assert.deepEqual(BODY_TYPES, SCENE_SCHEMA.properties.bodyType.enum);
});

test('supportsServerFallback is true for Opus 5.5 only', () => {
  assert.equal(supportsServerFallback(OPUS), true);
  assert.equal(supportsServerFallback('claude-opus-5-5-20260401'), true);
  assert.equal(supportsServerFallback(HAIKU), false);
  assert.equal(supportsServerFallback('claude-sonnet-5-5'), false);
  assert.equal(supportsServerFallback(undefined), false);
});

test('buildRequest: Opus 5.5 gets the server-side fallback header and field', () => {
  const req = buildRequest(JPEG_B64, { model: OPUS, apiKey: KEY });
  assert.equal(req.url, config.SCENE.apiUrl);
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(req.headers, {
    'content-type': 'application/json',
    'x-api-key': KEY,
    'anthropic-version': config.SCENE.apiVersion,
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-beta': config.SCENE.fallbackBeta,
  });
  assert.equal(req.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(req.body.fallbacks, 'default');
  assert.equal(req.body.model, OPUS);
  assert.equal(req.body.max_tokens, config.SCENE.maxTokens);
  assert.equal(req.body.system, SYSTEM_PROMPT);
  assert.match(req.body.system, /Stream Checker/);
  assert.match(req.body.system, /joke app/);
  assert.match(req.body.system, /visible/);
  assert.deepEqual(req.body.messages, [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG_B64 } },
        { type: 'text', text: QUESTION },
      ],
    },
  ]);
  assert.match(QUESTION, /0 to 1/);
  assert.match(QUESTION, /90 characters/);
  assert.deepEqual(req.body.output_config, {
    effort: 'low',
    format: { type: 'json_schema', schema: SCENE_SCHEMA },
  });
  // Nothing the current API rejects, and no assistant prefill.
  for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'tools', 'tool_choice', 'stream']) {
    assert.ok(!(key in req.body), `body must not carry ${key}`);
  }
  assert.ok(req.body.messages.every((m) => m.role === 'user'));
  assert.deepEqual(Object.keys(req.body).sort(), ['fallbacks', 'max_tokens', 'messages', 'model', 'output_config', 'system']);
  assert.equal(typeof JSON.stringify(req.body), 'string');
});

test('buildRequest: Haiku 5.5 gets neither the beta header nor the fallbacks field', () => {
  const req = buildRequest(JPEG_B64, { model: HAIKU, apiKey: KEY });
  assert.equal(req.body.model, HAIKU);
  assert.ok(!('anthropic-beta' in req.headers));
  assert.ok(!('fallbacks' in req.body));
  assert.deepEqual(Object.keys(req.headers).sort(), [
    'anthropic-dangerous-direct-browser-access', 'anthropic-version', 'content-type', 'x-api-key',
  ]);
  assert.deepEqual(Object.keys(req.body).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system']);
});

test('buildRequest: defaults to the configured model, strips a data: URL prefix and trims the key', () => {
  const req = buildRequest(`data:image/jpeg;base64,${JPEG_B64}`, { apiKey: `  ${KEY}\n` });
  assert.equal(req.body.model, config.SCENE.models.default);
  assert.equal(req.body.messages[0].content[0].source.data, JPEG_B64);
  assert.equal(req.headers['x-api-key'], KEY);
  const empty = buildRequest(JPEG_B64, { model: '', apiKey: KEY });
  assert.equal(empty.body.model, config.SCENE.models.default);
});

test('buildRequest: a missing key is an auth error and a missing image a TypeError', () => {
  assert.throws(() => buildRequest(JPEG_B64, { model: OPUS }), (err) => err instanceof SceneError && err.code === 'auth');
  assert.throws(() => buildRequest(JPEG_B64, { model: OPUS, apiKey: '   ' }), (err) => err.code === 'auth');
  assert.throws(() => buildRequest('', { model: OPUS, apiKey: KEY }), TypeError);
  assert.throws(() => buildRequest(undefined, { model: OPUS, apiKey: KEY }), TypeError);
});

// ---------------------------------------------------------------------------
// parseResponse

test('parseResponse: happy path returns the five fields plus the model', () => {
  assert.deepEqual(parseResponse(reply()), { ...GOOD, model: OPUS });
});

test('parseResponse: skips thinking and fallback blocks and finds the first text block', () => {
  const json = reply(GOOD, {
    model: 'claude-opus-4-8',
    content: [
      { type: 'thinking', thinking: '', signature: 'x' },
      { type: 'fallback', from: { model: OPUS }, to: { model: 'claude-opus-4-8' } },
      { type: 'text', text: JSON.stringify({ ...GOOD, scene: 'still_water' }) },
      { type: 'text', text: 'ignored second block' },
    ],
  });
  const out = parseResponse(json);
  assert.equal(out.scene, 'still_water');
  assert.equal(out.model, 'claude-opus-4-8');
});

test('parseResponse: refusal -> SceneError refusal carrying the explanation', () => {
  const json = reply(GOOD, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'nope' } });
  assert.throws(() => parseResponse(json), (err) => err instanceof SceneError && err.code === 'refusal' && /nope/.test(err.message));
  assert.throws(() => parseResponse(reply(GOOD, { stop_reason: 'refusal', stop_details: null })), (err) => err.code === 'refusal');
});

test('parseResponse: max_tokens -> bad_response', () => {
  assert.throws(() => parseResponse(reply(GOOD, { stop_reason: 'max_tokens' })), (err) => err.code === 'bad_response' && /max_tokens/.test(err.message));
});

test('parseResponse: invalid JSON, non-object JSON and a missing text block -> bad_response', () => {
  const bad = (over) => assert.throws(() => parseResponse(reply(GOOD, over)), (err) => err instanceof SceneError && err.code === 'bad_response');
  bad({ content: [{ type: 'text', text: '{"scene": "flowing_water",' }] });
  bad({ content: [{ type: 'text', text: 'Sure! Here is the JSON: {}' }] });
  bad({ content: [{ type: 'text', text: '[1, 2]' }] });
  bad({ content: [{ type: 'text', text: 'null' }] });
  bad({ content: [{ type: 'thinking', thinking: 'only thoughts' }] });
  bad({ content: [] });
  bad({ content: undefined });
  assert.throws(() => parseResponse(null), (err) => err.code === 'bad_response');
  assert.throws(() => parseResponse('text'), (err) => err.code === 'bad_response');
});

test('parseResponse: out-of-enum values and wrong field types -> bad_response', () => {
  const bad = (fields) => assert.throws(() => parseResponse(reply(fields)), (err) => err instanceof SceneError && err.code === 'bad_response');
  bad({ ...GOOD, scene: 'wet' });
  bad({ ...GOOD, scene: undefined });
  bad({ ...GOOD, bodyType: 'bathtub' });
  bad({ ...GOOD, bodyType: 7 });
  bad({ ...GOOD, label: 12 });
  bad({ ...GOOD, quip: null });
  bad({ ...GOOD, confidence: 'very' });
  bad({ ...GOOD, confidence: undefined });
});

test('parseResponse: clamps confidence to 0..1, accepts numeric strings and tidies text', () => {
  assert.equal(parseResponse(reply({ ...GOOD, confidence: 1.7 })).confidence, 1);
  assert.equal(parseResponse(reply({ ...GOOD, confidence: -0.2 })).confidence, 0);
  assert.equal(parseResponse(reply({ ...GOOD, confidence: '0.42' })).confidence, 0.42);
  const tidy = parseResponse(reply({ ...GOOD, label: '  a\n rocky   creek ', quip: ' Flowing.\n Allegedly. ' }));
  assert.equal(tidy.label, 'a rocky creek');
  assert.equal(tidy.quip, 'Flowing. Allegedly.');
  // An empty label falls back to the body type so the card never shows a blank.
  assert.equal(parseResponse(reply({ ...GOOD, label: '' })).label, 'creek');
  assert.equal(parseResponse(reply(GOOD, { model: undefined })).model, null);
});

test('parseResponse: an API error object -> bad_response with its message', () => {
  assert.throws(() => parseResponse(apiError('invalid_request_error', 'messages: roles must alternate')),
    (err) => err.code === 'bad_response' && /roles must alternate/.test(err.message));
});

// ---------------------------------------------------------------------------
// classifyScene with a mocked fetch

test('classifyScene: 200 -> SceneResult, and the request on the wire is well-formed', async () => {
  const fetchImpl = mockFetch(() => jsonResponse(200, reply()));
  const result = await classifyScene(jpegBlob(), { apiKey: KEY, model: OPUS, fetchImpl });
  assert.deepEqual(result, { ...GOOD, model: OPUS });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, config.SCENE.apiUrl);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-api-key'], KEY);
  assert.equal(init.headers['anthropic-version'], config.SCENE.apiVersion);
  assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(init.headers['anthropic-beta'], config.SCENE.fallbackBeta);
  assert.equal(init.headers['content-type'], 'application/json');
  assert.ok(init.signal instanceof AbortSignal, 'request carries an AbortSignal');
  const body = JSON.parse(init.body);
  assert.equal(body.model, OPUS);
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.messages[0].content[0].source.data, JPEG_B64, 'the blob bytes are sent as base64');
  assert.equal(body.messages[0].content[0].source.media_type, 'image/jpeg');
  assert.equal(body.output_config.format.type, 'json_schema');
});

test('classifyScene: the default model is Opus 5.5 with the fallback header; Haiku sends neither', async () => {
  const opus = mockFetch(() => jsonResponse(200, reply()));
  await classifyScene(jpegBlob(), { apiKey: KEY, fetchImpl: opus });
  assert.equal(JSON.parse(opus.calls[0].init.body).model, 'claude-opus-5-5');
  assert.equal(opus.calls[0].init.headers['anthropic-beta'], config.SCENE.fallbackBeta);

  const haiku = mockFetch(() => jsonResponse(200, reply(GOOD, { model: HAIKU })));
  const out = await classifyScene(jpegBlob(), { apiKey: KEY, model: HAIKU, fetchImpl: haiku });
  assert.equal(out.model, HAIKU);
  const init = haiku.calls[0].init;
  assert.ok(!('anthropic-beta' in init.headers));
  assert.ok(!('fallbacks' in JSON.parse(init.body)));
});

test('classifyScene: HTTP status mapping (401/403 auth, 429 rate_limited, 4xx bad_response, 5xx network)', async () => {
  const cases = [
    [401, 'auth', apiError('authentication_error', 'invalid x-api-key'), /invalid x-api-key/],
    [403, 'auth', apiError('permission_error', 'Your API key does not have permission'), /permission/],
    [429, 'rate_limited', apiError('rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit'), /rate limit/i],
    [400, 'bad_response', apiError('invalid_request_error', 'max_tokens: must be positive'), /max_tokens: must be positive/],
    [404, 'bad_response', apiError('not_found_error', 'model: claude-nope'), /claude-nope/],
    [413, 'bad_response', apiError('request_too_large', 'Request exceeds the maximum size'), /maximum size/],
    [500, 'network', apiError('api_error', 'An unexpected error has occurred'), /unexpected error/],
    [503, 'network', apiError('api_error', 'Service unavailable'), /unavailable/i],
    [529, 'network', apiError('overloaded_error', 'Overloaded'), /Overloaded/],
  ];
  for (const [status, code, body, re] of cases) {
    const fetchImpl = mockFetch(() => jsonResponse(status, body));
    await rejectsWithCode(classifyScene(jpegBlob(), { apiKey: KEY, fetchImpl }), code, re);
    await assert.rejects(classifyScene(jpegBlob(), { apiKey: KEY, fetchImpl }), (err) => err.status === status);
  }
});

test('classifyScene: error statuses without a JSON body still map by status', async () => {
  const html = (status) => mockFetch(() => new Response('<html>nope</html>', { status, headers: { 'content-type': 'text/html' } }));
  await rejectsWithCode(classifyScene(jpegBlob(), { apiKey: KEY, fetchImpl: html(401) }), 'auth', /HTTP 401/);
  await rejectsWithCode(classifyScene(jpegBlob(), { apiKey: KEY, fetchImpl: html(429) }), 'rate_limited', /HTTP 429/);
  await rejectsWithCode(classifyScene(jpegBlob(), { apiKey: KEY, fetchImpl: html(502) }), 'network', /HTTP 502/);
});

test('classifyScene: a 200 that is not JSON, or JSON of the wrong shape, is bad_response', async () => {
  const html = mockFetch(() => new Response('<html>cached</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  await rejectsWithCode(classifyScene(jpegBlob(), { apiKey: KEY, fetchImpl: html }), 'bad_response');
  const wrong = mockFetch(() => jsonResponse(200, reply({ ...GOOD, scene: 'damp' })));
  await rejectsWithCode(classifyScene(jpegBlob(), { apiKey: KEY, fetchImpl: wrong }), 'bad_response');
  const refused = mockFetch(() => jsonResponse(200, reply(GOOD, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } })));
  await rejectsWithCode(classifyScene(jpegBlob(), { apiKey: KEY, fetchImpl: refused }), 'refusal');
});

test('classifyScene: a thrown fetch (offline, DNS, CORS) is a network error that keeps the cause', async () => {
  const fetchImpl = mockFetch(() => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(classifyScene(jpegBlob(), { apiKey: KEY, fetchImpl }), (err) => {
    assert.equal(err.code, 'network');
    assert.match(err.message, /Failed to fetch/);
    assert.ok(err.cause instanceof TypeError);
    return true;
  });
  const rejecting = mockFetch(() => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')));
  await rejectsWithCode(classifyScene(jpegBlob(), { apiKey: KEY, fetchImpl: rejecting }), 'network', /DISCONNECTED/);
});

test('classifyScene: a fetch that never settles times out', async () => {
  const t0 = Date.now();
  const hanging = mockFetch(() => new Promise(() => {}));
  await rejectsWithCode(classifyScene(jpegBlob(), { apiKey: KEY, fetchImpl: hanging, timeoutMs: 25 }), 'timeout');
  assert.ok(Date.now() - t0 < 2000, 'timed out promptly');
});

test('classifyScene: a fetch that honours its signal times out with code timeout, not network', async () => {
  let sawSignal = null;
  const polite = mockFetch((url, init) => new Promise((_, reject) => {
    sawSignal = init.signal;
    init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  }));
  await rejectsWithCode(classifyScene(jpegBlob(), { apiKey: KEY, fetchImpl: polite, timeoutMs: 25 }), 'timeout', /25 s|0 s/);
  assert.ok(sawSignal && sawSignal.aborted, 'the request signal was aborted');
});

test('classifyScene: a body read that stalls also times out', async () => {
  const stalled = mockFetch(() => ({ ok: true, status: 200, json: () => new Promise(() => {}) }));
  await rejectsWithCode(classifyScene(jpegBlob(), { apiKey: KEY, fetchImpl: stalled, timeoutMs: 25 }), 'timeout');
});

test("classifyScene: the caller's signal cancels the request (aborted, not timeout)", async () => {
  const controller = new AbortController();
  let requestSignal = null;
  const polite = mockFetch((url, init) => new Promise((_, reject) => {
    requestSignal = init.signal;
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const pending = classifyScene(jpegBlob(), { apiKey: KEY, fetchImpl: polite, signal: controller.signal, timeoutMs: 5000 });
  setTimeout(() => controller.abort(), 5);
  await rejectsWithCode(pending, 'aborted');
  assert.ok(requestSignal.aborted, 'the abort was forwarded to the HTTP request');

  // Already-aborted signal: no request is made at all.
  const done = new AbortController();
  done.abort();
  const never = mockFetch(() => jsonResponse(200, reply()));
  await rejectsWithCode(classifyScene(jpegBlob(), { apiKey: KEY, fetchImpl: never, signal: done.signal }), 'aborted');
  assert.equal(never.calls.length, 0);
});

test('classifyScene: a missing key fails before any network call', async () => {
  const fetchImpl = mockFetch(() => jsonResponse(200, reply()));
  await rejectsWithCode(classifyScene(jpegBlob(), { fetchImpl }), 'auth');
  await rejectsWithCode(classifyScene(jpegBlob(), { apiKey: '', fetchImpl }), 'auth');
  assert.equal(fetchImpl.calls.length, 0);
});

test('classifyScene: no fetch available -> network error', async () => {
  await rejectsWithCode(classifyScene(jpegBlob(), { apiKey: KEY, fetchImpl: undefined }), 'network');
});

// ---------------------------------------------------------------------------
// encoding helpers

test('blobToBase64: Node Blob, raw bytes, ArrayBuffer and strings', async () => {
  assert.equal(await blobToBase64(jpegBlob()), JPEG_B64);
  assert.equal(await blobToBase64(JPEG_BYTES), JPEG_B64);
  assert.equal(await blobToBase64(JPEG_BYTES.buffer.slice(0)), JPEG_B64);
  assert.equal(await blobToBase64(JPEG_B64), JPEG_B64);
  assert.equal(await blobToBase64(`data:image/jpeg;base64,${JPEG_B64}`), JPEG_B64);
  // A subarray view must encode only its own bytes.
  const view = JPEG_BYTES.subarray(2, 6);
  assert.equal(await blobToBase64(view), Buffer.from(view).toString('base64'));
  await assert.rejects(blobToBase64(null), TypeError);
  await assert.rejects(blobToBase64({}), TypeError);
});

test('frameToJpegBlob: refuses to run outside a browser', async () => {
  await assert.rejects(frameToJpegBlob({ videoWidth: 640, videoHeight: 480, readyState: 4 }), /browser/);
});

test('SceneError carries name, code, status and cause', () => {
  const cause = new Error('root');
  const err = new SceneError('network', 'boom', { status: 503, cause });
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'SceneError');
  assert.equal(err.code, 'network');
  assert.equal(err.status, 503);
  assert.equal(err.cause, cause);
  assert.equal(new SceneError('auth', 'x').status, null);
});
