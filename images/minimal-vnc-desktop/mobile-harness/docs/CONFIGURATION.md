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
| `simulators.<name>.device` | Platform, UDID or emulator serial, display name, OS version, and optional Android AVD |
| `simulators.<name>.*Port` | Isolated Appium, WDA, and MJPEG ports for iOS profiles |
| `simulators.<name>.derivedDataPath` | Per-simulator WebDriverAgent build directory |
| `defaultSimulator` | Profile used when `--simulator` is omitted |
| `fixtures.baseUrl` | Base URL used to resolve a case's `baseline.fixturePath` |
| `android.launchTargets`, `ios.launchTargets` | Apps that can host the page, keyed by name |
| `android.defaultLaunchTarget`, `ios.defaultLaunchTarget` | Launch target used when a case names none |
| `popcorn.sessionProvider` | Session transport, control-plane address, cluster, and region |
| `popcorn.liveview` | Public gateway, host page, transport, and shared flags such as `magnify=1` |
| `popcorn.liveview.encryption` | `"e2e"` to run the encrypted transport, omitted to run plaintext |
| `popcorn.navigation` | Optional override for the built-in pre-record remote navigation |
| `defaults` | Shared timing and navigation defaults |
| `healthChecks` | HTTP checks that must pass before a pair starts |

Store the admin token in the variable named by `adminTokenEnv`:

```bash
export POPCORN_ADMIN_TOKEN='replace-me'
```

Set `popcorn.sessionProvider.ssh` to `local` when the harness runs on the same
machine as the control-plane endpoint. Other values remain normal SSH targets.

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

## Transport

`popcorn.liveview.encryption` selects which transport the candidate side runs.
Set it to `"e2e"` to match a deployment that serves end-to-end encrypted
sessions; omit it to run the plaintext transport. It is an environment value and
never a case value: it describes the deployment under test, not the behavior.

Set it to whatever production serves. Keyboard state, touch and geometry travel
the same way on both transports, but the viewer's own chrome — the JavaScript
dialog sheet, the popup close button, the FedCM account chooser — reaches the
viewer through a different envelope under `e2e`. A suite that only ever runs the
plaintext transport cannot see a break in the encrypted one, however many cases
it has.

The flag drives BOTH ends of the run: the session is provisioned with
`liveViewEncryption`, and the viewer URL is assembled with `?encryption=e2e`
plus the `#popcorn-e2e` enrollment fragment that carries the session key. If the
two ever disagree the run stops with an error rather than quietly falling back
to plaintext and reporting a pass.

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

The command checks the active Node runtime, platform tools, XCUITest for iOS,
ADB for Android, connected devices, fixture host, Popcorn control plane, and gateway. A pair repeats the
environment health checks before starting its baseline, preventing a dead
cluster from producing a misleading partial test.

## Launch targets

The harness launches the page into a named app. Four targets are built in and
need no configuration:

| Platform | Name | App | URL delivery |
| --- | --- | --- | --- |
| Android | `chrome` | `com.android.chrome` | `VIEW` intent data (`-d <url>`) |
| Android | `webview-shell` | `org.reclaimprotocol.popcorn.webviewshell` | `--es url` on an explicit component |
| iOS | `safari` | Safari | `simctl openurl` |
| iOS | `webview-shell` | `org.reclaimprotocol.popcorn.webviewshell` | `simctl launch ... -url <url>` |

`chrome` and `safari` remain the defaults, so existing environments and cases
behave exactly as they did. Pick another target per case with `launchTarget`, or
per side with `baseline.launchTarget` and `candidate.launchTarget`. A case names
only the target; bundle ids, activities, binary paths, and options stay here:

```json
"android": {
  "defaultLaunchTarget": "chrome",
  "launchTargets": {
    "webview-shell": {
      "label": "Android WebView",
      "package": "org.reclaimprotocol.popcorn.webviewshell",
      "activity": "org.reclaimprotocol.popcorn.webviewshell.ShellActivity",
      "urlDelivery": "extra",
      "urlExtra": "url",
      "apk": "../android/webview-shell/build/popcorn-webview-shell.apk",
      "extras": { "wideViewPort": true, "clearData": true }
    }
  }
},
"ios": {
  "defaultLaunchTarget": "safari",
  "launchTargets": {
    "webview-shell": {
      "label": "iOS WebView",
      "bundleId": "org.reclaimprotocol.popcorn.webviewshell",
      "urlDelivery": "launch-args",
      "urlArgument": "url",
      "app": "../ios/webview-shell/build/PopcornWebViewShell.app",
      "extras": { "clearData": true }
    }
  }
}
```

Shared fields:

