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
| `APP_COMMAND` | `/usr/local/bin/start-chromium` | GUI app command launched on the VNC display. |
| `APP_URL` | depends on `REPLACE_DEFAULT_PAGE` | Default startup URL for `start-chromium`. When unset, falls back to DuckDuckGo (`REPLACE_DEFAULT_PAGE=false`, default) or the Reclaim loading page (`REPLACE_DEFAULT_PAGE=true`). Set explicitly to override both. |
| `POPCORN_BROWSER_STARTUP_URL` | empty | Compatibility alias used when `APP_URL` is unset. |
| `CHROMIUM_STARTUP_URL` | empty | Compatibility alias used when `APP_URL` and `POPCORN_BROWSER_STARTUP_URL` are unset. |
| `CHROMIUM_FLAGS` | empty | Extra flags appended to Chromium. |
| `LOG_DIR` | `/var/log/app` | Directory for `entrypoint.log` (including proxy/TEE events), `xvnc.log`, `openbox.log`, and `app.log`. |
| `ENABLE_PROXY_EXTENSION` | `true` | Load the bundled Popcorn proxy extension using Chromium extension flags. |
| `PROXY_EXTENSION_DIR` | `/home/kernel/extensions/proxy` | Directory passed to Chromium via `--disable-extensions-except` and `--load-extension`. |
| `PROXY_EXTENSION_RUNTIME_DIR` | generated `0700` temporary directory | Optional override for the private runtime extension directory containing the generated container proxy configuration. |
| `BROWSER_PROXY_URL` | empty | Optional per-container default Chrome proxy URL, including URL-encoded credentials for HTTP(S) proxies when required. Supports `http`, `https`, `socks4`, and `socks5`; Chrome does not support SOCKS authentication. |
| `BROWSER_PROXY_BYPASS` | `localhost,127.0.0.1` | Optional comma-separated bypass list used with `BROWSER_PROXY_URL`. |
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

### Browser proxy control

Set a default proxy for the lifetime of a browser container without baking it
into the image:

```bash
docker run --rm \
  -e BROWSER_PROXY_URL='http://user:p%40ss@proxy.example:8080' \
  -e BROWSER_PROXY_BYPASS='localhost,127.0.0.1,*.svc' \
  ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime:latest
```

Startup writes the proxy URL to a `0600` file in a fresh `0700` extension
directory, then removes the credential-bearing variables from Chromium's
environment. The extension moves credentials into session storage and uses
them only for matching proxy authentication challenges. Credentials are never
returned by the status API; the bootstrap file remains readable to the
container user for the lifetime of the browser process.

When `BROWSER_PROXY_URL` is set, Chromium first opens a loopback bootstrap page.
It does not navigate to `APP_URL` or signal container readiness until the
extension confirms that Chrome accepted the default proxy. Invalid defaults
therefore fail closed on the local page instead of continuing with direct
egress.

Trusted automation can open
`http://127.0.0.1:6080/proxy-control.html` inside the browser and use:

```js
const proxy = await window.PopcornProxy.connect();

await proxy.set('http://user:pass@proxy.example:8080');
console.log(await proxy.status());
await proxy.clear();
```

`set()` overrides the container default and `clear()` selects direct egress.
Restarting the container reapplies `BROWSER_PROXY_URL`. The friendly API and
the original `window.__pcn` interface are exposed only on the exact top-level
loopback control page and port; `__pcn` preserves its original set/clear result
shapes for compatibility.

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
