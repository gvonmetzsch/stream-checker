// Verdict: turns one check's measurements and map context into a code, a tone
// and the copy on the card. Pure: no DOM, no network, no clock.
//
// The module imports only config.js. The small angle helpers below duplicate
// geo.js on purpose so the decision logic stays standalone and testable.
//
// Copy rules: playful, dry, confident, short. Headlines are at most 40
// characters. Details use real numbers (bearings, distances, consistency) and
// real names, and never mention a measurement that was not made.

import * as config from './config.js';

export const CODES = [
  'RIGHT', 'WRONG', 'SIDEWAYS',
  'TERRAIN_RIGHT', 'TERRAIN_WRONG', 'TERRAIN_FLAT',
  'UNVERIFIED',
  'STILL_LAKE', 'STILL_STREAM', 'STILL_UNKNOWN',
  'TIDAL', 'NOT_WATER',
  'NO_TEXTURE', 'SHAKY', 'NO_COMPASS', 'INSUFFICIENT',
];

export const TONES = Object.freeze({
  RIGHT: 'good', TERRAIN_RIGHT: 'good', STILL_LAKE: 'good', TIDAL: 'good',
  WRONG: 'bad', TERRAIN_WRONG: 'bad', STILL_STREAM: 'bad', NOT_WATER: 'bad',
  SIDEWAYS: 'warn', SHAKY: 'warn', NO_TEXTURE: 'warn', NO_COMPASS: 'warn', INSUFFICIENT: 'warn',
  TERRAIN_FLAT: 'neutral', UNVERIFIED: 'neutral', STILL_UNKNOWN: 'neutral',
});

export const HEADLINE_MAX = 40;

const MOTIONS = ['flowing', 'still', 'no_texture', 'shaky', 'insufficient'];
const MAP_STATUSES = ['live', 'cache', 'unavailable', 'skipped'];
const DEG = '°';

// Scene body types that are still by nature (exempt) versus ones that ought to move.
const STILL_BY_NATURE = ['puddle', 'pool', 'fountain', 'sink'];
const SHOULD_FLOW = ['river', 'stream', 'creek', 'canal', 'waterfall'];

// ---------------------------------------------------------------------------
// angles (local copies of geo.js helpers, see header)

function normalizeDeg(d) {
  const n = ((d % 360) + 360) % 360;
  return n === 0 ? 0 : n; // folds -0 into +0
}

/** Unsigned smallest difference between two bearings, 0..180. */
function absAngleDiff(a, b) {
  const d = Math.abs(normalizeDeg(a) - normalizeDeg(b));
  return d > 180 ? 360 - d : d;
}

const CARDINALS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

/** 16-point compass name, 22.5° per sector centred on the named bearing. */
function toCardinal(deg) {
  return CARDINALS[Math.round(normalizeDeg(deg) / 22.5) % 16];
}

/** "ESE (112°)"; 'unknown' when there is no bearing. */
export function describeBearing(deg) {
  if (!Number.isFinite(deg)) return 'unknown';
  const rounded = Math.round(normalizeDeg(deg)) % 360; // 359.6 rounds to 360, shown as 0
  return `${toCardinal(deg)} (${rounded}${DEG})`;
}

// Flow angle on screen: 0 = up the screen, clockwise. Used when there is no
// compass and the direction can only be described relative to the phone.
const SCREEN_DIRECTIONS = [
  'up the screen', 'up and to the right', 'to the right', 'down and to the right',
  'down the screen', 'down and to the left', 'to the left', 'up and to the left',
];
function screenDirection(angleDeg) {
  return SCREEN_DIRECTIONS[Math.round(normalizeDeg(angleDeg) / 45) % 8];
}

// ---------------------------------------------------------------------------
// text helpers (each returns null when the number is not there, so the copy
// never claims a measurement that was not made)

const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : null);
const metres = (m) => (Number.isFinite(m) ? `${Math.round(m)} m` : null);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const kindWord = (kind, fallback) => (typeof kind === 'string' && kind.trim() ? kind.trim().replace(/_/g, ' ') : fallback);
const plural = (word) => (/(s|sh|ch|x|z)$/.test(word) ? `${word}es` : `${word}s`);

/** "Johnson Creek" or "an unnamed stream". */
function waterwayName(expected) {
  const name = expected && typeof expected.name === 'string' ? expected.name.trim() : '';
  return name || `an unnamed ${kindWord(expected && expected.kind, 'waterway')}`;
}

