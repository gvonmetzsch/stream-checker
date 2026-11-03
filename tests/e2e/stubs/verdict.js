// STUB (test only): verdict.js per CONTRACTS.md, with the documented precedence but plain copy.
import { ANGLE } from './config.js';
import { toCardinal, angleDiff } from './geo.js';
export const CODES = ['RIGHT','WRONG','SIDEWAYS','TERRAIN_RIGHT','TERRAIN_WRONG','TERRAIN_FLAT','UNVERIFIED','STILL_LAKE','STILL_STREAM','STILL_UNKNOWN','TIDAL','NOT_WATER','NO_TEXTURE','SHAKY','NO_COMPASS','INSUFFICIENT'];
export function describeBearing(deg) { return `${toCardinal(deg)} (${Math.round(((deg % 360) + 360) % 360)}°)`; }
function out(code, tone, headline, detail, extra = {}) {
  const v = { code, tone, headline, detail, measuredBearing: null, expectedBearing: null, delta: null, source: 'none', streamName: null, ...extra };
  v.shareText = `${headline}. ${detail}`;
  return v;
}
export function decide(input) {
  const { motion, flowBearing, compass, expected, water, terrain, scene, mapStatus } = input;
  const name = expected && expected.name ? expected.name : 'the stream';
  if (scene && scene.scene === 'not_water') return out('NOT_WATER', 'warn', 'NOT WATER', `That's ${scene.label}. Verdict: declined.`);
  if (motion === 'insufficient') return out('INSUFFICIENT', 'neutral', 'TOO SHORT', 'Not enough frames. Try again.');
  if (motion === 'no_texture') return out('NO_TEXTURE', 'neutral', "CAN'T SEE DETAIL", 'Move closer, avoid glare and reflections.');
  if (motion === 'shaky') return out('SHAKY', 'neutral', 'HOLD STILL', 'The camera moved. Try again.');
  if ((scene && scene.bodyType === 'ocean') || (water && water.coast) || (expected && expected.exempt)) return out('TIDAL', 'neutral', 'TIDAL. EXEMPT.', 'Waves go both ways.');
  if (motion === 'still') {
    if ((water && water.lake) || (scene && ['lake', 'pond'].includes(scene.bodyType))) return out('STILL_LAKE', 'neutral', 'LAKE DETECTED', "Lakes don't go anywhere. Nothing to check.");
    if (expected) return out('STILL_STREAM', 'warn', 'SUSPICIOUSLY STILL', `${name} is supposed to be moving here.`, { streamName: expected.name });
    return out('STILL_UNKNOWN', 'neutral', 'PUDDLE-CLASS WATER', 'No mapped water body here. Exempt.');
  }
  if (!compass || compass.status !== 'ok' || compass.headingTrue == null || flowBearing == null) return out('NO_COMPASS', 'neutral', 'NO COMPASS', 'Direction known only relative to the screen.');
  if (expected) {
    const delta = angleDiff(flowBearing, expected.bearing);
    const a = Math.abs(delta);
    const extra = { measuredBearing: flowBearing, expectedBearing: expected.bearing, delta, source: 'osm', streamName: expected.name };
    if (a <= ANGLE.rightMax) return out('RIGHT', 'good', 'RIGHT DIRECTION', `${name} flows ${describeBearing(expected.bearing)} and so does this water. Carry on.`, extra);
    if (a >= ANGLE.wrongMin) return out('WRONG', 'bad', 'WRONG WAY', `${name} is mapped ${describeBearing(expected.bearing)} but this water heads ${describeBearing(flowBearing)}.`, extra);
    return out('SIDEWAYS', 'warn', 'SIDEWAYS', 'Off by a quarter turn. Probably the framing.', extra);
  }
  if (terrain) {
    const extra = { measuredBearing: flowBearing, source: 'terrain' };
    if (terrain.verdict === 'downhill') return out('TERRAIN_RIGHT', 'good', 'DOWNHILL. PLAUSIBLE.', 'No mapped stream; the ground drops that way.', extra);
    if (terrain.verdict === 'uphill') return out('TERRAIN_WRONG', 'bad', 'UPHILL?', 'The ground rises along the flow. Suspicious.', extra);
    return out('TERRAIN_FLAT', 'neutral', 'FLAT GROUND', 'Terrain says nothing.', extra);
  }
  return out('UNVERIFIED', 'neutral', 'UNVERIFIED', `Flowing ${describeBearing(flowBearing)}. ${mapStatus === 'unavailable' ? "Can't reach the map, so I'll allow it." : 'No mapped waterway nearby.'}`, { measuredBearing: flowBearing });
}
