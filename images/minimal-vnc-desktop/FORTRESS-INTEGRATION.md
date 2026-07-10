# Tilion Fortress — the browser engine (replaces CloakBrowser)

**Tilion Fortress** (`tilion/fortress`, a stealth stock-Chromium fork with C++
persona patches) is now the **sole browser** in `minimal-vnc-desktop` —
CloakBrowser has been **removed**. We pin the **stable channel — tag `149`
(Chromium 149.0.7827.232)**, NOT the newer `:151`/`:latest`, because 149 matches
the mass of real Chrome users and blends in best. `start-chromium` defaults to
`BROWSER=fortress` and `/usr/bin/chromium` is symlinked to the launcher; the
Dockerfile bakes the binary in. Because Fortress is **x86_64-only** and has no
arm64 manifest, **the whole image is now amd64-only** — build & run on a native
amd64 host (Chromium SIGTRAPs under QEMU).

## Reality check — read first
We proved empirically (invisible_playwright, native macOS) that **the browser is
not what blocks Netflix / Taj — IP reputation is**:
- Netflix login **succeeded** on a clean home residential IP, **failed** on the
  burned BrightData `websdk_staging` proxy exit — identical browser/account. The
  failure was a reCAPTCHA **Enterprise** low-score soft-reject (`CLCSScreenUpdate`
  GraphQL returned 200 with "Something went wrong"), driven purely by the exit IP.
- Spotify **passed** on that same proxy exit (its check is lenient).
- Taj (NeuPass, reCAPTCHA Enterprise) **failed** on the proxy — same mechanism.

**Fortress will behave identically.** This swap is worth doing for stock-Chromium
coherence (vs ungoogled) and CDP hardening, but it will **not** fix Netflix/Taj.
The lever for those is: clean **sticky residential/mobile** proxy (one exit per
user) + **persistent per-user profiles** (see the fleet.yaml / profile-warming work).

## What Fortress actually is (verified from the stable-149 image, 2026-07-06)
- Binary: `/opt/tilion/tilion` — a **2.4KB bash launcher wrapper** around
  `/opt/tilion/chrome` (326MB, patched **Chromium 149.0.7827.232**). The image's
  own `README.txt` banner still says "Chromium 151" — that's a **stale generic
  string**; the Docker Hub tag `149`/`149.0.7827.232` and the build number are
  authoritative.
- The wrapper applies a default Windows persona via `--uxr-*` flags
  (`--uxr-platform=Win32 --uxr-ua-platform=Windows --uxr-ua-os="Windows NT 10.0; Win64; x64"
  --uxr-hw-concurrency=16 --uxr-device-memory=8 --uxr-screen-{width,height}=1920/1080
  --uxr-webrtc-policy=disable_non_proxied_udp …`) and bundled Windows fonts
  (`/opt/tilion/fonts` + a `fonts.conf.template` it renders into
  `$XDG_CACHE_HOME/tilion/fonts.conf` at launch and exports as `FONTCONFIG_FILE`).
  **No `--fingerprint-*` dialect.**
- ⚠️ **Persona is NOT fully coherent on this build:** the default persona claims
  a discrete GPU — `--uxr-webgl-vendor="Google Inc. (NVIDIA)"`,
  `--uxr-webgl-renderer="ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 …, D3D11)"`,
  `--uxr-webgpu-description="NVIDIA GeForce RTX 3060"` — while actually rendering
  through **SwiftShader** (`--use-angle=swiftshader`,
  `VK_ICD_FILENAMES=…/vk_swiftshader_icd.json`, `--use-webgpu-adapter=swiftshader`).
  That is exactly the incoherent-hardware-GPU-on-software-renderer tell strict
  detectors cross-check. To go coherent, override the GPU persona via
  `CHROMIUM_FLAGS='--uxr-webgl-vendor=... --uxr-webgl-renderer=...'` (last flag
  wins) or launch bare with `TILION_NO_DEFAULTS=1` and supply your own `--uxr-*`.
- Env knobs: `TILION_TZ` (also sets process `TZ` so tz is coherent from the first
  tick), `TILION_LANG`, `TILION_NO_DEFAULTS=1` (bare launch, skip the persona).
- It **strips** `--user-agent` (would drop UA Client Hints) and
  `--enable-automation` (automation tell) from forwarded args.
- Their image entrypoint is `dumb-init -- docker-entrypoint.sh` — **irrelevant to
  us**: we bake `/opt/tilion` in and exec `/opt/tilion/tilion` directly from
  `start-chromium`, so the existing `novnc-proxy --cdp-upstream 127.0.0.1:9223`
  bridge handles CDP unchanged — **no socat / no CDP change needed.**
- Image: `tilion/fortress@sha256:a5e31e67b53c11f5992fb74e4acc4c6c5313cc960def5c5898d198713a58b72a`
  (tag `149`, `linux/amd64` only — **no arm64 manifest**).