/** OSM water=* value as a word; plain natural=water counts as a lake. */
function lakeKind(lake) {
  const k = lake && typeof lake.kind === 'string' ? lake.kind.trim() : '';
  return k && k !== 'water' ? k.replace(/_/g, ' ') : 'lake';
}

function lakeName(lake) {
  const name = lake && typeof lake.name === 'string' ? lake.name.trim() : '';
  return name || `an unnamed ${lakeKind(lake)}`;
}

function sceneLabel(scene) {
  const label = scene && typeof scene.label === 'string' ? scene.label.trim() : '';
  return label || (scene && scene.bodyType ? String(scene.bodyType).replace(/_/g, ' ') : 'something');
}

function sceneSure(scene) {
  const p = scene ? pct(scene.confidence) : null;
  return p ? ` (${p} sure)` : '';
}

/** Why no mapped channel was used, phrased as a clause. */
function noMapClause(c) {
  if (c.mapStatus === 'unavailable') return 'The map was unreachable';
  if (c.mapStatus === 'skipped') return 'There was no location fix, so the map was not consulted';
  return `Nothing is mapped within ${config.RADIUS.waterway} m`;
}

/** Why the motion counted as still, with the number that decided it. */
function stillClause(c) {
  const f = c.flow;
  if (Number.isFinite(f.speed) && f.speed < config.FLOW.minSpeed) {
    return `this water is barely moving (${f.speed.toFixed(1)} px per frame)`;
  }
  if (Number.isFinite(f.consistency)) {
    return `this water is not going anywhere in particular (motion ${pct(f.consistency)} consistent)`;
  }
  return 'this water is not moving';
}

/** The terrain line: "the ground drops 4.2 m over 1200 m along the water's heading, NE (41°)". */
function terrainClause(c) {
  const t = c.terrain;
  const ds = Array.isArray(t.elevations) ? t.elevations.map((e) => e && e.distanceM).filter(Number.isFinite) : [];
  const span = ds.length >= 2 ? Math.round(Math.max(...ds) - Math.min(...ds)) : null;
  const heading = describeBearing(c.flowBearing);
  if (!Number.isFinite(t.dropM)) return `the ground runs ${t.verdict} along the water's heading, ${heading}`;
  const verb = t.dropM > 0 ? 'drops' : t.dropM < 0 ? 'rises' : 'changes by';
  return `the ground ${verb} ${Math.abs(t.dropM).toFixed(1)} m${span ? ` over ${span} m` : ''} along the water's heading, ${heading}`;
}

// ---------------------------------------------------------------------------
// decision

function normalize(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const flow = input.flow && typeof input.flow === 'object' ? input.flow : {};
  const compass = input.compass && typeof input.compass === 'object' ? input.compass : { status: 'unsupported', headingTrue: null };
  const motion = MOTIONS.includes(input.motion) ? input.motion : 'insufficient';
  // A scene object carrying an error (app.js stores failures that way) is no scene at all.
  const scene = input.scene && typeof input.scene === 'object' && !input.scene.error ? input.scene : null;
  const expected = input.expected && typeof input.expected === 'object' ? input.expected : null;
  const water = input.water && typeof input.water === 'object' ? input.water : {};
  const terrain = input.terrain && typeof input.terrain === 'object' ? input.terrain : null;
  const flowBearing = Number.isFinite(input.flowBearing) ? normalizeDeg(input.flowBearing) : null;
  const hasFeatures = !!(expected || water.lake || water.coast);
  const mapStatus = MAP_STATUSES.includes(input.mapStatus) ? input.mapStatus : (hasFeatures ? 'live' : 'unavailable');
  return {
    motion,
    flow,
    compass,
    compassOk: compass.status === 'ok' && flowBearing != null,
    flowBearing,
    expected,
    lake: water.lake || null,
    coast: water.coast || null,
    terrain,
    scene,
    mapStatus,
  };
}

function isTidal(c) {
  return !!((c.scene && c.scene.bodyType === 'ocean') || c.coast || (c.expected && c.expected.exempt));
}

function sceneSaysLake(c) {
  return !!(c.scene && (c.scene.bodyType === 'lake' || c.scene.bodyType === 'pond'));
}

function hasExpectedBearing(c) {
  return !!(c.expected && Number.isFinite(c.expected.bearing));
}

