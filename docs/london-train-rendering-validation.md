# London train rendering validation — 11 October 2026

Branch: `fix/train-visibility-spacing`, based on `origin/master` at
`9371f4712882a75a738380211f05b49410c825d7`. Initial checkout was `train-popup`
at `d8da732c2c42f2cde83b043051cada2ce598d44c`; the default branch already
contained that work and had identical source content. One implementation commit
contains this report, the fixes, and their regression checks.

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

## Changes

- Native London camera events update train scale, including pitch and resize.
  Existing bus, aircraft and non-London camera behaviour is retained.
- Outward-facing geometry, white body paint, dark windows and roof seams, roof
  panels and red cab ends. Details are procedural shader paint; no image textures,
  model downloads or material/mesh allocations per train or frame were introduced.
- Nearby train markers use stable presentation offsets, bounded to 40 CSS pixels.
  The same offset applies to visible, picking, outline and delay-marker passes.
  CPU picking and popup anchors use the displayed centre. A direct train hit takes
  priority over the station underneath. Layout runs after the current camera
  matrix has been installed, including during camera navigation.
- A disappearing train retains its visual offset until its GPU fade completes.

Geometry remains **840 vertices / 396 triangles**, with the same bounds. Visible
and GPU-picking geometry is still shared. There are no new materials, textures,
compute instances, uniforms or draw calls. London presentation adds one vec2
instance attribute to the existing body, outline and delay geometries.

## Validation

All commands exited **0**:

- `npm test`: **183 tests passed**, including winding, finite/nondegenerate
  geometry, deterministic/bounded decluttering, live motion, identity and opacity.
- `npm run lint`: **0 errors, 2 pre-existing warnings**, both in unchanged
  `src/helpers/helpers.js`; no warnings in changed files.
- `npm run build:london`.
- `git diff --check`.
- `node scripts/check-london-trains.cjs`: Playwright checks using the built app
  and real route assets with **16 fixed train instances** at Baker Street and
  Barbican. **12 views** cover light/dark themes, zooms 14/16/18, pitches
  0/45/60 and bearings 0/110, plus a resized 900×700 viewport and animated camera
  change to zoom 15.5 / pitch 35 / bearing −70. Checks cover stable instance IDs,
  shared picking geometry, selection of every displayed train, actual pointer
  hover/click tracking, moving trains, and lifecycle fading to zero. No JavaScript,
  WebGL or shader errors were observed. A 415-train overview exercises layout
  performance: the final measured p95 was **4.9ms**, below the asserted 16.7ms
  frame budget. GPU opacity reached exactly zero on fade-out.

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
40-pixel displacement bound. Detailed textures naturally become subpixel at the
whole-network overview scale. The geometry/paint change remains London-only.
