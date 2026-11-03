# Stream Checker

Point your phone at a creek. Stream Checker films it for four seconds, works out which way the water is moving, turns that into a compass bearing, and compares it with the direction the stream is *supposed* to flow according to OpenStreetMap. Then it tells you whether the water is moving in the right direction.

It started as a joke. It works anyway.

**App:** https://gvonmetzsch.github.io/stream-checker/

## Install it on your phone

It is a web app, so there is nothing to download from an app store.

- **iPhone:** open the link in Safari, tap Share, then **Add to Home Screen**. The home-screen version asks for the camera on every launch (a Safari limitation); the Safari tab can remember the permission, so use whichever you prefer.
- **Android:** open the link in Chrome, open the menu, then **Install app** (or **Add to Home screen**).

Permissions it asks for, and why:

| Permission | When | Used for |
|---|---|---|
| Camera | first Check | measuring water motion; frames are analysed on the phone |
| Motion & orientation (iOS prompt) | first Check | compass heading of the phone |
| Location | first Check | finding the nearest mapped stream and the magnetic declination |

## How a check works

1. **Measure.** Four seconds of rear-camera video are downscaled and run through a block-matching optical-flow estimator on the phone. The result is a direction across the screen, a speed, and a consistency score (how much the frames agree). Hand tremor cancels out; real flow accumulates.
2. **Orient.** The compass heading averaged over the same four seconds turns the on-screen direction into a bearing. Phone compasses report *magnetic* north, so the app applies the magnetic declination for your position using the World Magnetic Model 2025.
3. **Look it up.** The app asks OpenStreetMap (through the Overpass API) for waterways within 200 m, lakes within 60 m, and coastline within 300 m of your position. OSM draws rivers and streams in the direction of flow, so the nearest segment gives the expected bearing.
4. **Judge.** Within 60° of the mapped flow: **RIGHT DIRECTION**. More than 120° off: **WRONG WAY**. In between: **SIDEWAYS**, which usually means the framing is off. With no mapped stream nearby, a coarse terrain-slope estimate (90 m elevation data) stands in. With no map data at all, the verdict is **UNVERIFIED**.

Still water at a lake is exempt (lakes don't go anywhere). Still water where a stream is mapped is *suspiciously still*. Still water with nothing mapped is puddle-class water, also exempt. Tidal water is exempt because both directions are correct.

## Optional: the Claude scene check

By default no image ever leaves the phone. If you add your own Anthropic API key in Settings, each check also sends **one** small frame to Claude, which answers whether the scene is flowing water, still water, or not water at all, what it is (river, lake, puddle, bathtub...), and a one-line remark. This is what makes the "that's a carpet" and "that's a puddle" cases reliable.

- The key is stored only in your phone's local storage and is sent only to `api.anthropic.com`.
- Cost is well under a cent per check with the default model and a tiny fraction of that with Haiku.
- Set it up safely: in the Anthropic Console create a **new workspace**, give it a small **monthly spend limit**, then create an API key scoped to that workspace with an **expiration date**.

## No signal?

Measuring works offline. Judging needs the map. Before you head out, tap **Save streams near me** while you have signal: it stores every mapped waterway, lake and coastline within 5 km on the phone, and the app uses that when it cannot reach the map.

## Limits

- Panning the phone looks like flow. Hold still.
- Wind ripples, reflections of moving clouds and standing waves can fool it. Glare and flat water give "can't see detail".
- The on-screen-to-compass mapping ignores perspective; the 60° tolerance absorbs most of it.
- Small creeks are often not mapped. Then the terrain estimate or "unverified" applies.
- Public Overpass servers get overloaded. The app tries a second server and your saved map data.
- Android compasses need the occasional figure-8 calibration and dislike nearby metal.
- Without the scene check, the app cannot tell that something is not water.

## Development

No build step. The site is the `docs/` folder.

```bash
npm test          # unit tests (node --test)
npm run e2e       # headless Chromium with a fake camera, routed map/model fixtures
npm run serve     # local static server for docs/
```

The end-to-end run generates synthetic flowing-water clips with `scripts/make-test-video.py` (numpy + ffmpeg) and launches Chromium with `--use-fake-device-for-media-stream`.

## Data and attributions

- Map data © OpenStreetMap contributors, available under the Open Database License (ODbL). Queried through the Overpass API.
- Elevation data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0), based on Copernicus DEM GLO-90.
- Magnetic declination from the NOAA/NCEI World Magnetic Model 2025; coefficients via the Apache-2.0 `geomagnetism` package by Natural Atlas.

## License

MIT.
