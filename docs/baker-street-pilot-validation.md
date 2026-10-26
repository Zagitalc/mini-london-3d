# Baker Street pilot: performance and guidance validation

Checked 26 October 2026 on `feat/baker-street-interchange-pilot`.

## Guidance sources and coverage

The committed Stop Structure snapshot was re-imported from the user-supplied TfL
XML using `scripts/import-london-station-topology.py`. The normalized objects match
exactly, including all **21 areas and 388 directed footpaths**, their levels,
movement types, and estimated durations. The source build is 26 October 2026 at
05:27:25; its response timestamp is 14:28:51. This establishes fidelity to the
supplied source, not that a survey or on-site walking validation has occurred.

The supplied XML text SHA-256 is
`a9120932193684af9e11e1b3a4f162000f3a16ed1d1493a16bce93d447b673a7`;
the stored normalized JSON payload SHA-256 is
`d6dfcbfb6d9f263dc880662174935c72c363d467342cf1884337bc5a8811e0c9`.

All **88 selectable transfers** (eight origins, each with seven other platform
areas and four street links) are reachable. Tests compare every selected duration
with an independent Floyd–Warshall calculation and check that the chosen route
contains only listed directed connections. Every path has known endpoints,
nonnegative numeric minutes, matching endpoint levels, and continuous part IDs
and levels. Missing durations and dangling area references cannot create shortcuts.

These are the six directional platform references added to the interface:

| Source area | Line | Direction | Platform |
|---|---|---|---:|
| BakSB | Bakerloo | southbound | 8 |
| BakNB | Bakerloo | northbound | 9 |
| HamEB | Circle / Hammersmith & City | eastbound | 5 |
| HamWB | Circle / Hammersmith & City | westbound | 6 |
| JubSB | Jubilee | southbound | 7 |
| JubNB | Jubilee | northbound | 10 |

The references were checked against [TfL's Baker Street arrivals data](https://api.tfl.gov.uk/StopPoint/940GZZLUBST/Arrivals)
and corroborated by [TfL's 2024 station monitoring report, page 21](https://content.tfl.gov.uk/station-dust-monitoring-july-august-2024.pdf).
They describe usual directional platforms, not live platform assignments. The
sample also contains Hammersmith & City departures from platform 2, so the live
departure board remains authoritative for an individual service.

`MetWB` and `MetEB` remain explicitly labelled **Metropolitan groups**. The source
collapses physical platforms 1–4 into two areas and uses east/west source names
where passenger-facing Metropolitan arrivals use north/south. We do not assign
these groups invented platform numbers or translate them into passenger directions.
The four street links retain TfL's codes A-M-N, B-M-S, C-BAK, and D-M-C; no street
exit names or opening hours have been inferred.

The UI shows “About … min” and “TfL walking estimate”. It labels the path geometry
as approximate immediately above the map. The coverage section distinguishes
source level codes from measured depths or floor counts and states that corridor
shapes and walking times have not been checked on site. There is no claim of
step-free routing, live lift/escalator availability, or carriage/door guidance.
No new per-user API request is needed for these static labels and notes.

## Reproducing deployment checks

Build and ordinary checks:

```sh
npm test
npm run lint
npm run build:london
```

Run the live browser acceptance script with an available Playwright installation:

```sh
PLAYWRIGHT_MODULE_PATH=/path/to/playwright \
BROWSER_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
HEADED=1 \
APP_URL='https://feat-baker-street-interchang.mini-london-3d.pages.dev/?city=london' \
VISUAL_OUTPUT=/tmp/london-acceptance \
node scripts/check-london-performance.cjs
```

`PROFILE=desktop-cpu-4x` or `PROFILE=mobile-chromium` selects one profile. The
script checks actual render events in Normal → Eco → Normal, live polling,
zero inherited Tokyo requests, no page exceptions, retained From/To selections,
44-pixel select targets, horizontal overflow, and one cached topology fetch.
It captures light/dark screenshots and saves timings and request counts as JSON.
It does not intercept or replace the deployed runtime or live APIs.

The desktop profile applies Chromium's 4× CPU slowdown. The mobile profile uses
390 × 844 CSS pixels, DPR 3, touch input and mobile viewport behavior. **Both use
the host GPU. Neither is a physical-phone, Safari, slow-GPU, battery, or thermal
test.** Actual map render events are measured; browser rAF callbacks are not used
as a proxy for rendered frames. Eco budgets apply after camera/style warmup;
loading and user interactions may request extra renders.

The initial deployment bundle hash matched the locally tested performance-fix
build (`9bd9b4a`) exactly. Full measurements, source-label evidence, and screenshots
are recorded in the task's milestone validation artifacts. The 4× CPU profile
measured approximately 75–76 FPS Normal and 30 FPS Eco, with no Tokyo requests,
continued live train polls, and one topology load through all three phases.
The mobile Chromium profile measured approximately 120 FPS Normal and 30 FPS
Eco, with zero Tokyo requests, nine combined train-feed polls, one topology load,
retained selections, 44-pixel-high select controls, and no horizontal overflow.
These initial deployment checks exercised the already deployed performance fix;
the new guidance was additionally checked using the rebuilt local runtime.

All 207 automated tests pass. The London production build succeeds. Lint reports
no errors and two existing import warnings in `src/helpers/helpers.js`.

## Remaining verification

A station visit is still needed to validate real corridor shapes, sign wording,
walking times, named exits, and the source's Metropolitan grouping. Browser device
emulation cannot replace testing on a physical phone and a genuinely slower GPU.
