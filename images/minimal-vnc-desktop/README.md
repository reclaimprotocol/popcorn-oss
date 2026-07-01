# Minimal noVNC Desktop Image

This is a standalone, fast-booting desktop image for visual browser/app sessions.
It intentionally does not use `popcorn-images`, WebRTC, neko, supervisor,
Chromedriver, Playwright, the kernel-images API, or audio streaming.

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
chart's mounted log directory.
The fleet chart sets pod `fsGroup: 1000` so the mounted log directory remains
writable by the image's non-root `kernel` user.

The Reclaim proof endpoint is served on the same HTTP surface as noVNC
(`NOVNC_PORT`, `6080` by default):

```text
POST http://localhost:6080/reclaim/prove
```

This endpoint does not depend on Chromium readiness. It uses the pinned
`github.com/reclaimprotocol/reclaim-tee` client plus embedded OPRF circuit and
proving-key assets copied from `popcorn-images`. Those assets add about 73 MB to
the source tree and require a cgo-enabled Go build.

An integration test for this endpoint lives in `tests/reclaim-prove.test.ts`. It
exercises both `oprf-mpc` and `oprf` hash types against a running instance and
validates the returned claim, TEE attestation context, and signatures. Run it
against a reachable instance (defaults to `http://localhost:6080`):

```bash
BASE_URL=http://localhost:6080 node tests/reclaim-prove.test.ts
```

A lightweight extraction-validation endpoint is served on the same surface:

```text
POST http://localhost:6080/reclaim/validate
POST http://localhost:6080/reclaim/validate-extraction
```

Both paths map to the same handler. It runs the reclaim-tee
`providers.GetResponseRedactions` pipeline against a supplied response body and
checks that the configured `xPath`/`jsonPath`/`regex` extraction yields the
`expectedValue`, without performing a full TEE proof. The request body is:

```json
{
  "responseBody": "<raw HTTP response body>",
  "expectedValue": "<value the extraction should yield>",
  "xPath": "<optional>",
  "jsonPath": "<optional>",
  "regex": "<optional>"
}
```

At least one of `xPath`, `jsonPath`, or `regex` is required. The response
reports `valid`, the extracted value, the redaction ranges, and per-step
diagnostics in `steps`.

The restricted CDP proxy allows discovery endpoints (`/json`, `/json/list`,
`/json/version`) and filters client WebSocket commands to the same allowlist as
the current popcorn image: input events, viewport emulation, selected DOM
queries, `Browser.getVersion`, selected target attach/close/list commands, and
`Page.enable`/`Page.reload`. Full CDP on `9226` forwards commands without that
filter and should stay on a trusted internal surface. The standalone examples
below publish only `6080`; publish or route `9226` only behind Popcorn's
internal token path or an equivalent private gateway.

## Runtime Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_COMMAND` | `/usr/local/bin/start-chromium` | GUI app command launched on the VNC display. |
| `APP_URL` | depends on `REPLACE_DEFAULT_PAGE` | Default startup URL for `start-chromium`. When unset, falls back to the Reclaim loading page (`REPLACE_DEFAULT_PAGE=true`, default) or `https://www.google.com` (`REPLACE_DEFAULT_PAGE=false`). Set explicitly to override both. |
| `POPCORN_BROWSER_STARTUP_URL` | empty | Compatibility alias used when `APP_URL` is unset. |
| `CHROMIUM_STARTUP_URL` | empty | Compatibility alias used when `APP_URL` and `POPCORN_BROWSER_STARTUP_URL` are unset. |
| `CHROMIUM_FLAGS` | empty | Extra flags appended to Chromium. |
| `LOG_DIR` | `/var/log/app` | Directory for `entrypoint.log`, `xvnc.log`, `novnc-proxy.log`, `openbox.log`, and `app.log`. |
| `ENABLE_PROXY_EXTENSION` | `true` | Load the bundled Popcorn proxy extension using Chromium extension flags. |
| `PROXY_EXTENSION_DIR` | `/home/kernel/extensions/proxy` | Directory passed to Chromium via `--disable-extensions-except` and `--load-extension`. |
| `REPLACE_DEFAULT_PAGE` | `true` | When `true`, use the Reclaim portal as the default page: startup falls back to the Reclaim loading page and the Reclaim portal managed policy (new-tab page and search) is applied before Chromium starts. When `false`, fall back to `https://www.google.com` and keep the default policy. |
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
| `RECLAIM_ROUTER_URL` | `https://tee.reclaimprotocol.org` | Reclaim router URL passed to the pinned client; `ROUTER_URL` is also accepted as a fallback. |
| `ATTESTOR_URL` | `wss://attestor.reclaimprotocol.org:444/ws` | Reclaim attestor WebSocket URL. |
| `TEE_K_URL` | `wss://tk.reclaimprotocol.org/ws` | Legacy config field preserved for request/config compatibility; the pinned client resolves TEE pairs through the router. |
| `TEE_T_URL` | `wss://tt.reclaimprotocol.org/ws` | Legacy config field preserved for request/config compatibility; the pinned client resolves TEE pairs through the router. |
| `RECLAIM_PROVE_TIMEOUT` | `5m` | Outer timeout for `/reclaim/prove`. |
| `RECLAIM_PROVE_CLEANUP_GRACE` | `10s` | Grace period before closing the Reclaim client after timeout/cancel. |

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
- `locks/apt-packages.txt` pins top-level apt package versions.
- `locks/chromium-artifacts.tsv` pins Chromium package URLs and sha256s.
- `locks/artifact-mirrors.tsv` pins the GitHub release tags used when the
  upstream package pool no longer serves those exact debs.
- `locks/novnc.lock` pins the noVNC source tarball URL and sha256.
- `SOURCE_DATE_EPOCH` is passed through the build and used to normalize file
  timestamps.
