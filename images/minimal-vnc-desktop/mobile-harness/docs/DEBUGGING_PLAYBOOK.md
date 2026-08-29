# Mobile UI discrepancy testing guide

Use this guide to find visible or interaction differences between a website in
native mobile Safari or Chrome and the same website through Popcorn LiveView.

The simulator framebuffer is the product truth. Do not use the remote browser's
DOM, Chrome CDP, web selectors, or accessibility tree to decide whether the UI
is correct. Numeric diagnostics may explain a visible failure, but they do not
replace simulator evidence.

## Test flow

### 1. Define the expected behavior

Write one observable claim before creating the test. Examples:

- tapping a field focuses the field and opens the native keyboard;
- the focused field remains visible above the keyboard;
- typing changes the visible remote field;
- tapping a button performs the expected visible action;
- opening a select displays a usable native control;
- content does not jump, resize, blur, or expose blank areas unexpectedly.

Also define the failure threshold where possible, such as maximum landmark
movement, blank-band height, response latency, or settle time.

### 2. Create a small, deterministic test page

Prefer one page per behavior. Give the page:

- a short visible description;
- one primary control under test;
- high-contrast landmarks that reveal movement or resizing;
- visible color markers for `READY` and each important interaction phase;
- deterministic behavior without animation, ads, or unrelated overlays.

Use a real website after the fixture proves that the harness detects the known
good and known bad cases correctly.

### 3. Define one paired scenario

The pair must use:

- the same simulator model and orientation;
- direct Safari (iOS) or Chrome (Android) as the baseline and LiveView as the candidate;
- the bundled WebView shell in place of that browser when the case sets
  `launchTarget: "webview-shell"`, for pages that ship inside a host app's web view;
- the same test page and native action array;
- the exact Popcorn build and feature flags being evaluated;
- built-in setup navigation to the baseline fixture before recording begins;
- named checkpoints synchronized by visible markers.

Do not synchronize baseline and candidate with equal delays. Network and paint
timing can differ even when both sides reach the same semantic state.

### 4. Start from a clean visible state

Before recording:

1. Boot only the assigned simulator.
2. Open the dedicated page.
3. Wait until the visible `READY` marker is observed twice.
4. Confirm no previous test page, keyboard, dialog, or address editor remains.
5. Start framebuffer recording. The harness will publish only the compressed
   touch-overlay version.

This keeps setup noise and previous cases out of the evidence.

### 5. Run the baseline and candidate

Run baseline and candidate sequentially while developing a case:

```bash
npm run doctor -- --environment environments/local.json
npm run pair -- \
  --pair cases/CASE.pair.json \
  --simulator primary \
  --environment environments/local.json
```

On Android, use ADB framebuffer capture plus native `input`/`uinput` touch
injection only; no WebDriver session or UI hierarchy is allowed. On iOS, use
Appium/XCUITest only for native actions such as taps, swipes, rotation, and real
keyboard interaction. Never switch Appium into a web context or locate remote
elements with selectors.

Parallel runs are useful only after the case is stable. Each iOS worker needs a
separate simulator, Appium port, WDA port, MJPEG port, and derived-data path;
each Android worker needs a separate emulator serial.

### 6. Validate the test before judging the product

Inspect `pair.json`, both `run.json` files, and
`comparison/comparison.json`. Confirm that:

- both sides reached every required visible marker;
- both sides executed the same actions in the same semantic order;
- taps and swipes match the intended coordinates;
- no implicit or unexpected native gesture occurred;
- screenshots and videos cover the intended interaction;
- the candidate used the intended build and flags;
- no emulator/simulator, recorder, ADB/Appium/WDA, or session error occurred.

Use `screen-touches.mp4` to audit gestures and as the complete framebuffer
timeline. Touch circles are composited only near recorded native gestures, so
all other frames remain unchanged. A broken or unsynchronized run is
`INFRA_ERROR`, not a product failure.

### 7. Analyze the complete timeline

Read numeric results before opening many screenshots:

1. Compare synchronized landmark positions.
2. Check blank-band or letterbox growth.
3. Check content displacement, resize, jitter, and settle time.
4. Check whether the focused control crosses the keyboard boundary.
5. Check action-to-visible-response latency.
6. Scan every video frame for short flashes as well as persistent failures.
7. Compare candidate measurements with the direct-Safari baseline.

