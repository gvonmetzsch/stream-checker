// Unit tests for docs/verdict.js: every code, the precedence rules, the delta
// thresholds at their boundaries, and the copy contract (names, bearings,
// headline length, shareText, no emoji, no invented measurements).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as config from '../docs/config.js';
import { CODES, TONES, HEADLINE_MAX, decide, describeBearing } from '../docs/verdict.js';

// ---------------------------------------------------------------------------
// fixtures

const FLOW = { angleDeg: 45, speed: 1.2, consistency: 0.86, coverage: 0.5, shake: 0.4, frames: 55, meanDx: 0.8, meanDy: -0.8 };
const CREEK = { bearing: 112, name: 'Johnson Creek', kind: 'stream', distanceM: 140, confidence: 'high', exempt: false, reason: 'nearest waterway', wayId: 101 };
const CANAL = { ...CREEK, name: 'Mill Canal', kind: 'canal', confidence: 'medium', wayId: 102 };
const TIDAL_CHANNEL = { ...CREEK, name: 'Mud Slough', kind: 'tidal_channel', exempt: true, reason: 'tidal_channel', wayId: 103 };
const LAKE = { name: 'Blue Lake', kind: 'lake', distanceM: 25, contains: false };
const ELEV = (drop) => [-600, -300, -150, 0, 150, 300, 600].map((d) => ({ distanceM: d, elevation: 100 - (drop * d) / 1200 }));
const TERRAIN_DOWN = { verdict: 'downhill', dropM: 4.2, slope: -0.0035, elevations: ELEV(4.2), confidence: 'low' };
const TERRAIN_UP = { verdict: 'uphill', dropM: -3.1, slope: 0.0026, elevations: ELEV(-3.1), confidence: 'low' };
const TERRAIN_FLAT = { verdict: 'flat', dropM: 0.4, slope: -0.0003, elevations: ELEV(0.4), confidence: 'low' };
const SCENE = (over) => ({ scene: 'flowing_water', bodyType: 'creek', label: 'a rocky creek', confidence: 0.91, quip: 'Water, doing its thing.', model: 'claude-opus-5-5', ...over });
const RUG = SCENE({ scene: 'not_water', bodyType: 'other', label: 'a living-room carpet', confidence: 0.93, quip: 'That is a rug. Rugs do not flow.' });
const PUDDLE = SCENE({ scene: 'still_water', bodyType: 'puddle', label: 'a parking-lot puddle', confidence: 0.88, quip: 'A puddle. Majestic.' });
const OCEAN = SCENE({ scene: 'flowing_water', bodyType: 'ocean', label: 'open sea', confidence: 0.97, quip: 'The sea. It does both ways.' });

/** A flowing, mapped, compass-ok check: the RIGHT case. Override to reach the others. */
const mk = (over = {}) => ({
  motion: 'flowing',
  flow: FLOW,
  flowBearing: 118,
  compass: { status: 'ok', headingTrue: 73 },
  location: { lat: 45.462, lon: -122.598, accuracy: 12 },
  expected: CREEK,
  water: { lake: null, coast: null },
  terrain: null,
  scene: null,
  mapStatus: 'live',
  ...over,
});

/** One representative input per code. */
const MATRIX = [
  ['RIGHT', mk()],
  ['WRONG', mk({ flowBearing: 290 })],
  ['SIDEWAYS', mk({ flowBearing: 200 })],
  ['TERRAIN_RIGHT', mk({ expected: null, terrain: TERRAIN_DOWN })],
  ['TERRAIN_WRONG', mk({ expected: null, terrain: TERRAIN_UP })],
  ['TERRAIN_FLAT', mk({ expected: null, terrain: TERRAIN_FLAT })],
  ['UNVERIFIED', mk({ expected: null, mapStatus: 'unavailable' })],
  ['STILL_LAKE', mk({ motion: 'still', expected: null, water: { lake: LAKE, coast: null } })],
  ['STILL_STREAM', mk({ motion: 'still', flow: { ...FLOW, speed: 0.1 } })],
  ['STILL_UNKNOWN', mk({ motion: 'still', expected: null, flow: { ...FLOW, speed: 0.1 } })],
  ['TIDAL', mk({ water: { lake: null, coast: { distanceM: 120 } } })],
  ['NOT_WATER', mk({ scene: RUG })],
  ['NO_TEXTURE', mk({ motion: 'no_texture', flow: { ...FLOW, coverage: 0.05 } })],
  ['SHAKY', mk({ motion: 'shaky', flow: { ...FLOW, shake: 4.1 } })],
  ['NO_COMPASS', mk({ compass: { status: 'denied', headingTrue: null }, flowBearing: null })],
  ['INSUFFICIENT', mk({ motion: 'insufficient', flow: { ...FLOW, frames: 4 } })],
];

