# [HIGH] Gateway JWT and room password are logged through the WebSocket URL

**File:** [`popcorn-images/images/chromium-headful/client/src/neko/base.ts`](https://github.com/reclaimprotocol/popcorn/blob/main/popcorn-images/images/chromium-headful/client/src/neko/base.ts#L93-L96) (lines 93, 94, 96)
**Project:** popcorn
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `secret-in-log`

## Finding

BaseClient.connect builds the WebSocket URL with the room password in the query string and then emits a debug log containing this._ws.url. In this deployment, the Neko URL is derived from location.pathname, which contains the pool-manager restricted JWT path segment, so the logged WebSocket URL includes both the gateway JWT and password query parameter. The client logging plugin forwards debug logs to OpenTelemetry regardless of the visible log level, so access to the log collector would expose live 24h session bearer tokens that can be used for cross-session browser/CDP/API/AI access.

## Recommendation

Do not log full connection URLs. Redact JWT path segments and password/user query parameters before logging, and avoid putting room passwords in query strings where possible. Add a centralized client-side log scrubber before sending telemetry.