Then inspect only three frames around each anomaly: immediately before it, its
maximum frame, and the recovery frame. Watch the short video interval when
animation or native feel still requires human judgment.

### 8. Correlate the visible failure with numeric diagnostics

Enable bounded Popcorn diagnostics when the video shows a real discrepancy.
Useful events include:

- native touch and key timestamps;
- keyboard open, geometry change, dismissal, and reopen;
- proxy focus and blur transitions;
- remote editable/focus state;
- viewport, iframe, canvas, and framebuffer dimensions;
- magnification and content-lift values;
- input-send and remote-paint timestamps.

Normalize these clocks to recording start. Never log typed text, credentials,
page content, or remote selectors. Logs explain when state changed; visible
simulator output determines whether that change was correct.

### 9. Test one hypothesis at a time

For each suspected cause:

1. State the expected numeric and visible change.
2. Change one behavior or add one bounded diagnostic.
3. Build and deploy the exact candidate image.
4. Confirm the running session contains that build.
5. Rerun the same pair without changing its actions or thresholds.
6. Reject the hypothesis if its predicted measurement changes but the visual
   discrepancy remains.

Do not accept a fix from a unit test or a single screenshot alone.

### 10. Validate repeatability and regressions

A fix is ready for review only when:

- the paired scenario completes with matching visible markers;
- the expected interaction visibly succeeds;
- the candidate is within the declared baseline tolerances;
- the complete-video scan contains no prohibited transient or persistent
  anomaly;
- at least two consecutive simulator pairs produce the same result;
- focused regression tests and the full keyboard suite pass;
- adjacent cases such as dismiss/reopen, rotation, select, and button-to-input
  still behave correctly.

### 11. Generate the evidence report

```bash
npm run report -- \
  --baseline /absolute/path/to/pair/baseline/run.json \
  --candidate /absolute/path/to/pair/candidate/run.json
```

This infers the first and last shared marker-synchronized screenshots, rebuilds
the comparison report, updates the pair manifest, and creates a dashboard with
only that pair. To publish multiple results, list their `pair.json` paths in a
dashboard config and build it explicitly:

```bash
npm run dashboard -- \
  --config dashboards/current.json \
  --output artifacts/index.html
```

The dashboard builder uses only the listed manifests. It does not scan old
artifacts, infer issue categories, deduplicate case names, or select the newest
run automatically.

Every case publishes to one stable directory named after the test. The runner
records into an `.in-progress-*` sibling, finalizes the manifest and compressed
touch video, then atomically replaces the prior case directory. The dashboard
is refreshed after publication. This retains one complete result per case and
never exposes a half-written run.

The report should lead with verdict, measurements, synchronized timeline, and
anomaly intervals. Keep the touch-overlay video, manifests, logs, and checkpoint
images linked for audit. Images should support a measured anomaly, not be the
primary way to search for one.

## What to test

Cover these behaviors before expanding to a broad website matrix:

| Area | Checks |
|---|---|
| Initial render | Correct scale, orientation, sharpness, no clipping or blank regions |
| Touch targeting | Tap reaches the intended control; no extra tap, swipe, or scroll |
| Text input | Focus, keyboard opening, first character, continued typing, deletion, composition |
| Input types | Text, email, password, number, date/time, textarea, autocomplete |
| Input placement | Top, center, bottom, fixed footer, modal, and inside a scroll container |
| Controls | Button-to-input focus, select/picker, checkbox, radio, menus, dialogs |
| Keyboard lifecycle | Open, dismiss, reopen, field-to-field move, floating keyboard where supported |
| Gestures | Page scroll, nested scroll, drag, long press, pinch policy, momentum handoff |
| Layout changes | Rotation, resize, browser chrome changes, overlays, sticky/fixed elements |
| Visual stability | Unexpected jump, blank band, flicker, blur, oscillation, delayed paint |

## Tool-selection flow

Start with the visible symptom and move through the table from left to right.
Do not collect every possible log before confirming that a discrepancy exists.

