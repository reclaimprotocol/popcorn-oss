# [HIGH] Full internal CDP proxy is reachable without the required internal JWT

**File:** [`popcorn-images/server/cmd/api/main.go`](https://github.com/reclaimprotocol/popcorn/blob/main/popcorn-images/server/cmd/api/main.go#L236-L274) (lines 236, 249, 264, 269, 270, 274)
**Project:** popcorn
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `auth-bypass`

## Finding

The gateway requires internal scope for /cdp-internal, but this service also starts an unfiltered CDP proxy on 0.0.0.0:9226 with wildcard CORS and no token check. The internal router exposes /json and /json/list to discover debugger WebSocket URLs, then forwards all remaining paths to the unfiltered WebSocketProxyHandler. Any origin or network peer that can reach this port can drive the browser through full CDP without the internal-scoped gateway token.

## Recommendation

Require authentication at the CDP service port itself, remove wildcard CORS, restrict WebSocket origins, and expose the full CDP listener only through a protected gateway path or a private channel unavailable to browser page content and other pods.