const EMOJI = /\p{Extended_Pictographic}/u;
const TONE_OF = {
  good: ['RIGHT', 'TERRAIN_RIGHT', 'STILL_LAKE', 'TIDAL'],
  bad: ['WRONG', 'TERRAIN_WRONG', 'STILL_STREAM', 'NOT_WATER'],
  warn: ['SIDEWAYS', 'SHAKY', 'NO_TEXTURE', 'NO_COMPASS', 'INSUFFICIENT'],
  neutral: ['TERRAIN_FLAT', 'UNVERIFIED', 'STILL_UNKNOWN'],
};

// ---------------------------------------------------------------------------
// contract surface

test('CODES matches the contract list and every code has a tone', () => {
  assert.deepEqual(CODES, [
    'RIGHT', 'WRONG', 'SIDEWAYS', 'TERRAIN_RIGHT', 'TERRAIN_WRONG', 'TERRAIN_FLAT', 'UNVERIFIED',
    'STILL_LAKE', 'STILL_STREAM', 'STILL_UNKNOWN', 'TIDAL', 'NOT_WATER', 'NO_TEXTURE', 'SHAKY', 'NO_COMPASS', 'INSUFFICIENT',
  ]);
  for (const [tone, codes] of Object.entries(TONE_OF)) {
    for (const code of codes) assert.equal(TONES[code], tone, `${code} tone`);
  }
  assert.equal(Object.keys(TONES).length, CODES.length);
});

test('describeBearing uses the 16-point rose and a degree sign', () => {
  assert.equal(describeBearing(41), 'NE (41°)');
  assert.equal(describeBearing(112), 'ESE (112°)');
  assert.equal(describeBearing(118), 'ESE (118°)');
  assert.equal(describeBearing(290), 'WNW (290°)');
  assert.equal(describeBearing(0), 'N (0°)');
  assert.equal(describeBearing(359.6), 'N (0°)');
  assert.equal(describeBearing(-90), 'W (270°)');
  assert.equal(describeBearing(450), 'E (90°)');
  assert.equal(describeBearing(11.3), 'NNE (11°)');
  assert.equal(describeBearing(NaN), 'unknown');
  assert.equal(describeBearing(null), 'unknown');
});

// ---------------------------------------------------------------------------
// the matrix: every code, with the shared copy rules

test('every code is produced by its representative input', () => {
  const seen = new Set();
  for (const [expectedCode, input] of MATRIX) {
    const v = decide(input);
    assert.equal(v.code, expectedCode);
    seen.add(v.code);
  }
  for (const code of CODES) assert.ok(seen.has(code), `matrix covers ${code}`);
});

for (const [code, input] of MATRIX) {
  test(`${code}: shape, tone, headline length, shareText, no emoji`, () => {
    const v = decide(input);
    assert.deepEqual(Object.keys(v).sort(), [
      'code', 'delta', 'detail', 'expectedBearing', 'headline', 'measuredBearing', 'shareText', 'source', 'streamName', 'tone',
    ].sort());
    assert.equal(v.tone, TONES[code]);
    assert.ok(['good', 'bad', 'warn', 'neutral'].includes(v.tone));
    assert.equal(typeof v.headline, 'string');
    assert.ok(v.headline.length > 0 && v.headline.length <= HEADLINE_MAX, `headline "${v.headline}" is ${v.headline.length} chars`);
    assert.equal(HEADLINE_MAX, 40);
    assert.equal(typeof v.detail, 'string');
    assert.ok(v.detail.length > 20, 'detail says something');
    assert.ok(!v.detail.includes('undefined') && !v.detail.includes('NaN') && !v.detail.includes('null'), v.detail);
    assert.ok(!v.headline.includes('undefined') && !v.headline.includes('NaN'), v.headline);
    assert.equal(typeof v.shareText, 'string');
    assert.ok(v.shareText.startsWith('Stream Checker: '), v.shareText);
    assert.ok(!v.shareText.includes('\n'), 'shareText is one line');
    assert.ok(!v.shareText.includes('undefined') && !v.shareText.includes('NaN'), v.shareText);
    for (const text of [v.headline, v.detail, v.shareText]) assert.ok(!EMOJI.test(text), `no emoji in "${text}"`);
    assert.ok(['osm', 'terrain', 'none'].includes(v.source));
    assert.ok(v.delta === null || (v.delta >= 0 && v.delta <= 180));
    assert.ok(v.measuredBearing === null || (v.measuredBearing >= 0 && v.measuredBearing < 360));
    assert.ok(v.expectedBearing === null || (v.expectedBearing >= 0 && v.expectedBearing < 360));
  });
}

// ---------------------------------------------------------------------------
// per-code wording and numbers