| Question or symptom | Use first | Use next to isolate the cause |
|---|---|---|
| Did the run start and finish correctly? | `pair.json`, `run.json`, native transport and runtime logs | `npm run doctor -- --environment ...` and session lifecycle logs |
| Did the harness perform an unintended tap, swipe, or scroll? | `screen-touches.mp4` and action timestamps | ADB/Appium evidence and decoded frames around the gesture |
| Are baseline and candidate showing different semantic moments? | Visible phase-marker observations | Checkpoint timestamps and `comparison.json` |
| Is there a jump, blank region, resize, flicker, blur, or wrong page scale? | Complete `screen-touches.mp4` timeline | `ffmpeg` frame scan, then geometry/Vision OCR and `pngjs`/`pixelmatch` measurements |
| Did the tap reach the intended visible control? | Touch-overlay video | Marker/landmark coordinates and action-to-paint timing |
| Did focus, typing, or the keyboard behave incorrectly? | Touch video plus native key timestamps | Popcorn `diag=1` focus, keyboard, viewport, frame, and paint events |
| Is a control hidden behind the keyboard? | Keyboard-boundary and landmark measurements | Viewport, iframe, canvas, lift, and occlusion diagnostics |
| Is the problem caused by rotation or layout change? | Before/after framebuffer dimensions | Simulator orientation events and numeric geometry timeline |
| Is LiveView different from native Safari? | Marker-synchronized paired comparison | Temporal metrics and the smallest anomalous video interval |
| Is the intended code actually running? | Build identifier in the run/session evidence | Image contents, runtime logs, and deployment tooling |
| Does a proposed fix preserve state-machine behavior? | Focused `node --test` regression | Full keyboard suite followed by repeated simulator pairs |

The tools fit into this order:

1. **Run:** Android uses `adb exec-out screencap`/`screenrecord` plus native
   `input` and `uinput`; iOS uses `xcrun simctl` for the framebuffer and
   Appium/XCUITest for native touches, rotation, and real keyboard input.
2. **Synchronize:** visible color markers align baseline and candidate by UI
   state rather than elapsed time.
3. **Measure:** `ffmpeg`/`ffprobe` decode the full timeline; Node with
   `pngjs`/`pixelmatch` measures motion, blank areas, landmarks, and diffs;
   Apple Vision measures visible text geometry directly from screenshots.
4. **Explain:** bounded Popcorn diagnostics correlate visible anomalies with
   focus, keyboard, geometry, and paint state.
5. **Verify:** runtime and deployment tools prove which build ran; `node --test`
   protects the underlying state machines.

### Custom analysis tools

Create a small custom analyzer when the visible discrepancy is not represented
by an existing metric. Useful custom detectors include:

- color-region, landmark, or strong-edge tracking;
- keyboard/content boundary detection;
- blank-band, clipping, blur, flicker, or oscillation detection;
- action-to-visible-response latency;
- focused-control visibility and settle-time measurement;
- OCR on simulator frames when visible text is the behavior being tested.

A custom analyzer must:

- read simulator screenshots or video, not remote DOM/CDP state;
- run against both baseline and candidate;
- use recorder-relative timestamps and native simulator coordinates;
- emit machine-readable JSON with thresholds and anomalous intervals;
- keep the source frames or video interval for audit;
- be validated against one known-good and one known-bad example before it is
  allowed to influence a verdict.

Custom diagnostics may also be added when pixels identify the failure but cannot
explain it. Keep them numeric and bounded; do not log typed text, credentials,
page content, or selectors.

The machine used to build or host Popcorn is an execution detail, not part of
the test specification. Keep environment-specific addresses and deployment
commands outside scenarios and this guide.

## Automate analysis before adding more screenshots

Prioritize these machine-readable outputs:

1. `video-analysis.json`: per-frame blank bands, displacement, resize, jitter,
   flashes, settle time, and response latency.
2. `timeline.json`: visible markers, touches, keys, keyboard state, geometry,
   remote paint, and anomaly intervals on one recorder-relative clock.
3. Geometry invariant warnings: viewport/keyboard totals, frame-size stability,
   focus visibility, and unexpected viewport movement.
4. Numeric-first HTML: baseline/candidate curves and anomaly intervals, with
   frames shown only when an interval is expanded.
5. Cross-site clustering: group failures by signatures such as viewport pan,
   resize, missing activation, delayed paint, or unexpected gesture.

Automation should identify where to look and why. Human review remains necessary
for animation quality, native feel, caret/selection behavior, native pickers,
legitimate dark content, and site-specific overlays.

## Verdict rules

- `PASS`: all declared visible invariants pass against the synchronized baseline.
- `FAIL`: a repeatable product discrepancy is visible and supported by artifacts.
- `REVIEW`: evidence is valid but the behavior needs human judgment or lacks a
  reliable visual profile.
