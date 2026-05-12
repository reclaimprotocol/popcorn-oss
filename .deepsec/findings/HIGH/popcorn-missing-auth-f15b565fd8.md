# [HIGH] ChromeDriver proxy exposes unauthenticated browser automation

**File:** [`popcorn-images/server/cmd/api/main.go`](https://github.com/reclaimprotocol/popcorn/blob/main/popcorn-images/server/cmd/api/main.go#L281-L299) (lines 281, 293, 298, 299)
**Project:** popcorn
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `missing-auth`

## Finding

main.go starts the ChromeDriver proxy on 0.0.0.0 with no authentication middleware. The proxied handler creates WebDriver/BiDi sessions attached to the existing Chromium instance, so any peer that can reach this port can automate navigation and browser interaction outside the gateway's session-token checks.

## Recommendation

Add service-layer authentication to the ChromeDriver proxy, bind it only to a protected interface/channel, and block direct access from browser-rendered pages and untrusted cluster peers.
