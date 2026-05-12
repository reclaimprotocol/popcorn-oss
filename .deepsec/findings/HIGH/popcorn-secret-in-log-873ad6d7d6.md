# [HIGH] Telemetry exports session credentials and payloads regardless of log level

**File:** [`popcorn-images/images/chromium-headful/client/src/plugins/log.ts`](https://github.com/reclaimprotocol/popcorn/blob/main/popcorn-images/images/chromium-headful/client/src/plugins/log.ts#L96-L140) (lines 96, 101, 116, 128, 140)
**Project:** popcorn
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `secret-in-log`

## Finding

The logger disables only console output when log_level is off, but still calls logger.emit for error, warn, info, and debug records. The Neko client wires its debug events into window.$log, and those debug events include the full WebSocket URL, which contains the gateway JWT in the path and the Neko password in the query string, plus outgoing/incoming websocket payloads such as clipboard, chat, broadcast URLs, and WebRTC signaling data. Because plugins/otel.ts defaults the exporter to an external collector, anyone with access to that collector or its stored logs can recover session tokens and potentially replay them for cross-session browser access.

## Recommendation

Do not emit debug/info payloads to telemetry by default. Make telemetry honor the configured log level, redact JWTs, passwords, URLs, clipboard content, and websocket payloads before export, and remove logging of full WebSocket URLs at the source.