| Field | Purpose |
| --- | --- |
| `label` | Name shown in run manifests and on the dashboard |
| `urlDelivery` | How the URL reaches the app, per the table below |
| `reinstall` | Reinstall on every run instead of only when missing |
| `extras` | Extra options passed to the host app |

Android fields: `package` (application id, force-stopped before each launch),
`activity` (explicit component, required for `extra` delivery), `urlExtra`
(extra name carrying the URL, default `url`), and `apk`. Android `urlDelivery`
is `view-intent` or `extra`. Extras are typed by JSON value: bool `--ez`,
number `--ei`, string `--es`.

iOS fields: `bundleId` (required unless the target is a system handler such as
Safari), `browserName` (Safari only, and then no app is installed),
`urlArgument` (launch argument carrying the URL, default `url`), `scheme` and
`urlQuery` (for `custom-scheme`), and `app`. iOS `urlDelivery` is `open-url`,
`launch-args`, or `custom-scheme`; extras become `-name value` launch arguments
or query items. Prefer `launch-args`: iOS shows a confirmation dialog when
another process opens a custom scheme, and an automated run cannot answer it.

Relative `apk` and `app` paths resolve against the environment file. The
Android APK is installed with `adb install -r -g`, so declared runtime
permissions are pre-granted; the iOS app is installed with `simctl install`.
Build the shells first with
[`android/webview-shell/build.sh`](../android/webview-shell/README.md) and
[`ios/webview-shell/build.sh`](../ios/webview-shell/README.md); a run that
needs one fails with the build command in the error rather than installing
something stale. `npm run doctor` lists every configured target for each
platform in use, its application, and whether its binary is present.

On iOS the session attaches to the target bundle rather than to Safari, so the
install happens before Appium starts. Nothing else about the transport changes:
screenshots and native input still come from WebDriverAgent, and Android still
uses ADB only.

Both sides of a pair should normally use the same target: a browser shows a URL
bar and a shell does not, so mixing them changes the usable viewport height and
makes a pixel comparison meaningless. Mix them only for a case whose whole
point is that difference.

## Android emulator rendering

Start the emulator with **hardware** rendering. On an Apple Silicon host:

```bash
$ANDROID_HOME/emulator/emulator -avd <name> -no-audio -no-boot-anim -gpu host
```

`-gpu swiftshader_indirect` renders in software. Headless that is merely slow,
but with the emulator window open it starves `system_server` badly enough to
raise *"Process system isn't responding"*, and that dialog covers the page under
test: markers are found once and then hidden, so a run fails with
`Visible marker ... did not appear` while reporting a `max pixels` value well
above the threshold. That signature means the framebuffer was obscured, not that
the fixture is wrong.

Measured on this project's AVD (Pixel 7, API 34), same case: `-gpu host` with the
window open completes in ~39s, `-gpu swiftshader_indirect` headless in ~60s, and
`swiftshader_indirect` with a window ANRs. Prefer `-gpu host`; keep `-no-window`
only for CI hosts with no GPU.

## Android browser preparation

A freshly created AVD hides the page behind Chrome's own surfaces: the
first-run screen, then a notifications promo. Either one keeps the case's ready
marker from appearing, and the run ends `INFRA_ERROR` with
`Visible marker ... did not appear`.

The harness handles both from the launch target's `preparation` block, which the
built-in `chrome` target already sets:

| Field | Purpose |
| --- | --- |
| `commandLineFile` | Device path for the browser command-line file |
| `commandLineFlags` | Flags written there, e.g. `--disable-fre` |
| `debugApp` | Run `am set-debug-app --persistent` so the flags are read |
| `dismissNodeIds` | Dialog node ids to tap if present, e.g. `com.android.chrome:id/negative_button` |
| `dismissRounds` | How many times to look for another dialog (default 3) |

Flags are written before the launch; `adb root` is attempted first and a device
that refuses it simply keeps its existing browser configuration, with
`preparation.commandLineFlags.applied: false` recorded in `run.json`. Dialog
dismissal runs after the launch but **before** the ready marker and before
recording starts, so a dismissed promo can never appear in the evidence. What
was dismissed is recorded as `launchTarget.dismissedDialogs`.

Set `"preparation": null` on a target to turn all of this off. The
`webview-shell` targets define no preparation because they have no such
surfaces.

Prefer a `google_apis` system image over `google_apis_playstore`: `adb root` is
refused on Play-enabled images, so the flag file cannot be written and Chrome's
first-run screen has to be dismissed by hand.

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

Profiles must have unique UDIDs. iOS profiles must also use distinct
Appium/WDA/MJPEG ports and derived-data paths. Those values remain outside
behavior cases.

## Comparison configuration

The built-in `checkpoint-pixel-diff` profile compares the direct device browser
and LiveView screenshots captured at the same visible-marker checkpoint.

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
