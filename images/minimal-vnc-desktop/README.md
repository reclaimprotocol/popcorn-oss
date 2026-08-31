# Minimal noVNC Desktop Image

This is the maintained, standalone desktop image for visual browser/app sessions.
It intentionally does not use WebRTC, neko, supervisor, Chromedriver,
Playwright, the kernel-images API, or audio streaming.

## Build

```bash
cd images/minimal-vnc-desktop
IMAGE=popcorn/minimal-vnc-desktop:local ./build.sh
```

The build is single-platform by default and uses pinned base image digests,
pinned Chromium/noVNC artifacts, and Ubuntu snapshot apt sources. Chromium
packages are prepared into a local artifact context before the Docker build and
verified again inside the image build.

The default artifact mirror is locked in `locks/artifact-mirrors.tsv`. For an
unauthenticated mirror, set `ARTIFACT_MIRROR_PREFIX` to a URL containing the deb
files. For a different GitHub mirror, set `GITHUB_ARTIFACT_MIRROR_REPO` and
`ARTIFACT_MIRROR_TAG`.

### Tilion Fortress (stealth)

The browser is
[**Tilion Fortress**](https://github.com/tiliondev/fortress), a stealth
stock-Chromium fork pulled as an OCI image (pinned by digest) and symlinked over
`chromium` — it fully replaces stock Chromium. Its shared-library closure is
supplied by the Chromium runtime-lib block in `locks/apt-packages.txt`. See
[`STEALTH.md`](STEALTH.md) for its persona, limitations, and verification
workflow.

Fortress permits source and binary redistribution under BSD-3-Clause. Its
license, upstream notice, Chromium license, and bundled-font license are kept in
[`third-party/fortress`](third-party/fortress) and copied into every built image
at `/usr/share/doc/popcorn/third-party/fortress`. The matching source and
attribution details are documented in
[`../../THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

- **amd64-only.** The pin (tag `149`, stable Chromium 149) has no arm64 manifest,
  so the whole image is amd64-only. Build **natively** on an amd64 host — do not
  emulate under QEMU: chromium SIGTRAPs (crashes on launch before the live view
  is ready).

- **Override the pin** at build time (e.g. a newer Fortress digest):

  ```bash
  FORTRESS_IMAGE=docker.io/tilion/fortress@sha256:<digest> ./build.sh
  ```

- **Image size.** Fortress is now the only chromium in the image (the
  xtradeb chromium debs were dropped), so the net size is close to the original
  stock-chromium image. Check with
  `docker image inspect --format '{{.Size}}' popcorn/minimal-vnc-desktop:local`.

## Run

```bash
docker run --rm -it \
  --tmpfs /dev/shm:size=1g \
  -p 6080:6080 \
  -p 9222:9222 \
  popcorn/minimal-vnc-desktop:local
```

Open:

```text
http://localhost:6080/liveview.html?resize=scale&autoconnect=1
```

To exercise the **embedded** viewer instead (a host page iframing the live view and
feeding it keyboard geometry), serve this directory on another port and open one of
the harnesses in `host/`:

```bash
python3 -m http.server 8080   # from images/minimal-vnc-desktop
# then: http://localhost:8080/host/test-min.html   (bare iframe)
#       http://localhost:8080/host/test-host.html  (+ debug panel, buttons, ?nest=1)
```

### The embed layout contract (mobile sharpness)

The stream is a bitmap, so whatever raster scale the embedding page's compositor
picks for the iframe's layer is the scale the user sees. Mobile compositors pick
one BELOW device scale for a layer they consider cheap to redraw, and every number
the viewer can report stays identical while the render goes visibly soft — same
framebuffer, same canvas CSS size, zoom 1.00, byte-identical to a sharp top-level
tab. So sharpness on a phone is a property of the embedder, not of the encoder,
and lowering `quality`/`compression` cannot buy it back.

The rules, at **every** hop of a chain (customer page → portal → liveview):

- the viewer iframe is a plain fixed full-viewport layer — `position: fixed;
  inset: 0; width: 100%; height: 100%; border: 0` — and a **direct child of
  `<body>`**, with no wrapper;
- page chrome is **layered over** it (`position: fixed` + `z-index`), never a
  layout sibling that resizes it;
- no ancestor carries a transform, `zoom`, filter, containment,
  `content-visibility`, `opacity < 1`, `will-change`, or scrolls or animates;
- the iframe carries `allow="clipboard-read; clipboard-write; virtual-keyboard"`.
  Without the `virtual-keyboard` token the VirtualKeyboard API exists inside the
  frame but stays mute, which makes YOUR geometry the only thing keeping the
  keyboard usable — the viewer reports `no-virtual-keyboard` when it finds itself
  in that configuration;
- **do not take the focus while the keyboard is up.** Anything in the embedding
  page that calls `focus()` — an input of your own, a scroll-into-view, a consent
  banner mounting, an analytics widget — closes the user's keyboard mid-word.
  Each document owns its own `activeElement`, so the viewer cannot see this
  happening and cannot re-open a soft keyboard without a user gesture; all it can
  do is notice via `document.hasFocus()` and report `focus-stolen`. Track
  `.on('kbdstate')` and leave the focus alone while `active` is true.

`host/popcorn-host.js` both applies and checks this:

```js
const frame = document.createElement('iframe');
PopcornHost.layer(frame);                       // the contract, before src
frame.src = viewerBase + '/liveview.html?' +
  ['magnify=1', 'parentOrigin=' + encodeURIComponent(location.origin)]
    .concat(PopcornHost.forwardParams()).join('&');   // params survive this hop
document.body.appendChild(frame);
const host = PopcornHost.attach(frame, { childOrigin: new URL(viewerBase).origin });
host.on('layout', (a) => { if (!a.ok) report(a.issues); });  // codes only
host.on('scale', (s) => report(s.deviceScale));  // remote px per device px
host.on('health', (h) => report(h.code, h.detail)); // this embed is breaking the keyboard
```

`auditLayout()` runs itself on hello and on first paint, warns to the console with
the offending codes, emits `.on('layout')`, and posts the finding down to the
viewer's structural session log — so a "the stream is blurry" report is
attributable from the pod side without asking anyone to open devtools on a phone.
`.on('scale')` carries the four numbers that separate the causes: `fbWidth/fbHeight`
(remote px sent), `cssWidth/cssHeight` (the box on the device), `scale` (fb/CSS)
and `deviceScale` (fb per DEVICE px — the one that predicts what the user sees).

Reproduce the failure on purpose with `host/test-host.html?badlayout=1`, which
leaves the iframe inside a flex + `overflow: auto` + transformed wrapper. Combine
with `&nest=1` for the full three-level chain.

### Geometry: the failure that looks like a broken keyboard

An embedder that posts geometry it cannot measure is worse than one that posts
nothing. A middle frame whose `PopcornHost` falls back to measuring *itself* is a
cross-origin iframe whose `visualViewport` never shrinks, so it reports
`occludedBottom: 0` forever — and host geometry deliberately **suppresses** the
viewer's own detectors (two detectors driving the lift with different heights is what
causes keyboard-open jitter). The result is no lift, no pan budget to reach the
field, and the local-echo pill positioned behind the keyboard, so the one mechanism
that masks per-keystroke round-trip latency becomes invisible and typing appears
dead until the remote's pixels arrive.

Three defences, so a misconfigured embedder degrades to "no help" rather than
"actively broken":

- an embedded fallback measurer that sees no occlusion stays **silent**;
- the viewer only lets a host silence its detectors once that host has reported a
  real occlusion at least once;
- the legacy `{type:'parent-viewport', innerHeight, viewportHeight}` message — what
  the deployed portal sends — is **translated** into `POPCORN_HOST_GEOMETRY`, so that
  portal works unmodified. Opt out with `attach(frame, { legacyGeometry: false })`.

`host/test-host.html?legacybridge=1` exercises the translation; add `&legacyxlate=0`
to reproduce the original break.

### adjustResize hosts: the keyboard nobody can see

In an Android WebView with `softInputMode=adjustResize` — the common shape for a
portal-in-a-host-app embed — the soft keyboard shrinks the **layout** viewport
rather than occluding a visual one: `innerHeight` and `visualViewport.height` move
together (measured on a university login page through a two-hop embed chain — customer
page -> portal -> viewer: 839 -> 527 for both). Nothing is occluded, so `popcorn-host.js`
honestly computes `occludedBottom = innerHeight - vv.height - vv.offsetTop = 0`, and the viewer logs
`host geom occ=0 ignored`. Meanwhile the emulated remote — and so the canvas — keeps its
pre-keyboard height (839), and the field the user just tapped (y=592) ends up behind the
keys with nothing able to reveal it:

- a transform lift cannot help, because `#screen` *is* the shrunken 527px box — translating
  it up only exposes the background below the canvas;
- the local layout-resize detector knows the keyboard is up (it measured the reflow) but
  historically drew the conclusion "the layout already made room", which is only true when
  the framebuffer shrank with it.

So when the framebuffer stayed taller than the window, the viewer now **scrolls the remote**
instead: a synthesized swipe, in a column clear of the field's own rect (a tap there would
land a caret in a masked field), of exactly the deficit between the field's bottom and the
visible band. The extension re-reports the moved rects, so tap hit-testing follows.

A host that *can* measure should still do so — in this cell the honest number is
`baselineInnerHeight - innerHeight` (learn the baseline while no keyboard is up, and only
trust it when the width is unchanged, since a rotation moves both). Posting that puts the
viewer back on its authoritative path, and the remote scroll above stays as the fallback.

### The keyboard that never comes up (`rects=[]`, `rfk=0`)

One log signature covers a whole class of "the keyboard doesn't work" reports: every
tap line reads `hit=unknown kbd=0 rfk=0 ... rects=[]` with `remote=- vp=- canvas=-`,
and there is not a single `SIG` line in the session. The taps themselves are fine —
the remote page focuses fields exactly as it should (`Input Focused: ...` in the pod's
own logs) — but the viewer never learns it, so it has neither a rect to hit-test
against nor the remote's `editable:true`, and an `unknown` tap deliberately does not
pop the keyboard. What the user sees is a login form that swallows every tap; the only
way in is the keyboard button on the controls bar, which raises blind
(`focusClosestInput: no target (rects=0)`).

The cause is upstream of all of that: the pod-side publisher stopped publishing.
Field state is fanned out by ONE tab at a time (see `kbdActiveTab` in
`extensions/proxy/background.js`) and a top frame that reports window focus claims
that role. Automation opens windows — an agent's scratch target, a `about:blank`
popup — and a new window takes focus, so its empty top frame claimed the stream and
the page the user was typing into became a "background tab" that is never published
again. Its parting `editable:false, rects:[]` also wipes the rects the viewer already
had. Measured end to end: with one tab the hub sees a steady `editable=true rects=2`;
the moment a second window opens, one empty frame arrives and then nothing, for the
rest of the session.

So a blank/internal document can no longer take the stream — not by a focus claim, not
by the initial seed, and not through `chrome.tabs.onActivated` (which knows only a tab
id, and now answers the question from that tab's own last top-frame report). Such a
window claims normally once it navigates somewhere real, so a genuine popup the user
is looking at still works.

### Controls that only activate on a click

Tapping a checkbox and having nothing happen has two distinct causes, and both look
identical on screen.

A tap travels to the remote as CDP touch, and Chromium is the one that decides whether
that touch also becomes the compatibility `mousedown/mouseup/click` sequence. For ordinary
controls it does (verified end to end through the customer page -> portal -> viewer chain:
one native tap on the phone produced exactly one `touchstart/touchend`, one compat click,
and one toggle). A widget whose activation lives *only* in a `click` handler on a
transparent overlay — the shape jQuery iCheck and friends generate — is dead in the cell
where that synthesis does not happen, which is what was measured on a university login
page: the `.iCheck-helper` received `pointerdown/touchstart/pointerup/touchend` and no
click, while a real click on the same pixel toggled it fine.

So the extension watches for exactly that signature — a tap (not a drag) on something
activatable that produced no click within 250ms — and reports the point as `nc`; the viewer
replays it as a real click on the pointer path. It cannot simply click on every tap:
where Chromium *does* synthesize, that double-fires, and a double submit is worse than a
dead checkbox. Two guards keep it honest: `preventDefault` on the touch (read after the
page's own handlers have run, since the detector listens in the capture phase) means the
page suppressed the click deliberately, and a target that looks inert is left alone.

The second cause is duplication. A toggle is the one control where an extra tap is not
harmless — two clicks return it to where it started, so a doubled tap reads as "my tap
did nothing" while the same duplication is invisible on a text field, which just focuses
twice. Anything that lets one gesture reach the remote twice (several viewers attached to
one session is the easy way to arrange it) therefore shows up first on a checkbox.

`mobile-harness/cases/click-activated-checkbox.pair.json` pins the behaviour natively: one
tap, exactly one activation.

### `.on('health')` — the viewer's verdict on your integration

Every failure in this chain that has cost real time degraded *silently*: the viewer
knew something was wrong and the only place it could say so was a console inside a
cross-origin iframe on somebody's phone. The integrator saw a working page, the
user saw a broken keyboard, and nobody had both halves at once.

So the viewer reports its own health up the bridge, in codes. Alert on them, or log
them beside your own session id — they are structural (short strings plus rounded
numbers, never anything derived from page content), so they are safe to forward
into your own logging.

| code | what it means |
| --- | --- |
| `host-geometry-blind` | you are feeding geometry but have never seen an occlusion, while the viewer's own detectors say the keyboard is up — you are measuring the wrong window |
| `host-geometry-stale` | your feed stopped while the keyboard was up; the viewer has fallen back to local detection |
| `host-geometry-disagrees` | both sides see a keyboard, with materially different occlusion — usually an iframe that is not full-viewport, so the lift is wrong by the difference |
| `focus-stolen` | something in your page took the focus while the keyboard was open |
| `no-virtual-keyboard` | embedded without `allow="virtual-keyboard"`, so your geometry is load-bearing |
| `remote-unconfirmed` | keystrokes were sent that the remote field never reported holding — a real lost-input signal, as opposed to a slow repaint |

Each code is reported at most once per 30s, and every message carries the
cumulative `codes` list, so a listener that mounts late still learns what went
wrong. `host/test-host.html` logs them in its debug panel.

### Sharpness on a phone: the supersampled framebuffer

Even with the layout contract satisfied, the framebuffer is sized in the phone's CSS
pixels (`deviceScaleFactor: 1`), so a 411px viewport streams 411 remote pixels onto
~1080 device pixels — `dev=0.38` in the scale line, i.e. every remote pixel is
upscaled ~2.6x by the phone. No encoder setting can put that detail back.

`?fbscale=` raises CDP `deviceScaleFactor` **and** grows the framebuffer with it, so
the page still lays out as a 411px mobile viewport (same reflow, no reload — and
`injected.js` pins `devicePixelRatio` to 1, so the site sees no change) while the
raster carries k times the detail per axis: `dev` 0.38 → 0.76 at k=2.

| value | behaviour |
| --- | --- |
| `auto` | Opt-in adaptive mode: 2x once the link is measured healthy — magnify + touch + DPR≥2 + not in desktop-fit + RTT<400ms sustained 3s + no saveData/2g/3g. **Cold start is always 1x**, and it drops back to 1x if the link degrades. |
| `1` (default) | Off — today's behaviour byte-for-byte. Use this default until device A/B data proves supersampling improves input-to-paint latency as well as sharpness. |
| `2`, `3` | pinned, ignoring link health. For a device A/B. |

**It costs k² pixels per frame** — ~4x encode CPU on the pod and ~4x bytes on the
wire at k=2. That trades against paint latency, which is why `auto` never spends it
on a link it has not measured. The CPU side is the one to watch: this image runs
TigerVNC 1.12, whose Tight/JPEG encoding is single-threaded per client (no equivalent
of KasmVNC's `-RecThreads`), so 4x the pixels is 4x the work on ONE core. KasmVNC
ships the same idea on by default — its Medium/High presets auto-scale the remote
resolution to the client and explicitly scale upward on mobile — but its encoder fans
out across cores. The mechanism is proven; the cost profile is not the same. Pages that hit desktop-fit are excluded because they
are already supersampled (980 remote px into a 411px viewport ≈ `dev=0.91`, which is
why desktop-fallback pages look sharp while responsive ones look soft).

### Diagnostics

All opt-in, all structural — no typed text, no field values, no coordinates, no
URLs. Append to the viewer URL (they survive every embedding hop; see
`PopcornHost.VIEWER_PARAMS`):

| param | what it adds |
| --- | --- |
| `diag=1` | ship the structural keyboard/input log to the proxy's `/klog` |
| `kbddebug=1` | the same, plus an on-screen overlay and console mirror |
| `fbscale=1` | disable the supersampled framebuffer (see above) — first thing to try if sharpness improved but latency got worse |
| `e2e=1` | input→paint traces: `e2e tap g#7 sent=+3ms written=+58ms paint=+412ms total=473ms`. Needs `diag=1`. Reads a 5×5 grid of 12×12 pixel patches to detect localized paints, reduced to a checksum and discarded, so it costs a GPU readback per poll — bounded to 8 traces per load, one in flight, 2.5s each. `e2e=N` for N traces. |

`scale` lines (`fb=… css=… dpr=… sc=… dev=…`) and `host layout …` lines land in
the same log, which is where a blur report should be read from first.

noVNC HTTP/WebSocket is served on `6080`. Restricted CDP is served on `9222`
and full CDP is served on `9226` for trusted internal routing. Raw VNC listens
on `127.0.0.1:5900` inside the container, and Chromium's raw DevTools endpoint
listens on `127.0.0.1:9223` by default. noVNC and CDP listeners bind early, but
their HTTP and WebSocket routes return `503` until the configured app opens a
matching X window. The default readiness pattern waits for Chromium/Chrome.
Startup logs are written under `/var/log/app` by default, matching the fleet
chart's mounted log directory. `novnc-proxy` inherits container stdout, so its
server records are available to Kubernetes/OpenTelemetry and are also retained
in `entrypoint.log`.
The fleet chart sets pod `fsGroup: 1000` so the mounted log directory remains
writable by the image's non-root `kernel` user.

The browser image deliberately contains no application-specific API handlers or
proof assets. Deployments can add those capabilities as separate same-pod
services through the browser-fleet chart's extension hooks.

The restricted CDP proxy allows discovery endpoints (`/json`, `/json/list`,
`/json/version`) and filters client WebSocket commands to the same allowlist as
the current popcorn image: input events, viewport emulation, selected DOM
queries, `Browser.getVersion`, selected target attach/close/list commands, and
`Page.enable`/`Page.reload`. Full CDP on `9226` forwards commands without that
filter and should stay on a trusted internal surface. The standalone examples
below publish only `6080`; publish or route `9226` only behind Popcorn's
internal token path or an equivalent private gateway.

## Stealth testing

Two ways to verify the stealth surface against a **running container's**
chromium over the **full CDP proxy** (`9226` — the restricted `9222` filters the
commands the probes need):

- **`stealth-tests/`** — the full Node/playwright suite (tls, sannysoft, creepjs,
  cloudflare, turnstile, recaptcha, browserscan, akamai). Needs `npm install`.
  See [`stealth-tests/README.md`](stealth-tests/README.md).

- **`scripts/stealth-test.sh`** — a dependency-light battery (fingerprint
  coherence, sannysoft, creepjs, reCAPTCHA v3, cloudflare) that reads verdicts
  straight out of each test page over raw CDP. Needs only `python3` +
  `pip3 install websockets` — no node/playwright.

  ```bash
  # start a container (full CDP on 127.0.0.1:9226) and probe it
  ./scripts/stealth-test.sh --run

  # against an already-running container, with the coherent mobile-touch profile
  CDP_HOST=127.0.0.1:9226 ./scripts/stealth-test.sh --mobile

  # a subset
  ./scripts/stealth-test.sh fingerprint recaptcha
  ```

  Exit code `0` = all pass, `1` = a probe failed. **reCAPTCHA/Cloudflare weight
  egress IP reputation heavily** — a low score there reflects the IP (attach a
  residential proxy for production), not the fingerprint. `fingerprint` checks
  identity coherence and automation tells (`navigator.webdriver`, `cdc_`
  globals, plugin count, HeadlessChrome UA, touch/UA/platform consistency);
  `creepjs` reports "lie" entries, of which canvas/audio/DOMRect are the
  browser's anti-tracking noise, not identity spoofs.

## Runtime Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_COMMAND` | `/usr/local/bin/run-chromium-managed` | GUI launcher. Warm pods start in kiosk mode and, after allocation, honor the GameServer's `popcorn.dev/browser-mode` annotation for that pod only. |
| `BROWSER_KIOSK` | `true` | Passed to `start-chromium`; set to `false` by the managed launcher only for an allocated normal-view pod. |
| `APP_URL` | depends on `REPLACE_DEFAULT_PAGE` | Default startup URL for `start-chromium`. When unset, falls back to DuckDuckGo (`REPLACE_DEFAULT_PAGE=false`, default) or the Reclaim loading page (`REPLACE_DEFAULT_PAGE=true`). Set explicitly to override both. |
| `POPCORN_BROWSER_STARTUP_URL` | empty | Compatibility alias used when `APP_URL` is unset. |
| `CHROMIUM_STARTUP_URL` | empty | Compatibility alias used when `APP_URL` and `POPCORN_BROWSER_STARTUP_URL` are unset. |
| `CHROMIUM_FLAGS` | empty | Extra flags appended to Chromium. |
| `LOG_DIR` | `/var/log/app` | Directory for `entrypoint.log` (including proxy/TEE events), `xvnc.log`, `openbox.log`, and `app.log`. |
| `ENABLE_PROXY_EXTENSION` | `true` | Load the bundled Popcorn proxy extension using Chromium extension flags. |
| `PROXY_EXTENSION_DIR` | `/home/kernel/extensions/proxy` | Directory passed to Chromium via `--disable-extensions-except` and `--load-extension`. |
| `REPLACE_DEFAULT_PAGE` | `false` | When `false`, start on DuckDuckGo and keep the neutral DuckDuckGo managed policy. Set to `true` to opt into the Reclaim portal startup page and managed policy (new-tab page and search). The browser-fleet chart exposes this as `browserPolicy.variant`. |
| `CHROMIUM_POLICY_DIR` | `/etc/chromium/policies/managed` | Managed Chromium policy directory. |
| `CHROMIUM_POLICY_VARIANT_DIR` | `/etc/chromium/policy-variants` | Directory containing alternate policy JSON files. |
| `READY_WINDOW_PATTERN` | derived from `APP_COMMAND` | Case-insensitive extended regex matched against `xwininfo -root -tree` before noVNC reports ready. |
| `READY_TIMEOUT` | `30` | Seconds to wait for the app window before failing startup. |
| `WIDTH` | `1920` | Virtual display width. |
| `HEIGHT` | `1080` | Virtual display height. |
| `DEPTH` | `24` | Virtual display depth. |
| `DISPLAY_NUM` | `1` | X display number. |
| `NOVNC_PORT` | `6080` | HTTP/WebSocket noVNC port. |
| `VNC_PORT` | `5900` | Internal localhost-only RFB port. |
| `CDP_INTERNAL_PORT` | `9223` | Internal localhost-only Chromium DevTools upstream. |
| `CHROME_REMOTE_DEBUGGING_PORT` | `9223` | Compatibility alias used when `CDP_INTERNAL_PORT` is unset. |
| `CDP_RESTRICTED_PORT` | `9222` | Restricted CDP proxy port. |
| `DEVTOOLS_PROXY_PORT` | `9222` | Compatibility alias used when `CDP_RESTRICTED_PORT` is unset. |
| `CDP_FULL_PORT` | `9226` | Full CDP proxy port. |
| `CDP_RESTRICTED_LISTEN` | `0.0.0.0:${CDP_RESTRICTED_PORT}` | Restricted CDP listen address; set empty to disable. |
| `CDP_FULL_LISTEN` | `0.0.0.0:${CDP_FULL_PORT}` | Full CDP listen address for trusted internal routing; set empty to disable. |
| `CDP_UPSTREAM_ADDR` | `127.0.0.1:${CDP_INTERNAL_PORT}` | Chromium DevTools upstream used by both CDP proxies. |
| `ENABLE_AGONES` | `auto` | Enable best-effort Agones SDK lifecycle calls when Kubernetes/Pod env is present; set `false` for standalone debugging. |
| `AGONES_SDK_HOST` | `127.0.0.1` | Agones SDK HTTP sidecar host. |
| `AGONES_SDK_HTTP_PORT` | `9358` | Agones SDK HTTP sidecar port; `AGONES_SDK_PORT` is also accepted as a fallback. |
| `AGONES_HEALTH_INTERVAL` | `2` | Seconds between Agones `/health` pings. |

Example app override:

```bash
docker run --rm -it \
  --tmpfs /dev/shm:size=1g \
  -p 6080:6080 \
  -p 9222:9222 \
  -e READY_WINDOW_PATTERN=xterm \
  -e APP_COMMAND=xterm \
  popcorn/minimal-vnc-desktop:local
```

Gateway-compatible HTML can pass a websocket path:

```text
/liveview.html?resize=scale&path=/liveview-ws/{sessionId}/{token}
```

In Popcorn, the control-plane response keeps the compatibility field names
`vncUrl` and `vncWsUrl`, but their values should point at:

```text
vncUrl:   {baseUrl}/liveview/{sessionId}/{restrictedToken}/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000
vncWsUrl: {wsBase}/liveview-ws/{sessionId}/{restrictedToken}
```

The platform route key for this image is `liveview`, mapped to the container's
`NOVNC_PORT` (`6080`). The HTML route connects to `/websockify` after the
gateway rewrites `/liveview/{sessionId}/{token}/...` to the browser runtime.

## Reproducibility Notes

- `Dockerfile` pins the Dockerfile frontend plus Go and Ubuntu base images by
  digest.
- `locks/ubuntu-snapshot.lock` pins the Ubuntu snapshot ID passed by
  `build.sh`.
- `locks/apt-packages.txt` pins top-level apt package versions, including the
  Fortress (chromium) shared-library closure.
- `Dockerfile`'s `FORTRESS_IMAGE` pins the stealth-Chromium OCI image by
  digest (the browser binary itself).
- `locks/chromium-artifacts.tsv` pins the `libxcvt0` deb URL and sha256 (the
  only prepared deb artifact now that chromium comes from Fortress).
- `locks/artifact-mirrors.tsv` pins the GitHub release tags used when the
  upstream package pool no longer serves those exact debs.
- `locks/novnc.lock` pins the noVNC source tarball URL and sha256.
- `SOURCE_DATE_EPOCH` is passed through the build and used to normalize file
  timestamps.