/** |flow - mapped| in 0..180, rounded to 1e-6 so float noise cannot straddle a threshold. */
function deltaOf(c) {
  return Math.round(absAngleDiff(c.flowBearing, c.expected.bearing) * 1e6) / 1e6;
}

function chooseCode(c) {
  if (c.scene && c.scene.scene === 'not_water') return 'NOT_WATER';
  if (c.motion === 'insufficient') return 'INSUFFICIENT';
  if (c.motion === 'no_texture') return 'NO_TEXTURE';
  // Wind ripples on a lake move in every direction at once, which looks like
  // camera shake to the flow estimator; at a mapped lake that is still a lake.
  const atLake = Boolean(c.lake) || sceneSaysLake(c);
  if (c.motion === 'shaky' && !atLake) return 'SHAKY';
  if (isTidal(c)) return 'TIDAL';
  if (c.motion === 'still' || c.motion === 'shaky') {
    if (c.lake || sceneSaysLake(c)) return 'STILL_LAKE';
    if (c.expected) return 'STILL_STREAM';
    return 'STILL_UNKNOWN';
  }
  // flowing
  if (!c.compassOk) return 'NO_COMPASS';
  if (hasExpectedBearing(c)) {
    const delta = deltaOf(c);
    if (delta <= config.ANGLE.rightMax) return 'RIGHT';
    if (delta >= config.ANGLE.wrongMin) return 'WRONG';
    return 'SIDEWAYS';
  }
  if (c.terrain) {
    if (c.terrain.verdict === 'downhill') return 'TERRAIN_RIGHT';
    if (c.terrain.verdict === 'uphill') return 'TERRAIN_WRONG';
    if (c.terrain.verdict === 'flat') return 'TERRAIN_FLAT';
  }
  return 'UNVERIFIED';
}

// ---------------------------------------------------------------------------
// copy, one builder per code -> { headline, detail, shareText }

