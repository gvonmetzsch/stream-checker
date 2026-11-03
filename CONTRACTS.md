# Module contracts

Every module is a browser ES module under `docs/`, importable from Node for tests
(no DOM access at import time; browser-only code lives inside functions and is
guarded). Shared constants come from `docs/config.js`. Angles are degrees unless
stated. Bearings are compass bearings: 0 = north, 90 = east, in [0, 360).
Points are `{lat, lon}` objects.

## docs/flow.js — optical flow (pure)

```js
export function toGray(imageData)            // ImageData-like {data,width,height} -> Uint8ClampedArray(width*height)
export function estimateFlow(prev, curr, width, height, opts = {})
// prev, curr: Uint8ClampedArray grayscale of the same size.
// opts: { block, stride, range, minVariance, returnVectors } (defaults from config.FLOW)
// -> { dx, dy, accepted, total, vectors }
//    dx, dy: median displacement of accepted blocks, px per frame pair, image axes (x right, y down); NaN when accepted === 0
//    accepted: blocks that passed the texture gate and had a clear SAD minimum; total: blocks evaluated
//    vectors: [{x, y, dx, dy}] block centres and vectors (only when returnVectors)
export class FlowAccumulator {
  constructor(opts = {})                     // thresholds from config.FLOW, overridable
  add(result)                                // result from estimateFlow; pairs with accepted === 0 count toward coverage only
  reset()
  get frames()                               // pairs added
  result()
  // -> { angleDeg, speed, consistency, coverage, shake, frames, meanDx, meanDy }
  //    angleDeg: direction of flow, 0 = up the screen, clockwise positive (right = 90, down = 180); null when no accepted pairs
  //    speed: mean magnitude of accepted per-pair vectors, px/frame
  //    consistency: mean resultant length of the per-pair unit vectors, 0..1
  //    coverage: mean of accepted/total over pairs, 0..1
  //    shake: mean squared deviation of per-pair vectors from the mean vector (px^2) — oscillating camera motion raises it
}
export function classifyMotion(result, thresholds = config.FLOW)
// -> 'flowing' | 'still' | 'no_texture' | 'shaky' | 'insufficient'
//   insufficient: frames < 10; no_texture: coverage < minCoverage; shaky: shake > maxShake;
//   still: speed < minSpeed or consistency < minConsistency; else flowing
export function imageAngleToBearing(angleDeg, screenUpHeading)   // (screenUpHeading + angleDeg) mod 360
```

## docs/compass.js — heading (browser + pure helpers)

```js
export function topEdgeHeading(alpha, beta)          // (360 - alpha) mod 360 when cos(beta) > 0, (180 - alpha) mod 360 when cos(beta) < 0, null near |beta| = 90
export function cameraAxisHeading(alpha, beta, gamma)// W3C DeviceOrientation appendix A.1 formula; null when beta and gamma are both ~0
export function blendedHeading(alpha, beta, gamma)   // weight topEdge by |cos(beta)*cos(gamma)| (screen normal vertical component), cameraAxis by the rest; circular weighted mean; null if both null
export function headingFromEvent(ev)
// ev: a DeviceOrientationEvent-like object. iOS: numeric ev.webkitCompassHeading with ev.webkitCompassAccuracy >= 0 -> {heading, source:'ios', accuracy}
// Android/Firefox: ev.absolute === true and numeric alpha -> {heading: blendedHeading(...), source:'android', accuracy:null}
// otherwise {heading:null, source:'none', accuracy:null}. Always returns pitch = beta, roll = gamma (null if absent).
// Heading is MAGNETIC and refers to screen-up only after screenUpHeading().
export function screenUpHeading(deviceTopHeading, screenAngle)   // (deviceTopHeading + screenAngle) mod 360; screenAngle from screen.orientation.angle (0/90/180/270)
export function circularMean(degreesArray)            // -> { mean (0..360) | null, R (0..1) }
export function tiltOk(pitch, cfg = config.COMPASS)   // true when pitchMin <= |pitch| <= pitchMax
export function createCompass(opts = {})
// -> {
//   requestPermission(): Promise<'granted'|'denied'|'unsupported'>,  // MUST be called inside a click handler; calls DeviceOrientationEvent.requestPermission(true) when it exists
//   start(), stop(),
//   current(): { headingMag, source, accuracy, pitch, roll, tiltOk, updatedAt },   // latest sample, headingMag already screen-up corrected
//   beginWindow(), endWindow(): { headingMag, samples, R },   // circular mean of samples since beginWindow (screen-up corrected, magnetic)
//   onUpdate(fn): unsubscribe                                   // fn(current())
// }
```

## docs/declination.js — World Magnetic Model (pure)

```js
export const WMM_EPOCH            // e.g. 2025.0
export function declination(lat, lon, altitudeKm = 0, date = new Date())  // degrees, east positive
export function magneticToTrue(headingMag, lat, lon, date = new Date())  // (headingMag + declination) mod 360
```

