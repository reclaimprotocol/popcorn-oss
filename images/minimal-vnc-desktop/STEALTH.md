# Stealth — CloakBrowser in minimal-vnc-desktop

This image runs **CloakBrowser** (a stealth-Chromium fork) in place of stock
Chromium so the browser presents as a regular **Windows Chrome** session to
bot classifiers (Akamai BMP, Cloudflare Bot Management, reCAPTCHA Enterprise)
rather than headless-Chrome-on-Linux. Real users drive it over VNC, so the
behavioral layer (mouse/keyboard timing) is genuinely human.

Ported from `popcorn-images` `images/chromium-headful` (branch
`feat/cloakbrowser`); see that image's `docs/STEALTH.md` for the full threat
model and probe scoreboard.

## How the binary gets there

- `Dockerfile` pulls `docker.io/cloakhq/cloakbrowser` pinned by digest (tag
  `0.4.5`, a multi-arch amd64+arm64 index) as a build stage, copies
  `/root/.cloakbrowser` → `/opt/cloakbrowser`, and symlinks its `chrome` to
  `/usr/bin/chromium`. It is the only chromium in the image.
- The chromium shared-library closure CloakBrowser links against is installed
  via the pinned chromium runtime-lib block in `locks/apt-packages.txt`
  (versions resolved from the frozen Ubuntu snapshot). The xtradeb chromium
  `.deb`s are **not** installed.
- Build **natively** per host arch. Do not force amd64 under QEMU on arm64 —
  chromium SIGTRAPs under emulation.
- Override the pin at build time: `CLOAKBROWSER_IMAGE=… ./build.sh`.

## Launch flags (`start-chromium`)

- `--fingerprint-platform=windows` — spoofs the User-Agent, `navigator.platform`,
  `userAgentData`, and Sec-CH-UA-Platform to Windows.
- `--fingerprint=<seed>` — per-instance seed, persisted in
  `user-data/.cloak-fingerprint-seed` so the identity is stable across restarts.
- `--fingerprint-timezone` / `--fingerprint-locale` / `--lang` — aligned with the
  egress IP via geoip and persisted. `TZ` + `/etc/localtime` are realigned too.
- `--fingerprint-webrtc-ip=auto` — STUN candidates resolve to the proxy exit IP.
- `--use-fake-device-for-media-stream` — non-empty `enumerateDevices()`.
- `--disable-gpu --use-gl=swiftshader --enable-unsafe-swiftshader` — software
  WebGL so the renderer-string spoof has a real GL context.
- MediaRouter is **not** disabled (empty `chrome.cast` is a tell).

## Operator knobs (env)

| Env | Default | Purpose |
|---|---|---|
| `CLOAK_FINGERPRINT_SEED` | random (CSPRNG) | Pin the seed. **Use this** if the WebGL renderer resolves to a flagship discrete GPU — under SwiftShader that's a deterministic Akamai tell. Pin a seed that maps to an integrated Intel GPU. |
| `CLOAK_GEOIP` | `true` | Resolve tz/locale from exit IP at first boot (needs `curl`, kept in image). |
| `CLOAK_TIMEZONE` / `CLOAK_LOCALE` | geoip → `America/Los_Angeles` / `en-US` | Manual pin when geoip is off. |
| `CLOAK_WEBRTC_IP` | `auto` (w/ geoip) | Literal WebRTC IP override. |
| `CLOAK_PROFILE_SEED` | — | Path to a `profile-state.tar.gz` to start pre-warmed/pre-authenticated. Treat as a credential. |

## Caveats

- **Not build-tested in-repo** — requires `docker buildx` and pulling the
  CloakBrowser image. Build with `./build.sh`, then verify the boot banner:
  `docker logs <ctr> | grep stealth`.
- The `--kiosk` geometry leak (`outerHeight` < `innerHeight`) is a known minor
  tell not yet patched here.
