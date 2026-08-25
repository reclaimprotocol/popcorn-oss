# Harness configuration

The harness separates the behavior under test from the environment that runs
it.

## Environment files

Copy `environments/example.json` to an ignored local file:

```bash
cp environments/example.json environments/local.json
```

Configure:

| Section | Purpose |
|---|---|
| `simulators.<name>.device` | Simulator UDID, display name, and iOS version |
| `simulators.<name>.*Port` | Isolated Appium, WDA, and MJPEG ports |
| `simulators.<name>.derivedDataPath` | Per-simulator WebDriverAgent build directory |
| `defaultSimulator` | Profile used when `--simulator` is omitted |
| `fixtures.baseUrl` | Base URL used to resolve a case's `baseline.fixturePath` |
| `popcorn.sessionProvider` | Session transport, control-plane address, cluster, and region |
| `popcorn.liveview` | Public gateway, host page, and shared flags such as `magnify=1` |
| `popcorn.navigation` | Optional override for the built-in pre-record remote navigation |
| `defaults` | Shared timing and navigation defaults |
| `healthChecks` | HTTP checks that must pass before a pair starts |

Store the admin token in the variable named by `adminTokenEnv`:

```bash
export POPCORN_ADMIN_TOKEN='replace-me'
```

The checked-in example contains no machine-specific address or credential.
Local environment files are ignored by Git. A case definition should remain
portable across every environment.

## Merge rules

The environment supplies infrastructure defaults. A case may override a value
only when the behavior genuinely requires it. Nested `hostParams` are merged,
so a case-specific value does not remove shared flags.

The resolved environment name and preflight results are written to `pair.json`;
the admin token is never written to an artifact.

When a Popcorn session provider is configured, the harness automatically uses
`cdp-page-navigate` with the baseline fixture URL. Cases and normal environment
files do not need to declare navigation. `popcorn.navigation` remains available
only for an exceptional environment override.

The built-in navigator is setup-only for kiosk browser sessions that have no
visible address bar. It sends only target attachment and `Page.navigate` before
LiveView recording starts. It does not evaluate page JavaScript, read the DOM,
inspect page content, synchronize actions, or contribute evidence. The simulator
framebuffer and visible markers remain the sole test oracle.

`magnify` and other cluster-wide LiveView flags belong in
`popcorn.liveview.hostParams`. Nested host parameters are merged, so adding a
case-only parameter does not accidentally disable `magnify`.

## Comparison profiles

Use `checkpoint-pixel-diff` when baseline and LiveView should render at the same
coordinates. Use `relative-transition-diff` for desktop-only or scroll-heavy
pages where different final offsets are acceptable. The relative profile
calculates the changed-pixel ratio from `from` to `to` independently for Safari
and LiveView, then reports their absolute ratio delta. Set
`maxTransitionRatioDelta` only when the case has an explicit tolerance. Visible
marker synchronization remains mandatory, so a focus test can prove the
intended input received the tap without requiring equal scrolling.

Add `compare.viewportVision` when page-level scale is part of the behavior. The
analyzer runs Apple Vision OCR on simulator screenshots only, matches uniquely
visible text between Safari and LiveView, and compares median text-box height.
It does not read the remote DOM or use CDP as evidence. Example:

```json
"viewportVision": {
  "checkpoints": ["before-selection", "after-selection"],
  "minimumMatches": 5,
  "minimumScale": 0.78,
  "maximumScale": 1.30,
  "enforce": true
}
```

`enforce: true` turns an out-of-range scale or insufficient match count into a
FAIL. First validate thresholds against a known-good and known-bad screenshot
pair. OCR is a geometry signal, not a text-content assertion.

## Preflight

```bash
npm run doctor -- --environment environments/local.json
```

The command checks the active Node runtime, Xcode tools, Appium/XCUITest, booted
simulators, fixture host, Popcorn control plane, and gateway. A pair repeats the
environment health checks before starting its baseline, preventing a dead
cluster from producing a misleading partial test.

## Multiple environments

Create separate ignored files for different clusters or simulator pools:

```text
environments/lab-a.local.json
environments/lab-b.local.json
environments/ci.local.json
```

Select one at execution time with `--environment`. Test case files remain
unchanged.

Select a simulator profile with `--simulator primary`. Parallel execution
requires one profile per pair, in the same order:

```bash
npm run parallel -- \
  --pairs cases/a.pair.json,cases/b.pair.json \
  --simulators primary,secondary \
  --environment environments/local.json
```

Profiles must have unique UDIDs, Appium/WDA/MJPEG ports, and derived-data
paths. Those values remain outside behavior cases.

## Comparison configuration

The built-in `checkpoint-pixel-diff` profile compares direct Safari and
LiveView screenshots captured at the same visible-marker checkpoint.

| Field | Purpose |
|---|---|
| `from`, `to` | Two named synchronized screenshot actions |
| `pixelThreshold` | Per-pixel sensitivity passed to the image differ, from 0 to 1 |
| `maxChangedPixelRatio` | Optional automatic PASS/FAIL limit, from 0 to 1 |

Leave `maxChangedPixelRatio` as `null` until the case has known-good baseline
data. The result will be `REVIEW`, preserving the evidence without inventing a
generic correctness threshold. Add a custom analyzer when the behavior needs a
specific geometry, latency, flicker, or visibility invariant.

## Runtime selection

`package.json` declares Node `24.5.0`, supported npm versions
`>=11.5.1 <12`, and preferred package manager `npm@11.5.1`. Use normal
`npm install` and `npm run ...` commands. The harness does not override the
active Node or npm executable.

The earlier npm failure was a local PATH/runtime mismatch, not a simulator or
Popcorn failure. Set the local version manager's default to Node `24.5.0` so
new shells satisfy the package requirements.
