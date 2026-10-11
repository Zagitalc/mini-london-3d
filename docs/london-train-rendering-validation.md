# London train rendering validation — 11 October 2026

Branch: `fix/train-visibility-spacing`, based on `origin/master` at
`9371f4712882a75a738380211f05b49410c825d7`. Initial checkout was `train-popup`
at `d8da732c2c42f2cde83b043051cada2ce598d44c`; the default branch already
contained that work and had identical source content. The zoom follow-up continues
from `4437bc0286e7530d34366d92062b3bc139ff2b0c` on the same branch.

## Reproduced before implementation

Playwright Chromium opened the local London build, loaded live TfL trains and
inspected Baker Street in light and dark themes. Captures showed the broken grey
carriages and overlapping station trains reported by the user.

- Map zoom was **16**, but the train shader's zoom uniform was **10.0722487**.
  The wrapper did not forward the camera events listened to by TrafficLayer.
  Consequently, zooming enlarged trains far beyond the intended marker profile.
- All **396 triangles** in the London mesh had winding opposite their outward
  normals. A new front-face regression test failed on the original geometry.
- Multiple trains occupied identical coordinates at a platform. Displayed route
  lanes do not themselves separate the train renderer's logical centres.
- Station hit areas could intercept pointer events above rendered trains.

TrafficLayer already uses white light. The problem was not a time-of-day light
colour change; incorrect face orientation and shading made the body appear grey.

## Zoom regression reproduced before the follow-up

The original decluttering test allowed 40 CSS pixels of displacement at every
zoom. Playwright reproduced offsets of 36–40 pixels at zoom 11 and 40 pixels at
zoom 14, explaining the distant trains floating away from their tracks. The new
overview-anchor assertion fails against that build before the fix.

The original route width decreased to 1.5 pixels at zoom 19. The train scale
factor also decreased from 0.8 at zoom 14 to 0.48 at zoom 19, before the shared
shader's zoom clamp made it grow again above 19.

## Changes

- Native London camera events update train scale, including pitch and resize.
  Existing bus, aircraft and non-London camera behaviour is retained.
- Outward-facing geometry, white body paint, dark windows and roof seams, roof
  panels and red cab ends. Details are procedural shader paint; no image textures,
  model downloads or material/mesh allocations per train or frame were introduced.
- Overview trains stay exactly on their simulation anchors through zoom 15.
  Separation fades in smoothly between zooms 15 and 17, bounded by both 20 metres
  and 40 CSS pixels. Exact ground-plane projection derivatives and a perspective
  correction keep the limit valid when pitched or rotated.
  The same offset applies to visible, picking, outline and delay-marker passes.
  CPU picking and popup anchors use the displayed centre. A direct train hit takes
  priority over the station underneath. Layout runs after the current camera
  matrix has been installed, including during camera navigation.
- A disappearing train retains its visual offset at a fixed camera. Camera
  changes re-clamp that offset, including resetting it to zero in overview.
- London train size holds at street zoom, increases gently through zoom 19,
  and stays at a consistent screen size through maximum zoom 22. The London-only
  scale factor compensates for the shared shader clamp above 19.
- Close-zoom route widths now hold at 4.5–5.5 CSS pixels, with a two-pixel gap
  between parallel lanes. Zoom 15 and below retain the previous route styling.

Geometry remains **840 vertices / 396 triangles**, with the same bounds. Visible
and GPU-picking geometry is still shared. There are no new materials, textures,
compute instances, uniforms or draw calls. London presentation adds one vec2
instance attribute to the existing body, outline and delay geometries.

## Validation

All commands exited **0**:

- `npm test`: **188 tests passed**, including winding, finite/nondegenerate
  geometry, deterministic/bounded decluttering, live motion, identity and opacity.
- `npm run lint`: **0 errors, 2 pre-existing warnings**, both in unchanged
  `src/helpers/helpers.js`; no warnings in changed files.
