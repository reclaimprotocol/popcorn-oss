# Clearcote live viewer

This opt-in runtime uses Clearcote's official image, with the shared Popcorn viewer and CDP proxy compiled from this checkout. It does not copy the Fortress browser or require a pre-existing local browser image. The existing fleet image and deployment defaults are unchanged.

The pinned official image contains Clearcote SDK 0.54.0 and open Chromium 150.0.7871.114. Changing browser versions requires a real engine update and verification through `/json/version`; changing only the UA would introduce inconsistencies. The image is Linux/amd64; Docker Desktop uses emulation on Apple silicon.

## Build and run

From the repository root:

```sh
docker build --platform linux/amd64 -f images/clearcote-vnc-desktop/Dockerfile -t popcorn/clearcote-viewer:local .
docker run -d --name popcorn-clearcote --platform linux/amd64 --shm-size=1g \
  -p 127.0.0.1:16084:6080 -p 127.0.0.1:19233:9226 \
  popcorn/clearcote-viewer:local
```

Open <http://127.0.0.1:16084/liveview.html?resize=scale&autoconnect=1&compression=1&quality=6>. The initial page is blank until the session launcher verifies routing. CDP provides full browser control: keep these ports bound to loopback.

Defaults reproduce the tested setup:

- Windows persona, with native Clearcote UA/Client Hints and Windows font setup.
- A stable `CC_FINGERPRINT=popcorn-windows-1920` seed; supply your own stable seed for another profile.
- 1920 × 1080 kiosk mode, matching real X display, screen/available dimensions and viewport. Set both `WIDTH` and `HEIGHT` to change geometry; the launcher derives matching switches.
- `CC_TIMEZONE=Asia/Kolkata` and `CC_ACCEPT_LANGUAGE=en-IN,en`. Adjust these when choosing another proxy country.
- `MVD_EMULATOR_OFF=1`, so the viewer cannot overwrite the engine's platform and screen values.
- `--disable-quic` and `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, since the session's context-level HTTP proxy does not invoke the SDK's proxy launch defaults.

Clearcote's Windows persona still runs on Linux with software rendering. This setup and the diagnostic checks do not certify that every signal matches a physical Windows machine or guarantee acceptance by an airline.

## Start a verified proxy session

Requires Node.js 22 or later. Supply the following through your existing secret manager or a private environment file outside this repository (mode `0600`):

```dotenv
PROXY_SERVER=http://brd.superproxy.io:33335
PROXY_USERNAME=brd-customer-YOUR_CUSTOMER-zone-YOUR_ZONE
PROXY_PASSWORD=YOUR_PASSWORD
PROXY_COUNTRY=IN
```

Use the base username without country/session suffixes. The launcher adds one stable hashed session ID and `-const`. Bright Data documents `-const` for Residential/Mobile: if the chosen peer is unavailable, it returns an error instead of substituting another peer. It is not a permanent static-IP allocation. See the [provider's proxy reference](https://github.com/brightdata/skills/blob/main/skills/proxy/SKILL.md).

```sh
node --env-file=/absolute/path/to/private.env scripts/clearcote/session.mjs \
  --url https://www.delta.com/ --har /tmp/popcorn-delta.har
```

The launcher first measures direct egress using only public diagnostic endpoints, then creates an isolated proxy context with no DIRECT fallback. It verifies the requested country and compares two uncached rounds of IPify and TLS endpoint measurements. All proxy exits must agree, differ from direct egress, and retain the direct browser's normalized TLS capabilities and HTTP/2 signature. Raw JA4 is recorded, but extension ordering, GREASE and the TLS 1.3 resumption extension are normalized for comparison; resumption can legitimately change JA4. Transmitted UA/Client Hint versions and platform must agree too. Responses must belong to the exact fresh navigation URL, excluding stale JSON from a previous check.

Only after these checks pass does it open the target site. Checks fail closed on missing responses, drift, direct egress, authentication failures or fingerprint differences. They validate the observed samples, not future reachability or a site's private risk score. No TLS challenges or cookies are forged.

Keep the process running: it handles proxy authentication and capture. Credentials are supplied only to a matching proxy-origin challenge, with a bounded retry; never to website Basic authentication. Ctrl+C closes this test context. Browser and proxy credentials are not put in the image or Docker environment. An optional `PROXY_SESSION_ID` reuses the same logical provider session; otherwise one is generated for each run.

Use `--verify-only` to run the checks without opening an application or leaving a test context running. The launcher re-enables normal caching after the diagnostic phase for browsing performance.

## Captures and validation

The HAR omits request bodies and response bodies, except allowlisted error/challenge metadata. Cookie values, credential headers, query values and Delta flow IDs are redacted before writing. It preserves cookie names, UA/Client Hints, endpoint paths and response codes for diagnosis. Treat captures as private: paths, IPs and metadata can still identify a session. The accompanying `.verification.json` records measured egress and TLS/browser metadata without credentials.

A CDP HAR normalizes header order, omits TLS handshakes and can merge HTTP/2 cookie headers. HAR Analyzer's header-order and cookie-splitting findings therefore require wire-level confirmation; use the TLS endpoint report for the measured connection signature. The launcher does not upload captures.

```sh
node --test scripts/clearcote/egress.test.mjs
```

The tests cover fail-closed routing checks, TLS/Client Hint mismatches, strict session construction, credential origin checks and HAR redaction. Live verification uses the same launcher with `--verify-only`; it does not submit credentials or OTPs to the target site.
