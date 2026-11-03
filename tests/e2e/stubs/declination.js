// STUB (test only): declination.js. Returns a constant, not a real WMM value.
export const WMM_EPOCH = 2025.0;
export function declination(lat, lon, altitudeKm = 0, date = new Date()) { return -13.57; }
export function magneticToTrue(h, lat, lon, date = new Date()) { return (((h + declination(lat, lon)) % 360) + 360) % 360; }
