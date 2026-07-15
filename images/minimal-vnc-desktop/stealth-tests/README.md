# Stealth-probe suite (minimal-vnc-desktop)

End-to-end checks for the CloakBrowser stealth surface. Each probe attaches
to the **running container's** chromium over CDP and drives it directly, so
it exercises the real image, not a mock. Ported from `popcorn-images`
`chromium-headful/stealth-tests`.

Unlike that image, minimal-vnc-desktop ships **no node/playwright**, so the
suite runs from the **host** and connects to the **full CDP proxy** (`9226`).
The restricted proxy (`9222`) filters out the `Runtime`/`Page`/`Fetch`
commands the probes need — it will not work.

## Probes

| Probe         | Pass criterion                                                     |
| ------------- | ------------------------------------------------------------------ |
| `tls`         | tls.peet.ws JA4 contains the Chrome cipher hash `_8daaf6152771_`    |
| `sannysoft`   | Zero failed checks on bot.sannysoft.com                            |
| `creepjs`     | CreepJS trust score ≥ 70%                                          |
| `cloudflare`  | chat.openai / discord / cloudflare.com served without a challenge  |
| `turnstile`   | peet.ws non-interactive Turnstile auto-issues a token within 25s   |
| `recaptcha`   | reCAPTCHA v3 score ≥ 0.7 via antcpt.com                            |
| `browserscan` | browserscan.net verdict "Normal"/"Human"                          |
| `akamai`      | `_abck` token == `0` on Delta/Finnair/Hilton/ANA (needs a proxy)   |

## Setup (host)

```bash
cd images/minimal-vnc-desktop/stealth-tests
npm install          # installs playwright-core
```

Start the container publishing the **full CDP** port:

```bash
docker run --rm -it \
  --tmpfs /dev/shm:size=1g \
  -p 6080:6080 -p 9222:9222 -p 9226:9226 \
  popcorn/minimal-vnc-desktop:local
```

## Run

```bash
# all probes
node run.mjs

# subset
node run.mjs tls sannysoft creepjs

# different CDP endpoint (e.g. remote host, or inside-container 9223)
CDP_URL=http://127.0.0.1:9226 node run.mjs
```

Exit code: `0` all pass, `1` a probe failed, `2` a probe threw.

## Through a BrightData (or any authenticated) proxy

The suite sets the proxy on the running browser via the bundled `__pcn`
extension and answers the proxy's auth challenge over CDP — no container
relaunch. Point `HTTPS_PROXY_URL` at the proxy (creds embedded) and pick a
country with `PROXY_GEO` (substituted into the `{{geoLocation}}` template):

```bash
export HTTPS_PROXY_URL='https://brd-customer-…-country-{{geoLocation}}:PASSWORD@brd.superproxy.io:33335/'
PROXY_GEO=jp node run.mjs akamai
```

`HTTPS_PROXY_URL` is a **credential** — keep it in your shell/secret store,
never commit it. Rotate if it leaks.

### Align the fingerprint with the proxy country

CloakBrowser's fingerprint (timezone/locale/WebRTC-IP) is fixed at **launch**,
and its boot-time geoip resolves the *container's* egress, not the proxy. So
when testing through a country proxy, launch the container with a **matching**
region, otherwise a mismatched timezone/locale is itself a bot tell:

```bash
docker run --rm -it --tmpfs /dev/shm:size=1g \
  -p 6080:6080 -p 9222:9222 -p 9226:9226 \
  -e CLOAK_GEOIP=false -e CLOAK_TIMEZONE=Asia/Tokyo -e CLOAK_LOCALE=ja-JP \
  popcorn/minimal-vnc-desktop:local
# then: PROXY_GEO=jp node run.mjs
```

Note the `__pcn` proxy setting persists on the browser after the run (stored
in the extension); restart the container or call `__pcn.clear()` to reset.

## Expected results

Same scoreboard as the reference image (see `../STEALTH.md`):

- **tls / sannysoft / creepjs / browserscan / cloudflare** — should PASS;
  regressions here indicate a CloakBrowser-side surface change.
- **turnstile / recaptcha** — pass on clean residential IPs; recaptcha can
  warn on a cold cookie jar (no google.com history).
- **akamai** — Delta/Finnair/Hilton tend to pass through residential; ANA
  often stays `-1` on shared proxy ranges (IP reputation, not fingerprint).

## When a probe regresses

1. Re-run it in isolation: `node run.mjs <probe>`.
2. `docker logs <ctr> | grep '\[stealth\]'` — confirm every flag is on.
3. Open the site manually in the live view — sometimes it's the DOM scrape
   that broke, not the underlying signal.
