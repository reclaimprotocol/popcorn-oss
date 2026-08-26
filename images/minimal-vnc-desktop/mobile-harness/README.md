# Popcorn LiveView mobile harness

This harness compares a website opened directly in the device browser with the
same website rendered through Popcorn LiveView. It runs Safari on iOS and
Chrome on Android. Both sides of an Android pair run in Chrome. The runner
drives native mobile input and treats the device framebuffer as the source of
truth. Android uses only ADB framebuffer capture and native touch injection; it
does not open a WebDriver session. The harness does not use browser CDP, the
remote DOM, web selectors, or a remote accessibility tree to judge correctness.

The repository intentionally starts with no active test cases and an empty
dashboard. Cases and dashboard entries are explicit, so historical artifacts
cannot silently become part of a new evaluation.

## Layout

```text
cases/                      active pair definitions created by the tester
dashboards/                 explicit lists of result manifests to publish
docs/                       configuration and debugging guides
environments/               checked-in example and ignored local configs
fixture/cases/              dedicated pages created by the tester
src/                        runner, environment loader, and dashboard builder
templates/                  neutral case, fixture, and dashboard starters
test/                       harness unit and integration tests
artifacts/                  ignored run evidence and generated dashboard
```

## Install

Install Node `24.5.0`, then run:

```bash
npm install
npm run setup:ios
npm run setup:android
```

`package.json` declares Node `24.5.0`, npm `>=11.5.1 <12`, and the preferred
package manager `npm@11.5.1`. There is no harness-specific runtime launcher;
standard npm scripts use the active local Node installation.

## Configure an execution environment

```bash
cp environments/example.json environments/local.json
export POPCORN_ADMIN_TOKEN='replace-me'
```

Edit the ignored local file with the iOS simulator or Android emulator, ports,
fixture host, Popcorn cluster, gateway, control plane, and shared LiveView flags. Keep
credentials in environment variables. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

Check the complete environment before recording anything:

```bash
npm run doctor -- --environment environments/local.json
```

## Create one case

```bash
cp templates/case.pair.json cases/example.pair.json
cp templates/fixture.html fixture/cases/example.html
```

Edit both files. The pair describes only visible behavior and native actions;
it must not contain host addresses, credentials, device IDs, or shared feature
flags. Each behavior gets its own deterministic page and visible phase markers.

Run baseline and LiveView sequentially:

```bash
npm run pair -- \
  --pair cases/example.pair.json \
  --simulator primary \
  --environment environments/local.json
```

The runner checks environment health first, loads the page before recording,
waits for the visible ready marker, records the simulator framebuffer, renders
one compressed 30 fps touch-overlay video, continuously tracks every native
pointer (including both fingers of a pinch), removes the temporary raw recording,
performs the same native actions on both sides, and compares
marker-synchronized checkpoints.

Dashboard video URLs include the evidence artifact digest, so rerunning a case
cannot leave an older recording in the browser cache under the same path.

For provisioned Popcorn sessions, the harness automatically navigates the
remote kiosk browser to the baseline fixture before recording. Cases and normal
environment files do not need navigation configuration. This setup step sends
only CDP target attachment and `Page.navigate`; it never reads page state, and
all assertions still come from the simulator framebuffer.

The neutral comparator generates direct baseline-versus-LiveView pixel diffs at
the named checkpoints. It returns `REVIEW` unless the case explicitly defines
`maxChangedPixelRatio`; the harness does not assume that a particular movement,
color, blank region, or control is an error.

For layouts where equivalent interactions can produce different scroll offsets,
use `compare.profile: "relative-transition-diff"`. It measures each side's own
`from` → `to` pixel change and compares the two changed-pixel ratios. A case can
set `maxTransitionRatioDelta` for its allowed movement difference. Matching
visible phase markers still prove that both sides reached the intended control;
the profile does not require their final pixels or scroll positions to align.

A case that intentionally treats a missing candidate action marker as a product
failure can set `candidateActionFailureVerdict: "FAIL"`. The runner applies this
only after the baseline completed, candidate recording passed its ready marker,
and a recorded candidate action failed. Setup, navigation, and recording failures
remain `INFRA_ERROR`.

Each case owns one stable directory named after the test, for example
`artifacts/example-pair/`. A run is written to a private staging directory and
atomically replaces the previous directory only after finalization. This keeps
only the latest result for that case, prevents partial data from appearing in
the dashboard, and avoids timestamp-prefixed folders. `pair.json` records the
replacement under `artifactRetention`.

## Build reports and dashboards

A pair writes `pair.json`, baseline/candidate `run.json` files, comparison data,
logs, screenshots, and compressed `screen-touches.mp4` evidence under its stable
case directory in `artifacts/`. Raw `screen.mp4` files and touch sprites are
temporary build inputs and are deleted before publication.

Rebuild one comparison from its run manifests:

```bash
npm run report -- \
  --baseline /absolute/path/to/pair/baseline/run.json \
  --candidate /absolute/path/to/pair/candidate/run.json
```

That command also creates a dashboard containing only that pair. To publish
several results, list their `pair.json` files explicitly in
`dashboards/current.json`, then run one command:

```bash
npm run dashboard -- \
  --config dashboards/current.json \
  --output artifacts/index.html
```

You can also pass one or more manifests without a config:

```bash
npm run dashboard -- \
  --manifest /absolute/path/to/first/pair.json \
  --manifest /absolute/path/to/second/pair.json \
  --output artifacts/index.html
```

The builder writes `dashboard-manifest.json` beside the HTML, recording the
exact inputs used. It never scans `artifacts/`, infers an issue category,
deduplicates by name, or chooses a newest run.

## Sequence and parallel execution

Develop cases sequentially first:

```bash
npm run sequence -- \
  --pairs cases/a.pair.json,cases/b.pair.json \
  --simulator primary \
  --environment environments/local.json
```

After each case is stable, assign each pair a named device profile from the
environment. iOS profiles hold simulator UDIDs, Appium/WDA/MJPEG ports, and
derived-data paths. Android profiles hold an emulator serial and optional AVD
name; Android screenshots and touches travel directly through ADB:

```bash
npm run parallel -- \
  --pairs cases/a.pair.json,cases/b.pair.json \
  --simulators primary,secondary \
  --environment environments/local.json
```

See [docs/DEBUGGING_PLAYBOOK.md](docs/DEBUGGING_PLAYBOOK.md) for the general UI
discrepancy workflow and evidence rules.

## Validate the harness

```bash
npm test
```

The tests validate environment merging, secret handling, and explicit
dashboard selection without starting a simulator or Popcorn session.