- `npm run build:london`.
- `git diff --check`.
- `node scripts/check-london-trains.cjs`: Playwright checks using the built app
  and real route assets with **16 fixed train instances** at Baker Street and
  Barbican. **52 views** cover light/dark themes, zooms 11/13/14/15/15.5/16/17/18/19/20/22,
  pitches 0/35/45/60 and bearings 0/−70/110, including reverse zoom changes.
  A resized 900×700 viewport and animated camera change exercise native listeners.
  Checks cover stable instance IDs, shared picking geometry, exact overview
  anchors, independently inverse-projected metre displacement, readable close
  marker footprints, evaluated route widths, picking at displayed centres,
  actual pointer hover/click tracking, movement, and lifecycle fading to zero.
  Coincident overview markers may share a selectable centre; the test does not
  require inventing false positions to distinguish them. Fade-out also verifies
  that zooming back to overview clears the retained displacement.
  No JavaScript, WebGL or shader errors were observed. A 415-train overview checks
  layout against a 16.7ms p95 frame budget; final p95 was **0.6ms** across 240
  samples. The largest independently measured close-up displacement was
  **19.97 metres**, and overview displacement was **0 pixels**.

The Playwright runner accepts `APP_URL`, `PLAYWRIGHT_MODULE_PATH`, `BROWSER_PATH`
and `VISUAL_OUTPUT`. Default output is `/tmp/london-train-visuals`, containing
screenshots, diagnostic state and `results.json` with timing/fade measurements.
Run the local server after building. Supply an installed Playwright module and
Chromium executable if they are not available through ordinary module resolution.

Generated data is unchanged, both byte-for-byte and after decompression. SHA-256
of decompressed content:

- `features.json.gz`: `ddf47ded1147a52b9da5cedc86352e5e3d7e052299c976df888c65f859fba1e8`
- `london-route-display.json.gz`: `b10d7e4808d398b75360dfa3b4af1e082fe83210bc9085f904db10c573d2afb9`

Live identity, polling, movement, route assignment, generated routes, station
placement and lifecycle opacity are unchanged. Static review confirms the Tokyo,
bus and aircraft rendering paths retain their prior behavior. Accessibility and
attribution UI were not changed; pointer selection was explicitly verified.

## Limits

The local build has no `config.local.js`; Mapbox basemap tiles returned HTTP 403
during the baseline. Repeatable tests therefore use empty basemap tiles and fixed
train fixtures, while still rendering the real London route/station layers and
3D trains. Full contrast/occlusion against real buildings needs a working Mapbox
configuration. No claim is made that those external tile errors were fixed.

Presentation offsets reduce crowding without changing reported train positions.
They cannot guarantee zero overlap for arbitrarily large clusters inside the
20-metre/40-pixel close-up displacement bounds. Overview views intentionally
allow coincident markers to overlap rather than displacing their locations.
Detailed textures naturally become subpixel at the whole-network overview scale. The geometry/paint change remains London-only.


## Follow-up files and invariant review

The follow-up changes `src/helpers/london-train-layout.mjs`,
`src/helpers/train-marker-visuals.mjs`, `src/layers/traffic-layer.js`, and
`src/map.js`; adds the London-only `src/helpers/london-rail-style.mjs`; updates
`tests/london-train-layout.test.mjs`, `tests/train-marker-visuals.test.mjs`, and
`scripts/check-london-trains.cjs`; adds `tests/london-rail-style.test.mjs`; and
updates this report. All final commands above exited zero. Independent read-only
review checked the projection math and London/non-London render-path separation.

The sole repository skill, `.agents/skills/london-route-validation/SKILL.md`,
did not obstruct the authorized fix and was retained. No generated assets,
vehicle geometry/paint, live simulation, attribution, or accessibility UI changed.
No new geometry, materials or draw calls were introduced. GPU fade-out freezes
its last rendered position, and the cached layout anchor follows that behaviour.
