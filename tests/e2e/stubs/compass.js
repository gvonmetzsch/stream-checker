// STUB (test only): compass.js per CONTRACTS.md. Android-style events only.
import { COMPASS } from './config.js';
export function circularMean(arr) {
  if (!arr || !arr.length) return { mean: null, R: 0 };
  let s = 0, c = 0;
  for (const d of arr) { s += Math.sin((d * Math.PI) / 180); c += Math.cos((d * Math.PI) / 180); }
  s /= arr.length; c /= arr.length;
  const R = Math.hypot(s, c);
  const mean = ((Math.atan2(s, c) * 180) / Math.PI + 360) % 360;
  return { mean, R };
}
export function tiltOk(pitch, cfg = COMPASS) { return pitch != null && cfg.pitchMin <= Math.abs(pitch) && Math.abs(pitch) <= cfg.pitchMax; }
export function topEdgeHeading(alpha, beta) { return Math.cos((beta * Math.PI) / 180) >= 0 ? (360 - alpha) % 360 : (180 - alpha + 360) % 360; }
export function cameraAxisHeading(alpha, beta, gamma) { return topEdgeHeading(alpha, beta); }
export function blendedHeading(alpha, beta, gamma) { return topEdgeHeading(alpha, beta); }
export function headingFromEvent(ev) {
  if (typeof ev.webkitCompassHeading === 'number' && ev.webkitCompassAccuracy >= 0) return { heading: ev.webkitCompassHeading, source: 'ios', accuracy: ev.webkitCompassAccuracy, pitch: ev.beta ?? null, roll: ev.gamma ?? null };
  if (ev.absolute === true && typeof ev.alpha === 'number') return { heading: blendedHeading(ev.alpha, ev.beta || 0, ev.gamma || 0), source: 'android', accuracy: null, pitch: ev.beta ?? null, roll: ev.gamma ?? null };
  return { heading: null, source: 'none', accuracy: null, pitch: ev.beta ?? null, roll: ev.gamma ?? null };
}
export function screenUpHeading(h, screenAngle) { return (h + screenAngle + 360) % 360; }
export function createCompass() {
  const listeners = new Set();
  let samples = null;
  let current = { headingMag: null, source: 'none', accuracy: null, pitch: null, roll: null, tiltOk: false, updatedAt: 0 };
  const onEvent = (ev) => {
    const h = headingFromEvent(ev);
    const angle = (typeof screen !== 'undefined' && screen.orientation && screen.orientation.angle) || 0;
    current = { headingMag: h.heading == null ? null : screenUpHeading(h.heading, angle), source: h.source, accuracy: h.accuracy, pitch: h.pitch, roll: h.roll, tiltOk: tiltOk(h.pitch), updatedAt: Date.now() };
    if (samples && current.headingMag != null) samples.push(current.headingMag);
    for (const fn of listeners) fn(current);
  };
  return {
    async requestPermission() {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try { return await DeviceOrientationEvent.requestPermission(true); } catch { return 'denied'; }
      }
      return 'unsupported';
    },
    start() { window.addEventListener('deviceorientationabsolute', onEvent); window.addEventListener('deviceorientation', onEvent); },
    stop() { window.removeEventListener('deviceorientationabsolute', onEvent); window.removeEventListener('deviceorientation', onEvent); },
    current: () => current,
    beginWindow() { samples = []; },
    endWindow() { const s = samples || []; samples = null; const { mean, R } = circularMean(s); return { headingMag: mean, samples: s.length, R }; },
    onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
