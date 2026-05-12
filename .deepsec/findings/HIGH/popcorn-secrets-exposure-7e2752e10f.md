# [HIGH] Client telemetry defaults to an external collector and logs JWT material

**File:** [`popcorn-images/images/chromium-headful/client/src/plugins/otel.ts`](https://github.com/reclaimprotocol/popcorn/blob/main/popcorn-images/images/chromium-headful/client/src/plugins/otel.ts#L9-L55) (lines 9, 17, 19, 35, 51, 55)
**Project:** popcorn
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `secrets-exposure`

## Finding

If VUE_APP_OTEL_COLLECTOR_URL is unset, the browser client sends OTLP logs to https://raven.reclaimprotocol.org:4318/v1/logs. This is dangerous because the imported log plugin emits sensitive Neko debug logs into this exporter, including session-bearing URLs and websocket payloads. This file also writes the URL path segments, the apparent JWT, and decoded claims to console logs, putting bearer-token material into client logs. In this system, a leaked gateway JWT can grant access to the user's browser session until expiry.

## Recommendation

Remove the hard-coded external fallback and require an explicitly configured, deployment-owned collector or disable telemetry by default. Remove JWT/path console logging and ensure telemetry resources contain only non-sensitive identifiers.