test('RIGHT names the stream, both bearings, the distance and the consistency', () => {
  const v = decide(mk());
  assert.equal(v.code, 'RIGHT');
  assert.equal(v.tone, 'good');
  assert.equal(v.headline, 'Stream status: CORRECT.');
  assert.match(v.detail, /Johnson Creek/);
  assert.match(v.detail, /ESE \(112°\)/);
  assert.match(v.detail, /ESE \(118°\)/);
  assert.match(v.detail, /140 m/);
  assert.match(v.detail, /86%/);
  assert.match(v.detail, /Nature is behaving\./);
  assert.equal(v.measuredBearing, 118);
  assert.equal(v.expectedBearing, 112);
  assert.equal(v.delta, 6);
  assert.equal(v.source, 'osm');
  assert.equal(v.streamName, 'Johnson Creek');
  assert.match(v.shareText, /Johnson Creek/);
  assert.match(v.shareText, /right direction \(ESE\)/);
  // Headline names the waterway kind; copy adapts to a river.
  assert.equal(decide(mk({ expected: { ...CREEK, kind: 'river' } })).headline, 'River status: CORRECT.');
});

test('WRONG names the stream, both bearings and asks for an adult', () => {
  const v = decide(mk({ flowBearing: 290 }));
  assert.equal(v.code, 'WRONG');
  assert.equal(v.tone, 'bad');
  assert.equal(v.headline, 'WRONG WAY.');
  assert.match(v.detail, /Johnson Creek/);
  assert.match(v.detail, /should flow ESE \(112°\)/);
  assert.match(v.detail, /heading WNW \(290°\)/);
  assert.match(v.detail, /178° off/);
  assert.match(v.detail, /Please alert someone\./);
  assert.equal(v.measuredBearing, 290);
  assert.equal(v.expectedBearing, 112);
  assert.equal(v.delta, 178);
  assert.equal(v.source, 'osm');
  assert.match(v.shareText, /Johnson Creek/);
  assert.match(v.shareText, /WRONG WAY/);
  assert.match(v.shareText, /WNW/);
  assert.match(v.shareText, /ESE/);
});

test('SIDEWAYS reports the offset and suggests reframing', () => {
  const v = decide(mk({ flowBearing: 200 }));
  assert.equal(v.code, 'SIDEWAYS');
  assert.equal(v.tone, 'warn');
  assert.equal(v.delta, 88);
  assert.match(v.detail, /Johnson Creek/);
  assert.match(v.detail, /ESE \(112°\)/);
  assert.match(v.detail, /SSW \(200°\)/);
  assert.match(v.detail, /88° off/);
  assert.match(v.detail, /try again/);
  assert.match(v.shareText, /sideways/);
});

test('unnamed waterways are described by kind, never as "undefined"', () => {
  const v = decide(mk({ expected: { ...CREEK, name: null, kind: 'brook' } }));
  assert.equal(v.code, 'RIGHT');
  assert.match(v.detail, /^An unnamed brook/);
  assert.match(v.shareText, /an unnamed brook/);
  assert.equal(v.streamName, null);
  assert.equal(v.headline, 'Brook status: CORRECT.');
  const w = decide(mk({ expected: { ...CREEK, name: '', kind: undefined }, flowBearing: 290 }));
  assert.match(w.detail, /^An unnamed waterway/);
});