## docs/geo.js — geometry (pure)

```js
export function normalizeDeg(d)                       // -> [0, 360)
export function angleDiff(a, b)                       // signed smallest difference a - b in (-180, 180]
export function absAngleDiff(a, b)                    // 0..180
export function toCardinal(deg, points = 16)          // 'N', 'NNE', ...
export function haversineM(a, b)
export function bearingDeg(a, b)                      // initial bearing from a to b
export function destination(p, bearing, distanceM)    // -> {lat, lon}
export function localProjection(origin)               // -> { toXY(p) -> {x, y} metres east/north, fromXY({x,y}) -> {lat, lon} }
export function nearestSegment(point, geometry)       // geometry: [{lat,lon}] polyline -> { distanceM, index, bearing, closest } | null (bearing of segment index -> index+1, i.e. node order)
export function pointInPolygon(point, ring)           // ring: [{lat,lon}] closed or open
export function distanceToPolyline(point, geometry)   // metres
```

## docs/waterways.js — map lookups

```js
export function buildQuery(point, radii = config.RADIUS)      // Overpass QL per the plan (waterways out tags geom; water/coast out tags center; is_in areas out tags)
export function buildAreaQuery(center, radiusM)               // offline cache query: everything within radius with clipped geometry (out geom(bbox))
export function parseOverpass(json)                           // -> Features
// Features = {
//   waterways: [{ id, name, kind, tags, geometry:[{lat,lon}], bidirectional }],  // kind = waterway tag value; bidirectional when tidal_channel / tidal=yes / flow_direction=both
//   waterAreas: [{ id, name, kind, tags, center, geometry }],  // kind = tags.water || 'water'; geometry only when the response had it
//   coastlines: [{ id, tags, center, geometry }],
//   containing: [{ id, name, kind, tags }],                   // areas from is_in that contain the point
//   timestamp: string|null, remark: string|null
// }
export async function fetchFeatures(point, { fetchImpl = fetch, hosts = config.OVERPASS_HOSTS, timeoutMs, signal, query } = {})
// tries hosts in order; throws OverpassError { code: 'all_hosts_failed' | 'rate_limited' | 'aborted', attempts: [...] }
// resolves { ...Features, host, source: 'live', stale: boolean, fetchedAt }
export function expectedFlow(features, point, radii = config.RADIUS)
// -> { bearing, name, kind, distanceM, confidence: 'high'|'medium'|'low', exempt, reason, wayId } | null
//    nearest waterway within radii.waterway; bearing from node order at the nearest segment; confidence: river/stream high, canal/drain/ditch medium; exempt when bidirectional
export function nearbyWater(features, point, radii = config.RADIUS)
// -> { lake: { name, kind, distanceM, contains } | null, coast: { distanceM } | null }
export function fitSlope(distances, elevations)                 // least squares -> { slope (m per m), intercept, r2 }
export async function terrainSlope(point, bearing, { fetchImpl = fetch, distances = config.TERRAIN_DISTANCES_M, signal } = {})
// one Open-Meteo request for the point and +/- distances along bearing
// -> { verdict: 'downhill'|'uphill'|'flat', dropM (positive when it drops along bearing over the span), slope, elevations:[{distanceM, elevation}], confidence: 'low' } | null on any failure
```

## docs/offline.js — IndexedDB cache (browser) + pure filter

```js
export function filterFeatures(all, point, radii = config.RADIUS)   // pure: applies the live-query radii to a stored Features set (uses geo.distanceToPolyline / pointInPolygon); sets containing from polygons
export async function saveArea(center, { radiusM = config.RADIUS.offline, fetchImpl = fetch, hosts, onProgress } = {})   // -> { count, bytes, savedAt, center, radiusM }
export async function cachedFeatures(point)                          // -> Features & { source: 'cache', savedAt } | null when no saved area covers the point
export async function savedAreas()                                   // -> [{ id, center, radiusM, savedAt, count, bytes }]
export async function clearSaved()
```

## docs/scene.js — Claude scene check

```js
export const SCENE_SCHEMA                                  // JSON schema (additionalProperties:false everywhere)
export function buildRequest(base64Jpeg, { model, apiKey }) // -> { url, headers, body (object) } pure, testable
export function parseResponse(json)                        // -> SceneResult; throws SceneError on refusal / max_tokens / bad JSON
export async function classifyScene(jpegBlob, { apiKey, model = config.SCENE.models.default, fetchImpl = fetch, signal, timeoutMs } = {})
// -> SceneResult = { scene: 'flowing_water'|'still_water'|'not_water', bodyType: 'river'|'stream'|'creek'|'canal'|'waterfall'|'lake'|'pond'|'puddle'|'ocean'|'pool'|'fountain'|'sink'|'other', label, confidence (0..1), quip, model }
// throws SceneError { code: 'auth'|'network'|'rate_limited'|'refusal'|'bad_response'|'timeout', message }
export async function frameToJpegBlob(source, maxEdge = config.SCENE.maxEdge, quality = config.SCENE.jpegQuality)   // browser: HTMLVideoElement|HTMLCanvasElement -> Blob
export function blobToBase64(blob)                         // browser -> Promise<string> (no data: prefix)
```