## start-chromium — DONE
`BROWSER` defaults to `fortress`: `CHROME_BIN=/opt/tilion/tilion`, exits cleanly
if the binary is absent, exports `TILION_TZ=$CLOAK_TIMEZONE` /
`TILION_LANG=$CLOAK_LOCALE`, and passes **no** `--fingerprint-*`/`gpu_flags`
(persona comes from the wrapper). `BROWSER=fingerprint` remains an opt-in path
(fingerprint-chromium, if baked in); the old `cloak` value now errors out.
Everything else (kiosk, window size, 3p-cookie levers, proxy flags,
`--user-data-dir=$HOME/user-data`, proxy extension, `CHROMIUM_FLAGS`
passthrough) is shared and already correct.

## Dockerfile — DONE
`ARG FORTRESS_IMAGE=…@sha256:a5e31e67…` (tag `149`, stable) replaces the old
`CLOAKBROWSER_IMAGE`; `FROM ${FORTRESS_IMAGE} AS fortress` follows the build
platform (amd64). A single overlay layer does
`COPY --from=fortress /opt/tilion /opt/tilion`, asserts both binaries are
executable, **symlinks `/usr/bin/chromium` + `/usr/bin/chromium-browser` to the
launcher** (so `chromium` = Fortress), and applies `SOURCE_DATE_EPOCH`
touch-normalization. The CloakBrowser stage, overlay, and ARG are gone. On an
arm64 host the `fortress` FROM has no manifest, so the build fails there by
design — this image is amd64-only.

## Runtime-lib check (Chromium 149 vs Ubuntu 22.04 snapshot) — VERIFY
Fortress links against system libs supplied by `locks/apt-packages.txt`. Chromium
149 is newer than the CloakBrowser build, so confirm nothing is missing:
```bash
docker run --rm --entrypoint ldd <image> /opt/tilion/chrome | grep -i "not found"
```
If anything is "not found", add the package to `locks/apt-packages.txt` (likely
none — the chromium runtime-lib closure is broad — but glibc/NSS/`libX*` are the
usual suspects for a newer Chromium).

## Build & test (amd64 host or cluster)
```bash
# from images/minimal-vnc-desktop
./build.sh              # or the repo's buildx invocation, on linux/amd64
# run with Fortress selected:
docker run --rm -e BROWSER=fortress -p 6080:6080 -p 9222:9222 <image>
```
Then verify, in order:
1. **Boot log** shows `[stealth] browser: Tilion Fortress (stable stealth Chromium 149)`.
2. **VNC** (`:6080`) — the browser opens headed in kiosk mode and is drivable.
3. **stealth-tests probe suite**: `cd stealth-tests && node run.mjs` against the
   CDP endpoint — expect navigator.webdriver=false, coherent Windows UA + Client
   Hints (the `--uxr` persona), no CDP `Runtime.enable` tell.
4. **antcpt score** (lenient sanity check) ≈ 0.9 on a clean IP — necessary, not
   sufficient (it doesn't reflect Enterprise/DataDome; see reality check).
5. **CDP still bridged**: `curl http://127.0.0.1:9222/json/version` from the host
   returns the Fortress build (proves the novnc-proxy bridge works with 149).

## Known gaps / notes
- **Incoherent GPU persona (stable-149) — verified 2026-07-06.** Contrary to an
  earlier note, this stable build's default persona DOES claim an RTX 3060
  (`--uxr-webgl-renderer="ANGLE (NVIDIA, … RTX 3060 …, D3D11)"`) while rendering
  through SwiftShader — the incoherent-hardware-on-software tell. This is the
  usual container GL problem, not a Fortress-specific regression, but do not
  assume "coherent by default". For strict flows either override the GPU `--uxr`
  flags via `CHROMIUM_FLAGS` to match SwiftShader (e.g. a software/`SwiftShader`
  renderer string) or run `TILION_NO_DEFAULTS=1` with a hand-built coherent
  persona. Datacenter GL remains detectable by DataDome regardless.
- **Double `--disable-features` (pre-existing):** `start-chromium` emits
  `--disable-features=TrackingProtection3pcd` (3p-cookie block) *and*
  `--disable-features=Translate,OptimizationHints` (base flags). Chromium honors
  only the **last** one, so `TrackingProtection3pcd` is currently dropped for all
  browsers. Fortress is stock Chromium (3p cookies allowed in normal windows by
  default), so this matters less, but consider merging both into one
  `--disable-features=` list. Not Fortress-specific; out of scope here.
- **arm64 is unsupported**: with CloakBrowser removed there is no arm64 browser.
  The `fortress` build stage has no arm64 manifest, so `./build.sh` on arm64
  fails at pull. Build and run on amd64 only.