- `INFRA_ERROR`: setup, synchronization, recording, action execution, or session
  infrastructure failed.

Never convert missing evidence into a pass.

## Running an existing case on a different surface

A case ports to another surface only as far as its ACTIONS do. The sweep through
the Android WebView shell found that most of what stopped a case from porting was
in the case, not the product, and the cases have since been rewritten to remove
it. What that established:

**A literal coordinate is a calibration, not a behavior.** 26 cases carried a
`tap`, `swipe`, `drag` or `pinch` with screen coordinates — 101 actions, plus 4
more hidden inside `platformTargetOverrides`, where a `wait` becomes a tap and an
audit of action types alone does not see it. Coordinates encode the device and the
surface together, so running one elsewhere completes the gesture and then times
out on the marker it was supposed to produce. All of them are now expressed as
markers, window fractions, text entry, or native selectors; see
[../cases/README.md](../cases/README.md) for which to reach for. A coordinate
appearing in a case again is a bug in the case.

**An absolute offset does not port either, even on a marker-relative action.**
`dragRelativeToColorByOffset` resolves its source from the framebuffer but
carried a fixed `delta`. `drag-hidden-target` needs the finger to enter a band
`innerHeight - 130` from the bottom and stay there long enough to autoscroll.
In a browser, chrome makes `innerHeight` smaller and the calibrated delta landed
inside the band; in a chrome-less web view the viewport is taller and the same
delta only grazed it (measured: `deltaY: 1408` fails, `1671` passes). Retuning
the delta only moves which surface works. The fix belongs in the FIXTURE: its
source now sits at `calc(100vh - 530px)`, a fixed distance above the viewport
BOTTOM, so one delta enters the band on every surface.

**On-screen keyboard keys are calibrated against the keyboard too.** `q` sits at
y=613 on an iOS simulator and y=1715 on Android, and moves again between Gboard
and the AOSP keyboard. `typeText` and `pressKey` go through the platform's own
input path instead, which is why the typing cases now run on any surface with any
keyboard.

**A native picker is an OS window.** It carries no fixture colors, so no
framebuffer marker can address it — but it exposes accessibility text, which is
stable across browsers and web views, and `tapNativeElement` uses that. Measured
in the WebView shell, a plain Android WebView does open the platform date, time,
month, week and select dialogs (they come from Chromium's content layer, which
WebView shares), and the exact-value cases commit through them, so these cases do
belong on the shell and not only on a browser.

**On Android there is no WebDriver to ask.** This transport is
`adb exec-out screencap` plus `adb shell input` and declares
`elementAccess: false`, so an Appium selector cannot resolve anything here — a
`tapNativeElement` written that way fails with `driver.$ is not a function`.
Android resolves a native element by dumping the accessibility hierarchy
(`uiautomator dump`) and tapping the matched node's centre, walking a long list by
repeating a swipe inside the list's own rectangle, because `scrollIntoView` also
needs a WebDriver. Only nodes with real on-screen area are eligible: a
NumberPicker keeps its off-screen values in the hierarchy, and tapping one of
those "centres" would hit whatever is painted there instead.

**Set `defaults.actionCoordinateScale`.** Only offsets and deltas still need it
(cases are authored in iOS points; the Android framebuffer is device pixels).
Without it those are off by ~2.8x, which reads as a product failure and is not
one. Marker positions, window fractions, and text entry do not depend on it.

## A hand-driven scenario is not the pair path

`npm run run -- --scenario` merges the platform's DEFAULT launch target underneath whatever the
scenario names, and takes none of the environment's `defaults`. Three consequences, each of which
fails as a marker that never appears rather than as a launch error:

- **iOS keeps the default's `browserName: "Safari"`,** so the XCUITest session attaches to Safari
  while the app named by `bundleId` holds the page — the taps land in the wrong application. Set
  `browserName: null`.
- **Android keeps Chrome's `preparation`,** whose `debugApp: true` issues
  `am set-debug-app --persistent` against the scenario's OWN package. The app then waits for a
  debugger and never paints. Set `preparation: null`.
- **`nativeOpenUrl` is an environment default,** so a scenario has to set it itself. Without it the
  whole launch block is skipped, `run.json` records `navigation: null`, and the run silently
  measures whatever the app happened to be showing already — which can look like a pass.

Check `navigation` in `run.json` before trusting a scenario run: a null there means the harness
never delivered the URL.
