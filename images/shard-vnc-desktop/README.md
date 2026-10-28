# ShardBrowser local runtime

Opt-in ShardX Chromium runtime with Popcorn's shared live viewer, CDP proxy and proxy extension. Build from the repository root:

```sh
docker build --platform linux/amd64 -f images/shard-vnc-desktop/Dockerfile -t popcorn/shard-viewer:local .
docker run -d --name popcorn-shard --platform linux/amd64 --shm-size=1g \
  -p 127.0.0.1:16085:6080 -p 127.0.0.1:19235:9226 \
  -v popcorn-shard-data:/home/kernel/user-data \
  popcorn/shard-viewer:local
```

Viewer: <http://127.0.0.1:16085/liveview.html?resize=scale&autoconnect=1>.
Full CDP: <http://127.0.0.1:19235/json/version>.
Keep both ports on loopback; CDP provides full browser control.

The runtime is Linux/amd64 only. Apple silicon requires Docker emulation; native amd64 is preferred. Fleet defaults are unchanged.

## Configuration

- `WIDTH=1920`, `HEIGHT=1080`: X display, window and reported screen size.
- `SHARD_TEMPLATE_PATTERN=^win-(hd|uhd|iris|intel)`: bundled templates eligible for a new profile. `SHARD_TEMPLATE` pins one template instead; `SHARD_PLATFORM=Windows` filters the pool by platform.
- `SHARD_TIMEZONE=auto`, `SHARD_LANGUAGE=en-US`: locale for a new profile. `auto` resolves the timezone from the pod's direct egress at first launch; a proxied session replaces it (see Locale below).
- `SHARD_NOISE=canvas,webgl,audio,client_rects`: engine noise vectors for a new profile, seeded from its id. `none` disables noise.
- `CHROMIUM_FLAGS`: extra switches, whitespace-separated, appended last. `POST_PROOF_LOGIN_REPAIR_ENABLED=true` starts on `about:blank` and disables background component extensions, as in the main image. Popup blocking is off, as in the main image, so popup-based OAuth and payment flows work. Component updates and background networking are off, as in the main image: each pod starts a fresh profile, and the `ComponentUpdatesEnabled` policy alone still lets Chromium download about 25 components into it on every session.
- `SHARD_PROFILE_DIR`: persistent profile root. Defaults to `shard` under `BROWSER_PROFILE_DIR`, or under `/home/kernel/user-data`.
- `REPLACE_DEFAULT_PAGE=false`: `true` installs the reclaim-portal policy variant and start page, as in the main image. `APP_URL` overrides the start page.
- `ENABLE_PROXY_EXTENSION=true`: load the existing Popcorn extension. Set `false` to disable it.
- `MVD_EMULATOR_OFF=0`: the shared CDP emulator and extension compatibility shims are on, as in the main image. Mobile viewers need them: touch, virtual-keyboard text and dialog relay go through the emulator. Set `1` to retain the engine's native profile values; restart with a fresh browser process.
- `MVD_EMULATOR_ON_VIEWER=1`: the emulator attaches only once the first viewer connects or reports its size, so pages loaded before anyone watches stay unattached. Set `0` to attach at startup, as in the main image.
- `MVD_FINGERPRINT_SHIMS=0`: the extension's geometry, API-surface and media-query shims stay off, because the engine reports those values natively; its functional shims (select picker, fullscreen, same-tab links, passkey) stay on. Set `1` for the main image's behaviour.
- `ENABLE_AGONES=auto`: shared entrypoint lifecycle reporting when running in Kubernetes.

The image runs the main image's `run-chromium-managed`. Pods start in kiosk mode and honour the GameServer's `popcorn.dev/browser-mode` and `popcorn.dev/browser-timezone` annotations; normal mode uses a separate profile under `/home/kernel/user-data-normal`. The managed Chromium policies are the main image's.

Direct networking is the initial default. Configure session routing through Popcorn's existing proxy-extension flow before navigating to a target. This image does not introduce a new proxy credential interface. QUIC and WebRTC are disabled, including for extension-configured proxies. Proxy authentication and egress need verification in the intended deployment. The helper below verifies a local session before navigating to `PROXY_SESSION_URL` (default `https://example.com/`).

## Persona

A profile is created once per profile directory and reused on later starts. Existing data volumes keep the profile they already have; use a new volume to pick up persona changes.