test('canals (medium confidence) soften WRONG and SIDEWAYS, and RIGHT credits the operator', () => {
  const wrong = decide(mk({ expected: CANAL, flowBearing: 290 }));
  assert.equal(wrong.code, 'WRONG');
  assert.equal(wrong.headline, 'Probably WRONG WAY.');
  assert.match(wrong.detail, /Mill Canal/);
  assert.match(wrong.detail, /Canals are mapped loosely/);
  assert.doesNotMatch(wrong.detail, /Please alert someone/);

  const side = decide(mk({ expected: CANAL, flowBearing: 200 }));
  assert.equal(side.code, 'SIDEWAYS');
  assert.match(side.detail, /map's fault/);

  const right = decide(mk({ expected: CANAL }));
  assert.equal(right.code, 'RIGHT');
  assert.equal(right.headline, 'Canal status: CORRECT.');
  assert.match(right.detail, /whoever runs this canal/);

  const sure = decide(mk({ flowBearing: 290 }));
  assert.equal(sure.headline, 'WRONG WAY.');
});

test('delta thresholds at the boundaries: 60 RIGHT, 61 SIDEWAYS, 119 SIDEWAYS, 120 WRONG (both sides)', () => {
  assert.equal(config.ANGLE.rightMax, 60);
  assert.equal(config.ANGLE.wrongMin, 120);
  const at = (flowBearing) => decide(mk({ flowBearing }));
  // clockwise of the mapped 112°
  assert.equal(at(112 + 60).code, 'RIGHT');
  assert.equal(at(112 + 60).delta, 60);
  assert.equal(at(112 + 61).code, 'SIDEWAYS');
  assert.equal(at(112 + 61).delta, 61);
  assert.equal(at(112 + 119).code, 'SIDEWAYS');
  assert.equal(at(112 + 119).delta, 119);
  assert.equal(at(112 + 120).code, 'WRONG');
  assert.equal(at(112 + 120).delta, 120);
  // anticlockwise, wrapping through north
  assert.equal(at(112 - 60).code, 'RIGHT');
  assert.equal(at(112 - 61).code, 'SIDEWAYS');
  assert.equal(at(112 - 119 + 360).code, 'SIDEWAYS');
  assert.equal(at(112 - 120 + 360).code, 'WRONG');
  assert.equal(at(112 - 120 + 360).delta, 120);
  // exact match and exact opposite
  assert.equal(at(112).delta, 0);
  assert.equal(at(292).delta, 180);
  assert.equal(at(292).code, 'WRONG');
  // fractional bearings right on the line do not straddle it through float noise
  assert.equal(decide(mk({ expected: { ...CREEK, bearing: 112.3 }, flowBearing: 172.3 })).code, 'RIGHT');
  assert.equal(decide(mk({ expected: { ...CREEK, bearing: 112.3 }, flowBearing: 232.3 })).code, 'WRONG');
  // bearings outside [0, 360) are normalised before comparing
  assert.equal(decide(mk({ flowBearing: 118 + 720 })).code, 'RIGHT');
  assert.equal(decide(mk({ flowBearing: -70 })).code, 'WRONG');
  assert.equal(decide(mk({ flowBearing: -70 })).measuredBearing, 290);
});

test('TERRAIN_* explain the coarse estimate with the drop, span and heading', () => {
  const down = decide(mk({ expected: null, terrain: TERRAIN_DOWN }));
  assert.equal(down.code, 'TERRAIN_RIGHT');
  assert.equal(down.tone, 'good');
  assert.equal(down.source, 'terrain');
  assert.match(down.detail, /Nothing is mapped within 200 m/);
  assert.match(down.detail, /coarse terrain estimate/);
  assert.match(down.detail, /drops 4\.2 m over 1200 m/);
  assert.match(down.detail, /ESE \(118°\)/);
  assert.equal(down.measuredBearing, 118);
  assert.equal(down.expectedBearing, null);
  assert.equal(down.delta, null);
  assert.equal(down.streamName, null);
  assert.match(down.shareText, /downhill/);

  const up = decide(mk({ expected: null, terrain: TERRAIN_UP }));
  assert.equal(up.code, 'TERRAIN_WRONG');
  assert.equal(up.tone, 'bad');
  assert.match(up.detail, /rises 3\.1 m over 1200 m/);
  assert.match(up.detail, /uphill/);
  assert.match(up.shareText, /uphill/);

  const flat = decide(mk({ expected: null, terrain: TERRAIN_FLAT }));
  assert.equal(flat.code, 'TERRAIN_FLAT');
  assert.equal(flat.tone, 'neutral');
  assert.match(flat.detail, /flat/);
  assert.match(flat.detail, /0\.4 m/);
  assert.match(flat.detail, /I'll allow it/);

  // Map unreachable: the terrain line must not claim "nothing is mapped".
  const noMap = decide(mk({ expected: null, terrain: TERRAIN_DOWN, mapStatus: 'unavailable' }));
  assert.match(noMap.detail, /^The map was unreachable/);
  assert.doesNotMatch(noMap.detail, /Nothing is mapped/);

  // Missing elevation list and drop: no span or drop numbers are invented.
  const bare = decide(mk({ expected: null, terrain: { verdict: 'downhill', confidence: 'low' } }));
  assert.equal(bare.code, 'TERRAIN_RIGHT');
  assert.doesNotMatch(bare.detail, /\d+ m over/);
  assert.match(bare.detail, /runs downhill/);

  // An unknown terrain verdict is not a verdict.
  assert.equal(decide(mk({ expected: null, terrain: { verdict: 'sideways' } })).code, 'UNVERIFIED');
});

test('UNVERIFIED says why the map did not help and still reports the bearing', () => {
  const unreachable = decide(mk({ expected: null, mapStatus: 'unavailable' }));
  assert.equal(unreachable.code, 'UNVERIFIED');
  assert.equal(unreachable.tone, 'neutral');
  assert.equal(unreachable.headline, 'Flowing ESE. Unverified.');
  assert.match(unreachable.detail, /ESE \(118°\)/);
  assert.match(unreachable.detail, /86% consistency/);
  assert.match(unreachable.detail, /reach the map/);
  assert.match(unreachable.detail, /I'll allow it/);
  assert.equal(unreachable.measuredBearing, 118);
  assert.equal(unreachable.source, 'none');
  assert.match(unreachable.shareText, /Can't reach the map/);

  const skipped = decide(mk({ expected: null, mapStatus: 'skipped', location: null }));
  assert.equal(skipped.code, 'UNVERIFIED');
  assert.match(skipped.detail, /no location fix/i);
  assert.match(skipped.shareText, /No location/);

  const empty = decide(mk({ expected: null, mapStatus: 'live' }));
  assert.equal(empty.code, 'UNVERIFIED');
  assert.match(empty.detail, /Nothing is mapped within 200 m/);
  assert.match(empty.shareText, /Nothing mapped here/);
});

test('STILL_LAKE from the map names the lake and its distance; "contains" is worded as being in it', () => {
  const v = decide(mk({ motion: 'still', expected: null, water: { lake: LAKE, coast: null } }));
  assert.equal(v.code, 'STILL_LAKE');
  assert.equal(v.tone, 'good');
  assert.equal(v.headline, 'Lake detected. Exempt.');
  assert.match(v.detail, /Blue Lake/);
  assert.match(v.detail, /25 m away/);
  assert.match(v.detail, /Lakes don't go anywhere/);
  assert.equal(v.source, 'osm');
  assert.equal(v.streamName, 'Blue Lake');
  assert.equal(v.measuredBearing, null);
  assert.match(v.shareText, /Blue Lake/);
  assert.match(v.shareText, /exempt/i);

  const inIt = decide(mk({ motion: 'still', expected: null, water: { lake: { ...LAKE, contains: true, distanceM: 0 }, coast: null } }));
  assert.match(inIt.detail, /you appear to be in it/);

  const pond = decide(mk({ motion: 'still', expected: null, water: { lake: { name: null, kind: 'pond', distanceM: 8, contains: false }, coast: null } }));
  assert.equal(pond.headline, 'Pond detected. Exempt.');
  assert.match(pond.detail, /^An unnamed pond/);
  assert.equal(pond.streamName, null);

  const plain = decide(mk({ motion: 'still', expected: null, water: { lake: { name: 'Mirror Pool', kind: 'water', distanceM: 3, contains: false }, coast: null } }));
  assert.equal(plain.headline, 'Lake detected. Exempt.');
});

test('STILL_LAKE from the scene check alone (no map lake) credits Claude and has no map source', () => {
  const v = decide(mk({ motion: 'still', expected: null, scene: SCENE({ scene: 'still_water', bodyType: 'pond', label: 'a garden pond', confidence: 0.9 }) }));
  assert.equal(v.code, 'STILL_LAKE');
  assert.equal(v.headline, 'Pond detected. Exempt.');
  assert.match(v.detail, /Claude says this is a pond \(90% sure\)/);
  assert.equal(v.source, 'none');
  assert.equal(v.streamName, null);
  assert.match(v.shareText, /pond/);
});

test('STILL_STREAM names the stream and its mapped bearing', () => {
  const v = decide(mk({ motion: 'still', flow: { ...FLOW, speed: 0.1 } }));
  assert.equal(v.code, 'STILL_STREAM');
  assert.equal(v.tone, 'bad');
  assert.equal(v.headline, 'SUSPICIOUSLY STILL.');
  assert.match(v.detail, /Johnson Creek is supposed to be flowing ESE \(112°\) here/);
  assert.match(v.detail, /barely moving \(0\.1 px per frame\)/);
  assert.match(v.detail, /Pool, dam, dry season, or you filmed the bank\./);
  assert.equal(v.expectedBearing, 112);
  assert.equal(v.measuredBearing, null);
  assert.equal(v.delta, null);
  assert.equal(v.source, 'osm');
  assert.equal(v.streamName, 'Johnson Creek');
  assert.match(v.shareText, /Johnson Creek/);

  // Still because of inconsistency rather than speed: the consistency number is the one quoted.
  const swirl = decide(mk({ motion: 'still', flow: { ...FLOW, speed: 0.9, consistency: 0.31 } }));
  assert.match(swirl.detail, /31% consistent/);
  assert.doesNotMatch(swirl.detail, /px per frame/);
});

test('STILL_UNKNOWN: puddle-class by default, named when the scene check knows better', () => {
  const v = decide(mk({ motion: 'still', expected: null, flow: { ...FLOW, speed: 0.1 } }));
  assert.equal(v.code, 'STILL_UNKNOWN');
  assert.equal(v.tone, 'neutral');
  assert.equal(v.headline, 'Puddle-class water.');
  assert.match(v.detail, /No lake is mapped within 60 m and no stream within 200 m/);
  assert.match(v.detail, /Puddle, pond, bathtub: all exempt\./);
  assert.equal(v.source, 'none');
  assert.match(v.shareText, /puddle-class/i);

  const puddle = decide(mk({ motion: 'still', expected: null, scene: PUDDLE, flow: { ...FLOW, speed: 0.1 } }));
  assert.equal(puddle.code, 'STILL_UNKNOWN');
  assert.equal(puddle.headline, "That's a puddle.");
  assert.match(puddle.detail, /a parking-lot puddle/);
  assert.match(puddle.detail, /88% sure/);
  assert.match(puddle.detail, /Puddles are exempt\./);
  assert.match(puddle.shareText, /puddle/);

  const sink = decide(mk({ motion: 'still', expected: null, scene: SCENE({ scene: 'still_water', bodyType: 'sink', label: 'a kitchen sink' }) }));
  assert.equal(sink.headline, "That's a sink.");

  // Claude sees a creek but nothing moves and nothing is mapped: inconclusive, not exempt.
  const dry = decide(mk({ motion: 'still', expected: null, scene: SCENE({ scene: 'still_water', bodyType: 'creek', label: 'a dry creek bed' }), flow: { ...FLOW, speed: 0.1 } }));
  assert.equal(dry.code, 'STILL_UNKNOWN');
  assert.equal(dry.headline, 'Still water, unmapped.');
  assert.match(dry.detail, /a dry creek bed/);
  assert.match(dry.detail, /Dry season/);

  // Map unreachable: do not claim nothing is mapped.
  const noMap = decide(mk({ motion: 'still', expected: null, mapStatus: 'unavailable' }));
  assert.match(noMap.detail, /map was unreachable/);
  assert.doesNotMatch(noMap.detail, /is mapped within/);
});

test('TIDAL from the coast, a tidal channel or the scene check', () => {
  const coast = decide(mk({ water: { lake: null, coast: { distanceM: 120 } } }));
  assert.equal(coast.code, 'TIDAL');
  assert.equal(coast.tone, 'good');
  assert.equal(coast.headline, 'Tidal. Both directions are correct.');
  assert.match(coast.detail, /The coast is 120 m away\./);
  assert.match(coast.detail, /Waves go both ways/);
  assert.match(coast.detail, /heading ESE \(118°\)/);
  assert.equal(coast.measuredBearing, 118);
  assert.equal(coast.expectedBearing, null);
  assert.equal(coast.source, 'osm');
  assert.match(coast.shareText, /tidal/i);

  const channel = decide(mk({ expected: TIDAL_CHANNEL }));
  assert.equal(channel.code, 'TIDAL');
  assert.match(channel.detail, /Mud Slough is mapped as tidal/);
  assert.equal(channel.streamName, 'Mud Slough');
  assert.equal(channel.source, 'osm');

  const sea = decide(mk({ expected: null, scene: OCEAN }));
  assert.equal(sea.code, 'TIDAL');
  assert.match(sea.detail, /Claude says this is the ocean \(97% sure\)/);
  assert.equal(sea.source, 'none');

  const stillSea = decide(mk({ motion: 'still', expected: null, water: { lake: null, coast: { distanceM: 40 } } }));
  assert.equal(stillSea.code, 'TIDAL');
  assert.match(stillSea.detail, /not moving at all, which is also allowed/);
  assert.equal(stillSea.measuredBearing, null);
});

test('NOT_WATER quotes the label and confidence and declines', () => {
  const v = decide(mk({ scene: RUG }));
  assert.equal(v.code, 'NOT_WATER');
  assert.equal(v.tone, 'bad');
  assert.equal(v.headline, 'NOT WATER. Verdict: declined.');
  assert.match(v.detail, /a living-room carpet/);
  assert.match(v.detail, /93% sure/);
  assert.match(v.detail, /not water/);
  assert.equal(v.measuredBearing, null);
  assert.equal(v.expectedBearing, null);
  assert.equal(v.source, 'none');
  assert.equal(v.streamName, null);
  assert.match(v.shareText, /a living-room carpet, not water/);
  // No confidence: none is quoted.
  const vague = decide(mk({ scene: { scene: 'not_water', bodyType: 'other', label: 'a wall', quip: '' } }));
  assert.doesNotMatch(vague.detail, /% sure/);
  assert.match(vague.detail, /a wall/);
});

test('NO_TEXTURE, SHAKY and INSUFFICIENT quote the number that tripped them', () => {
  const tex = decide(mk({ motion: 'no_texture', flow: { ...FLOW, coverage: 0.05 } }));
  assert.equal(tex.code, 'NO_TEXTURE');
  assert.equal(tex.tone, 'warn');
  assert.equal(tex.headline, "Can't see detail.");
  assert.match(tex.detail, /Only 5% of the frame/);
  assert.match(tex.detail, /glare/);
  assert.equal(tex.measuredBearing, null);
  assert.equal(tex.source, 'none');

  const shaky = decide(mk({ motion: 'shaky', flow: { ...FLOW, shake: 4.1 } }));
  assert.equal(shaky.code, 'SHAKY');
  assert.equal(shaky.headline, 'Hold still.');
  assert.match(shaky.detail, /shake score 2\.8, limit 0\.6/);
  assert.match(shaky.detail, /4 seconds/);

  const few = decide(mk({ motion: 'insufficient', flow: { ...FLOW, frames: 4 } }));
  assert.equal(few.code, 'INSUFFICIENT');
  assert.equal(few.headline, 'Not enough footage.');
  assert.match(few.detail, /Only 4 frame pairs were analysed/);
  assert.match(decide(mk({ motion: 'insufficient', flow: { ...FLOW, frames: 1 } })).detail, /Only 1 frame pair was analysed/);
  assert.match(decide(mk({ motion: 'insufficient', flow: {} })).detail, /Too few frame pairs were analysed/);
});

test('NO_COMPASS reports the on-screen direction, the reason, and the mapped bearing for what it is worth', () => {
  const denied = decide(mk({ compass: { status: 'denied', headingTrue: null }, flowBearing: null }));
  assert.equal(denied.code, 'NO_COMPASS');
  assert.equal(denied.tone, 'warn');
  assert.equal(denied.headline, 'No compass. No verdict.');
  assert.match(denied.detail, /moving up and to the right \(86% consistent\)/);
  assert.match(denied.detail, /Motion access was denied/);
  assert.match(denied.detail, /Johnson Creek is mapped flowing ESE \(112°\)/);
  assert.equal(denied.measuredBearing, null);
  assert.equal(denied.expectedBearing, 112);
  assert.equal(denied.delta, null);
  assert.equal(denied.source, 'none');
  assert.equal(denied.streamName, 'Johnson Creek');
  assert.match(denied.shareText, /up and to the right/);
  assert.match(denied.shareText, /no compass/);

  const unsupported = decide(mk({ compass: { status: 'unsupported', headingTrue: null }, flowBearing: null, expected: null, flow: { ...FLOW, angleDeg: 180 } }));
  assert.match(unsupported.detail, /moving down the screen/);
  assert.match(unsupported.detail, /no compass heading/);
  assert.doesNotMatch(unsupported.detail, /for what it's worth/);

  const unreliable = decide(mk({ compass: { status: 'unreliable', headingTrue: 73 } }));
  assert.equal(unreliable.code, 'NO_COMPASS');
  assert.match(unreliable.detail, /figure 8/);

  // Compass fine but no bearing came through: still no verdict, no invented bearing.
  const missing = decide(mk({ flowBearing: null }));
  assert.equal(missing.code, 'NO_COMPASS');
  assert.match(missing.detail, /No heading was recorded/);
  assert.equal(missing.measuredBearing, null);

  // Nothing about the flow angle known: no direction is invented.
  const blind = decide(mk({ compass: { status: 'denied' }, flowBearing: null, flow: {} }));
  assert.match(blind.detail, /^The water is moving, but/);
});

// ---------------------------------------------------------------------------
// precedence

test('precedence: scene not_water beats every motion gate and map feature', () => {
  assert.equal(decide(mk({ scene: RUG, motion: 'insufficient' })).code, 'NOT_WATER');
  assert.equal(decide(mk({ scene: RUG, motion: 'shaky', water: { lake: null, coast: { distanceM: 10 } } })).code, 'NOT_WATER');
  assert.equal(decide(mk({ scene: RUG, motion: 'still', water: { lake: LAKE, coast: null } })).code, 'NOT_WATER');
  assert.equal(decide(mk({ scene: RUG, compass: { status: 'denied' }, flowBearing: null })).code, 'NOT_WATER');
});

test('precedence: motion gates beat tidal, still and flowing verdicts', () => {
  const coast = { lake: null, coast: { distanceM: 10 } };
  assert.equal(decide(mk({ motion: 'insufficient', water: coast })).code, 'INSUFFICIENT');
  assert.equal(decide(mk({ motion: 'no_texture', water: coast })).code, 'NO_TEXTURE');
  assert.equal(decide(mk({ motion: 'shaky', expected: null, water: { lake: null, coast: null } })).code, 'SHAKY');
  assert.equal(decide(mk({ motion: 'no_texture', expected: TIDAL_CHANNEL })).code, 'NO_TEXTURE');
  assert.equal(decide(mk({ motion: 'insufficient', compass: { status: 'denied' }, flowBearing: null })).code, 'INSUFFICIENT');
  // Exempt places win over "hold still": wind ripples on a lake or at the coast
  // look like camera shake, and the verdict there does not depend on the motion.
  assert.equal(decide(mk({ motion: 'shaky', water: coast })).code, 'TIDAL');
  assert.equal(decide(mk({ motion: 'shaky', scene: OCEAN })).code, 'TIDAL');
  assert.equal(decide(mk({ motion: 'shaky', water: { lake: LAKE, coast: null } })).code, 'STILL_LAKE');
});

test('precedence: tidal beats still and flowing; lake beats stream when still; compass beats map; map beats terrain', () => {
  assert.equal(decide(mk({ motion: 'still', expected: TIDAL_CHANNEL })).code, 'TIDAL');
  assert.equal(decide(mk({ motion: 'still', water: { lake: LAKE, coast: { distanceM: 50 } } })).code, 'TIDAL');
  assert.equal(decide(mk({ scene: OCEAN, flowBearing: 290 })).code, 'TIDAL');
  assert.equal(decide(mk({ motion: 'still', water: { lake: LAKE, coast: null } })).code, 'STILL_LAKE', 'lake wins over the mapped stream when still');
  assert.equal(decide(mk({ motion: 'still', scene: SCENE({ scene: 'still_water', bodyType: 'lake' }) })).code, 'STILL_LAKE', 'scene lake wins over the mapped stream when still');
  assert.equal(decide(mk({ compass: { status: 'unreliable', headingTrue: 73 }, terrain: TERRAIN_DOWN })).code, 'NO_COMPASS');
  assert.equal(decide(mk({ terrain: TERRAIN_DOWN })).code, 'RIGHT', 'a mapped stream outranks the terrain fallback');
  assert.equal(decide(mk({ terrain: TERRAIN_UP, flowBearing: 290 })).code, 'WRONG');
  // A mapped waterway without a usable bearing is not a map verdict.
  assert.equal(decide(mk({ expected: { ...CREEK, bearing: null }, terrain: TERRAIN_DOWN })).code, 'TERRAIN_RIGHT');
  assert.equal(decide(mk({ expected: { ...CREEK, bearing: NaN } })).code, 'UNVERIFIED');
});

test('the scene check never overrides measured motion except for not_water and ocean', () => {
  // Claude says still, the pixels say flowing: the pixels win.
  assert.equal(decide(mk({ scene: SCENE({ scene: 'still_water', bodyType: 'lake' }) })).code, 'RIGHT');
  // Claude says flowing, the pixels say still: still.
  assert.equal(decide(mk({ motion: 'still', scene: SCENE({ scene: 'flowing_water', bodyType: 'creek' }) })).code, 'STILL_STREAM');
  // A scene error object stored in place of a result is ignored.
  assert.equal(decide(mk({ scene: { error: 'timeout', message: 'slow' } })).code, 'RIGHT');
});

// ---------------------------------------------------------------------------
// robustness and honesty

test('decide tolerates missing and malformed input without throwing', () => {
  assert.equal(decide().code, 'INSUFFICIENT');
  assert.equal(decide(null).code, 'INSUFFICIENT');
  assert.equal(decide({}).code, 'INSUFFICIENT');
  assert.equal(decide({ motion: 'flowing' }).code, 'NO_COMPASS');
  assert.equal(decide({ motion: 'flowing', flowBearing: 10, compass: { status: 'ok' } }).code, 'UNVERIFIED');
  assert.equal(decide({ motion: 'still' }).code, 'STILL_UNKNOWN');
  assert.equal(decide({ motion: 'nonsense' }).code, 'INSUFFICIENT');
  for (const v of [decide(), decide({ motion: 'flowing' }), decide({ motion: 'still' }), decide({ motion: 'flowing', flowBearing: 10, compass: { status: 'ok' } })]) {
    assert.ok(v.headline.length <= HEADLINE_MAX);
    assert.ok(!/undefined|NaN|null/.test(v.detail), v.detail);
    assert.ok(v.shareText.startsWith('Stream Checker: '));
  }
  // mapStatus missing: infer 'live' from features, 'unavailable' otherwise.
  assert.match(decide({ motion: 'flowing', flowBearing: 10, compass: { status: 'ok' } }).detail, /reach the map/);
  assert.equal(decide({ motion: 'flowing', flowBearing: 118, compass: { status: 'ok' }, expected: CREEK }).code, 'RIGHT');
});

test('copy never claims a measurement that was not made', () => {
  const noStats = decide(mk({ flow: {} }));
  assert.equal(noStats.code, 'RIGHT');
  assert.doesNotMatch(noStats.detail, /%/);
  const noDist = decide(mk({ expected: { ...CREEK, distanceM: undefined } }));
  assert.doesNotMatch(noDist.detail, /\d+ m/);
  const unverified = decide(mk({ expected: null, mapStatus: 'unavailable', flow: {} }));
  assert.doesNotMatch(unverified.detail, /consistency/);
  const lakeNoDist = decide(mk({ motion: 'still', expected: null, water: { lake: { name: 'Blue Lake', kind: 'lake' }, coast: null } }));
  assert.doesNotMatch(lakeNoDist.detail, /\d+ m/);
  const coastNoDist = decide(mk({ water: { lake: null, coast: {} } }));
  assert.match(coastNoDist.detail, /The coast is right here\./);
  const shakyNoScore = decide(mk({ motion: 'shaky', flow: {} }));
  assert.doesNotMatch(shakyNoScore.detail, /shake \d/);
  const blind = decide(mk({ motion: 'no_texture', flow: {} }));
  assert.match(blind.detail, /^Too little of the frame/);
});

test('headlines are clamped to 40 characters even for absurd map kinds', () => {
  const v = decide(mk({ motion: 'still', expected: null, water: { lake: { name: 'X', kind: 'an_extremely_long_water_kind_value_from_osm', distanceM: 5 }, coast: null } }));
  assert.ok(v.headline.length <= HEADLINE_MAX, v.headline);
  assert.ok(v.headline.endsWith('…'));
});