const COPY = {
  RIGHT(c) {
    const name = waterwayName(c.expected);
    const dist = metres(c.expected.distanceM);
    const cons = pct(c.flow.consistency);
    const soft = c.expected.confidence === 'medium';
    const kind = kindWord(c.expected.kind, 'stream');
    return {
      headline: `${cap(kind)} status: CORRECT.`,
      detail: `${cap(name)}${dist ? ` (${dist} away)` : ''} is mapped flowing ${describeBearing(c.expected.bearing)} here ` +
        `and your water agrees: ${describeBearing(c.flowBearing)}${cons ? `, ${cons} consistent` : ''}. ` +
        (soft ? `Nature, or whoever runs this ${kind}, is behaving.` : 'Nature is behaving.'),
      shareText: `Stream Checker: ${name} is flowing the right direction (${toCardinal(c.flowBearing)}). Phew.`,
    };
  },

  WRONG(c) {
    const name = waterwayName(c.expected);
    const dist = metres(c.expected.distanceM);
    const cons = pct(c.flow.consistency);
    const soft = c.expected.confidence === 'medium';
    const kind = kindWord(c.expected.kind, 'stream');
    return {
      headline: soft ? 'Probably WRONG WAY.' : 'WRONG WAY.',
      detail: `${cap(name)}${dist ? ` (${dist} away)` : ''} should flow ${describeBearing(c.expected.bearing)} ` +
        `but this water is heading ${describeBearing(c.flowBearing)}, ${Math.round(deltaOf(c))}${DEG} off` +
        `${cons ? `, with ${cons} consistency` : ''}. ` +
        (soft
          ? `${cap(plural(kind))} are mapped loosely, so treat this as a probable scandal rather than a certain one.`
          : 'Please alert someone.'),
      shareText: `Stream Checker: ${name} is flowing the WRONG WAY (${toCardinal(c.flowBearing)}, mapped ` +
        `${toCardinal(c.expected.bearing)}). Someone should look into this.`,
    };
  },

  SIDEWAYS(c) {
    const name = waterwayName(c.expected);
    const dist = metres(c.expected.distanceM);
    const soft = c.expected.confidence === 'medium';
    const kind = kindWord(c.expected.kind, 'stream');
    return {
      headline: 'Sideways. Check your framing.',
      detail: `${cap(name)}${dist ? ` (${dist} away)` : ''} is mapped flowing ${describeBearing(c.expected.bearing)}; ` +
        `this water is heading ${describeBearing(c.flowBearing)}, ${Math.round(deltaOf(c))}${DEG} off the channel. ` +
        (soft
          ? `${cap(plural(kind))} are mapped loosely, so this may be the map's fault rather than yours.`
          : `Point the camera along the ${kind} and try again.`),
      shareText: `Stream Checker: ${name} is flowing sideways (${toCardinal(c.flowBearing)}, mapped ` +
        `${toCardinal(c.expected.bearing)}). Inconclusive, but suspicious.`,
    };
  },

  TERRAIN_RIGHT(c) {
    const card = toCardinal(c.flowBearing);
    return {
      headline: 'Downhill. As water should.',
      detail: `${noMapClause(c)}, so this is a coarse terrain estimate: ${terrainClause(c)}. Downhill. Correct.`,
      shareText: `Stream Checker: unmapped water flowing ${card}, which is downhill. Physics holds.`,
    };
  },

  TERRAIN_WRONG(c) {
    const card = toCardinal(c.flowBearing);
    return {
      headline: 'Uphill. Call a physicist.',
      detail: `${noMapClause(c)}, so this is a coarse terrain estimate: ${terrainClause(c)}. ` +
        'Water does not go uphill. Please alert someone.',
      shareText: `Stream Checker: unmapped water flowing ${card}, which is uphill. Please alert someone.`,
    };
  },

  TERRAIN_FLAT(c) {
    const card = toCardinal(c.flowBearing);
    return {
      headline: 'Flat ground. No opinion.',
      detail: `${noMapClause(c)} and the terrain is flat (${terrainClause(c)}), which is not enough to judge. ` +
        `Flowing ${card}. I'll allow it.`,
      shareText: `Stream Checker: water flowing ${card} over flat ground. Unverified, allowed.`,
    };
  },

  UNVERIFIED(c) {
    const card = toCardinal(c.flowBearing);
    const cons = pct(c.flow.consistency);
    let reason;
    let share;
    if (c.mapStatus === 'unavailable') {
      reason = "I couldn't reach the map to check, so I'll allow it.";
      share = "Can't reach the map, so I'll allow it.";
    } else if (c.mapStatus === 'skipped') {
      reason = "There was no location fix, so the map wasn't consulted. I'll allow it.";
      share = "No location, so I'll allow it.";
    } else {
      reason = `Nothing is mapped within ${config.RADIUS.waterway} m and the terrain check didn't come through, so I'll allow it.`;
      share = "Nothing mapped here, so I'll allow it.";
    }
    return {
      headline: `Flowing ${card}. Unverified.`,
      detail: `Water is heading ${describeBearing(c.flowBearing)}${cons ? ` with ${cons} consistency` : ''}. ${reason}`,
      shareText: `Stream Checker: water flowing ${card}. ${share}`,
    };
  },

  STILL_LAKE(c) {
    if (c.lake) {
      const kind = lakeKind(c.lake);
      const name = lakeName(c.lake);
      const dist = metres(c.lake.distanceM);
      const where = c.lake.contains ? ' and you appear to be in it' : (dist ? `, ${dist} away` : '');
      return {
        headline: `${cap(kind)} detected. Exempt.`,
        detail: `${cap(name)} is on the map${where}, and nothing is moving. ` +
          `${cap(plural(kind))} don't go anywhere, so there is nothing to check.`,
        shareText: `Stream Checker: ${name} is a ${kind}. ${cap(plural(kind))} are exempt. Nothing to see here.`,
      };
    }
    const kind = c.scene.bodyType; // 'lake' or 'pond'
    return {
      headline: `${cap(kind)} detected. Exempt.`,
      detail: `Claude says this is a ${kind}${sceneSure(c.scene)} and nothing is moving. ` +
        `${cap(plural(kind))} don't go anywhere, so there is nothing to check.`,
      shareText: `Stream Checker: that's a ${kind}. ${cap(plural(kind))} are exempt.`,
    };
  },

  STILL_STREAM(c) {
    const name = waterwayName(c.expected);
    const mapped = hasExpectedBearing(c) ? `flowing ${describeBearing(c.expected.bearing)} here` : 'moving here';
    return {
      headline: 'SUSPICIOUSLY STILL.',
      detail: `${cap(name)} is supposed to be ${mapped}, but ${stillClause(c)}. ` +
        'Pool, dam, dry season, or you filmed the bank.',
      shareText: `Stream Checker: ${name} is supposed to be moving and isn't. Suspicious.`,
    };
  },

  STILL_UNKNOWN(c) {
    const s = c.scene;
    const label = s ? `“${sceneLabel(s)}”` : null;
    if (s && STILL_BY_NATURE.includes(s.bodyType)) {
      return {
        headline: `That's a ${s.bodyType}.`,
        detail: `Claude calls it ${label}${sceneSure(s)} and nothing is moving; nothing is mapped here either. ` +
          `${cap(plural(s.bodyType))} are exempt.`,
        shareText: `Stream Checker: that's a ${s.bodyType}. Exempt.`,
      };
    }
    if (s && SHOULD_FLOW.includes(s.bodyType)) {
      return {
        headline: 'Still water, unmapped.',
        detail: `Claude calls it ${label}${sceneSure(s)}, but ${stillClause(c)} and no water is mapped within ` +
          `${config.RADIUS.waterway} m. Dry season, a pool, or you filmed the bank.`,
        shareText: `Stream Checker: an unmapped ${s.bodyType} that isn't moving. Inconclusive.`,
      };
    }
    const map = c.mapStatus === 'unavailable'
      ? 'the map was unreachable'
      : c.mapStatus === 'skipped'
        ? "there was no location fix, so the map wasn't consulted"
        : `no lake is mapped within ${config.RADIUS.water} m and no stream within ${config.RADIUS.waterway} m`;
    const lead = s ? `Claude calls it ${label}${sceneSure(s)}; ${map}` : cap(map);
    return {
      headline: 'Puddle-class water.',
      detail: `${lead}, and ${stillClause(c)}. Puddle, pond, bathtub: all exempt.`,
      shareText: 'Stream Checker: puddle-class water. Not moving, not mapped, exempt.',
    };
  },

  TIDAL(c) {
    const reasons = [];
    if (c.coast) {
      const dist = metres(c.coast.distanceM);
      reasons.push(dist ? `The coast is ${dist} away.` : 'The coast is right here.');
    }
    if (c.expected && c.expected.exempt) {
      reasons.push(`${cap(waterwayName(c.expected))} is mapped as tidal, so it runs both ways with the tide.`);
    }
    if (c.scene && c.scene.bodyType === 'ocean') {
      reasons.push(`Claude says this is the ocean${sceneSure(c.scene)}.`);
    }
    let now = '';
    if (c.motion === 'flowing' && c.compassOk) now = `; right now it is heading ${describeBearing(c.flowBearing)}`;
    else if (c.motion === 'still') now = '; right now it is not moving at all, which is also allowed';
    return {
      headline: 'Tidal. Both directions are correct.',
      detail: `${reasons.join(' ')} Waves go both ways, so both directions are correct${now}.`,
      shareText: 'Stream Checker: tidal water. Both directions are correct. Exempt.',
    };
  },

  NOT_WATER(c) {
    const label = sceneLabel(c.scene);
    return {
      headline: 'NOT WATER. Verdict: declined.',
      detail: `Claude says that's “${label}”${sceneSure(c.scene)}, not water. Stream Checker checks streams.`,
      shareText: `Stream Checker: that's ${label}, not water. Verdict: declined.`,
    };
  },

  NO_TEXTURE(c) {
    const cov = pct(c.flow.coverage);
    return {
      headline: "Can't see detail.",
      detail: `${cov ? `Only ${cov} of the frame` : 'Too little of the frame'} had enough texture to track. ` +
        'Move closer, avoid glare and reflections, and try again.',
      shareText: "Stream Checker: couldn't see enough detail to judge. Glare, probably.",
    };
  },

  SHAKY(c) {
    const rel = Number.isFinite(c.flow.shakeRel)
      ? c.flow.shakeRel
      : (Number.isFinite(c.flow.shake) && c.flow.speed > 0 ? c.flow.shake / (c.flow.speed * c.flow.speed) : null);
    const shake = Number.isFinite(rel) ? ` (shake score ${rel.toFixed(1)}, limit ${config.FLOW.maxShakeRel})` : '';
    return {
      headline: 'Hold still.',
      detail: `The camera moved more than the water${shake}. ` +
        `Brace the phone, keep it still for the full ${config.CAPTURE_MS / 1000} seconds, and try again.`,
      shareText: 'Stream Checker: the camera moved more than the water. No verdict.',
    };
  },

  NO_COMPASS(c) {
    const dir = Number.isFinite(c.flow.angleDeg) ? ` ${screenDirection(c.flow.angleDeg)}` : '';
    const cons = pct(c.flow.consistency);
    const status = c.compass.status;
    let why;
    if (status === 'denied') why = "Motion access was denied; on iPhone, clear this site's data in Settings to be asked again.";
    else if (status === 'unreliable') why = 'The compass reading was unreliable; move away from metal and wave the phone in a figure 8.';
    else if (status === 'ok') why = 'No heading was recorded during the capture.';
    else why = 'This browser gives no compass heading.';
    const mapped = hasExpectedBearing(c)
      ? ` ${cap(waterwayName(c.expected))} is mapped flowing ${describeBearing(c.expected.bearing)}, for what it's worth.`
      : '';
    return {
      headline: 'No compass. No verdict.',
      detail: `The water is moving${dir}${cons ? ` (${cons} consistent)` : ''}, but without a compass heading ` +
        `that can't be turned into a bearing. ${why}${mapped}`,
      shareText: `Stream Checker: water moving${dir} on my screen, but no compass, so no verdict.`,
    };
  },

  INSUFFICIENT(c) {
    const frames = Number.isFinite(c.flow.frames) ? c.flow.frames : null;
    const count = frames === null ? 'Too few frame pairs were' : `Only ${frames} frame pair${frames === 1 ? ' was' : 's were'}`;
    return {
      headline: 'Not enough footage.',
      detail: `${count} analysed, which is not enough to judge. ` +
        `Keep the camera on the water for the full ${config.CAPTURE_MS / 1000} seconds and try again.`,
      shareText: 'Stream Checker: not enough footage to judge. The camera blinked.',
    };
  },
};