## docs/verdict.js — decision + copy (pure)

```js
export const CODES = ['RIGHT','WRONG','SIDEWAYS','TERRAIN_RIGHT','TERRAIN_WRONG','TERRAIN_FLAT','UNVERIFIED','STILL_LAKE','STILL_STREAM','STILL_UNKNOWN','TIDAL','NOT_WATER','NO_TEXTURE','SHAKY','NO_COMPASS','INSUFFICIENT']
export function decide(input)
// input = {
//   motion: 'flowing'|'still'|'no_texture'|'shaky'|'insufficient',
//   flow: FlowAccumulator.result(),
//   flowBearing: number|null,          // true bearing of the water's motion (null when no compass)
//   compass: { status: 'ok'|'denied'|'unsupported'|'unreliable', headingTrue: number|null },
//   location: { lat, lon, accuracy } | null,
//   expected: expectedFlow() | null,
//   water: nearbyWater() | null,
//   terrain: terrainSlope() | null,
//   scene: SceneResult | null,
//   mapStatus: 'live'|'cache'|'unavailable'|'skipped',
// }
// -> { code, tone: 'good'|'bad'|'warn'|'neutral', headline, detail, measuredBearing, expectedBearing, delta, source: 'osm'|'terrain'|'none', streamName, shareText }
// Precedence: scene.not_water -> NOT_WATER; motion insufficient/no_texture/shaky -> those; scene ocean or water.coast or expected.exempt -> TIDAL;
// motion still -> STILL_LAKE (water.lake or scene lake/pond) / STILL_STREAM (expected waterway) / STILL_UNKNOWN; compass missing -> NO_COMPASS;
// expected present -> RIGHT/WRONG/SIDEWAYS by config.ANGLE; else terrain -> TERRAIN_*; else UNVERIFIED.
export function describeBearing(deg)   // "NE (41°)"
```

## docs/demo.js — demo mode (browser + fixtures)

```js
export const DEMO = { location, headingMag, screenAngle, overpass /* raw Overpass JSON */, elevation /* raw Open-Meteo JSON */, angleDeg, speed }
export function createDemoStream({ angleDeg, speed, width = 640, height = 480 } = {})   // -> { stream: MediaStream (canvas.captureStream), stop() }
export function demoFetch(realFetch)   // -> fetchImpl serving DEMO.overpass for Overpass URLs and DEMO.elevation for Open-Meteo URLs; everything else passes through
```

## docs/app.js — orchestration (browser)

Owns the state machine idle -> permissions -> capturing -> analyzing -> judging -> verdict -> idle, the camera plumbing described in the plan, the overlay, settings, history, share, "Save streams near me", and demo mode. Uses only the APIs above.

## DOM and debug hooks (shared by docs/index.html, docs/app.js and the end-to-end tests)

Element ids (must exist with these ids):
- `#app` root; `#state` carries `data-state="idle|permissions|capturing|analyzing|judging|verdict|error"`
- `#video` the camera preview `<video autoplay muted playsinline>`; `#overlay` the `<canvas>` drawn over it
- `#check-button` the big Check button; `#cancel-button` (visible while capturing)
- `#countdown` text or ring showing seconds left; `#status` one-line status text
- `#heading-readout` live compass readout (magnetic heading, cardinal, tilt hint, or "no compass")
- `#verdict` card, with `data-code` set to the verdict code and `data-tone`; inside it `#verdict-headline`, `#verdict-detail`, `#measured-bearing`, `#expected-bearing`, `#verdict-source`, `#share-button`, `#again-button`
- `#history` list of past checks; `#save-area-button` and `#save-area-status` for "Save streams near me"
- `#settings-button` opens `#settings` (a `<dialog>` or sheet) containing `#api-key`, `#model-select` (values `claude-opus-5-5`, `claude-haiku-5-5`), `#scene-toggle` (checkbox), `#sideways-toggle` (checkbox, "camera looks sideways"), `#settings-close`
- `#help-button` opens `#help` with attributions; `#demo-link` enables demo mode

URL parameters: `?demo=1` demo mode (synthetic stream, fixture location/heading, fixture map data, no real network); `?debug=1` shows a debug panel with raw numbers.

`window.__sc` (always present, used by tests): `{ state, lastVerdict, lastFlow, lastHeading, lastLocation, settings, version }` kept up to date by app.js, plus `window.__sc.setFetch(fn)` to inject a fetch implementation for map/elevation/scene calls before a check starts.