- **Device:** a random Windows template with Intel integrated graphics. WebGL renders through SwiftShader, and a software renderer is most plausible behind an iGPU. Cores, memory and OS version stay as sampled from the real device; the SDK's re-roll brackets the host's CPU count instead.
- **Screen and window:** the X display size at DPR 1, with a 40 px taskbar excluded from the available area. The template's own window size is replaced, since it belongs to its source device's screen. The viewer proxy fits the browser window to the whole X screen, so a normal-mode window reports an outer height of 1080 against an available height of 1040, which a maximized Windows window would not.
- **WebGL extensions:** templates list their source GPU's extensions. Those SwiftShader cannot provide are removed, so every advertised extension can be enabled.
- **Noise:** every pod renders through the same SwiftShader build, so canvas, WebGL, audio and client-rect output would otherwise hash identically across the fleet. Each profile gets the engine's per-profile noise, stable across its restarts.
- **Fonts:** Liberation, Carlito and Caladea are renamed to Arial, Times New Roman, Courier New, Calibri and Cambria at build time. Noto faces for other scripts are renamed to the font Windows uses for each script, as in the main image: Nirmala UI for Indic, Segoe UI for Arabic and Hebrew, Microsoft YaHei, Microsoft JhengHei, Yu Gothic UI and Malgun Gothic for CJK (chosen by page language), Segoe UI Emoji, and so on. A private fontconfig exposes only these. No Linux family name is measurable. The template font declaration is not used: with it, the engine hid the faces that were installed.
- **Locale:** the engine reads the timezone only at launch, and Popcorn assigns the proxy after launch. With `BROWSER_TIMEZONE_FROM_PROXY=true` on pool-manager, a proxied session looks up its exit's timezone through the session's sticky proxy username (ipwho.is, then ip-api.com, then the country's main zone), adds it to the allocation as `popcorn.dev/browser-timezone`, and waits while the pod restarts the browser in that zone. Enable it only for a fleet running this image; the main image would restart without using it. Language stays `SHARD_LANGUAGE`, so pages keep the user's language. Geolocation is blocked by policy.

## Compare with MVD emulation disabled

```sh
docker run -d --name popcorn-shard-mvd --platform linux/amd64 --shm-size=1g \
  -e MVD_EMULATOR_OFF=1 \
  -p 127.0.0.1:16086:6080 -p 127.0.0.1:19237:9226 \
  -v popcorn-shard-mvd-data:/home/kernel/user-data \
  popcorn/shard-viewer:local
SHARD_CDP_URL=http://127.0.0.1:19237 SHARD_VIEWER_URL=http://127.0.0.1:16086 \
  node images/shard-vnc-desktop/smoke.mjs
```

`0`, the default, matches the main browser image, where the extension's `emulation-mode.js` keeps the compatibility shims enabled. This launcher rewrites that file at startup from `MVD_EMULATOR_OFF`. Both local modes passed the smoke test.

## Test an authenticated proxy in the regular profile

Create a private JSON file outside the repository, with mode `0600`, containing a `proxy` URL in the form `http://USER:PASSWORD@HOST:PORT` (percent-encode credentials). Then run:

```sh
node images/shard-vnc-desktop/proxy-session.mjs \
  --cdp http://127.0.0.1:19237 --proxy-file /absolute/path/to/private-proxy.json
```

The helper uses the existing regular-profile tab and Popcorn proxy extension, retaining the MVD scripts. It reads the direct baseline from public diagnostic endpoints, installs the HTTP(S) proxy route, and checks two rounds of proxy IP/TLS measurements before opening the target URL. It refuses to replace an already configured extension proxy. Credentials stay in the host process and matching proxy-origin CDP authentication responses; they are not put in page scripts, command arguments, images or logs. Keep the helper running for authentication in this tab. Ctrl+C clears the extension proxy. If cleanup cannot reach the tab, restart this test container before browsing again.

## Pinned dependencies

`package-lock.json` pins SDK 2.1.2 and its dependency graph. `artifacts.lock` records SHA-256 checksums for the upstream Linux browser and fingerprint archives; `runtime.json` records their engine version and TLS metadata. Downloads happen only at image build time. A low-level SDK runtime adapter uses those artifacts without invoking the SDK's automatic updater. Startup checks the actual `/json/version` against the pinned engine version.

To update, download the upstream archives, record their SHA-256 checksums and matching `runtime.json`, review the SDK interface, rebuild and rerun the smoke test. CDN replacements fail checksum verification until explicitly updated. OS packages use the Debian repositories from the pinned Node base image. Widevine is not bundled.

## Smoke test

With the container running, use Node.js 22 or later on the Docker Desktop host:

```sh
node images/shard-vnc-desktop/smoke.mjs
```

The test uses a local HTTP fixture and verifies the engine version, bundled viewer, VNC WebSocket handshake, CDP navigation, mouse input, locale, extension worker and screenshot capture. Set `SHARD_SCREENSHOT=/tmp/popcorn-shard.png` to save the screenshot. Set `SHARD_CDP_URL` and `SHARD_VIEWER_URL` for other forwarded ports; `SHARD_FIXTURE_HOST` changes the hostname the container uses to reach the host fixture. It does not contact external diagnostic sites or validate proxy egress.

To check cookie persistence, run the smoke test once, restart `popcorn-shard`, then run:

```sh
SHARD_EXPECT_PERSISTED=1 node images/shard-vnc-desktop/smoke.mjs
```

## Licensing

The SDK and launcher are MIT licensed. The downloaded engine is closed source with separate use restrictions. This integration is intended for local testing. Review [upstream engine terms](https://github.com/ProxyShard/ShardBrowser#licensing) before commercial deployment or redistribution.