// Which numbers each code reports back (the card shows them, history stores them).
const REPORTS_MEASURED = new Set(['RIGHT', 'WRONG', 'SIDEWAYS', 'TERRAIN_RIGHT', 'TERRAIN_WRONG', 'TERRAIN_FLAT', 'UNVERIFIED', 'TIDAL']);
const REPORTS_EXPECTED = new Set(['RIGHT', 'WRONG', 'SIDEWAYS', 'STILL_STREAM', 'NO_COMPASS']);
const REPORTS_DELTA = new Set(['RIGHT', 'WRONG', 'SIDEWAYS']);
const USES_WATERWAY = new Set(['RIGHT', 'WRONG', 'SIDEWAYS', 'STILL_STREAM', 'NO_COMPASS']);

function sourceOf(code, c) {
  if (USES_WATERWAY.has(code) && code !== 'NO_COMPASS') return 'osm';
  if (code === 'TERRAIN_RIGHT' || code === 'TERRAIN_WRONG' || code === 'TERRAIN_FLAT') return 'terrain';
  if (code === 'STILL_LAKE') return c.lake ? 'osm' : 'none';
  if (code === 'TIDAL') return (c.coast || (c.expected && c.expected.exempt)) ? 'osm' : 'none';
  return 'none';
}

function streamNameOf(code, c) {
  if (USES_WATERWAY.has(code) || (code === 'TIDAL' && c.expected && c.expected.exempt)) {
    return c.expected && typeof c.expected.name === 'string' && c.expected.name.trim() ? c.expected.name.trim() : null;
  }
  if (code === 'STILL_LAKE' && c.lake) {
    return typeof c.lake.name === 'string' && c.lake.name.trim() ? c.lake.name.trim() : null;
  }
  return null;
}

/** Defensive: the copy is built to fit, but an odd OSM kind word must not overflow the card. */
function clampHeadline(text) {
  if (text.length <= HEADLINE_MAX) return text;
  const cut = text.slice(0, HEADLINE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 12 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Decide the verdict for one check. See CONTRACTS.md for the input shape;
 * every field is optional and missing data degrades to the safer code.
 */
export function decide(input) {
  const c = normalize(input);
  const code = chooseCode(c);
  const copy = COPY[code](c);
  return {
    code,
    tone: TONES[code],
    headline: clampHeadline(copy.headline),
    detail: copy.detail,
    // A bearing is only a measurement of flow when the water actually flowed.
    measuredBearing: REPORTS_MEASURED.has(code) && c.motion === 'flowing' && c.compassOk ? c.flowBearing : null,
    expectedBearing: REPORTS_EXPECTED.has(code) && hasExpectedBearing(c) ? normalizeDeg(c.expected.bearing) : null,
    delta: REPORTS_DELTA.has(code) ? deltaOf(c) : null,
    source: sourceOf(code, c),
    streamName: streamNameOf(code, c),
    shareText: copy.shareText,
  };
}
