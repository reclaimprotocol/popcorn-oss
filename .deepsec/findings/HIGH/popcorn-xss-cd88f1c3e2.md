# [HIGH] Stored XSS in admin GameServer list via attacker-controlled session IDs

**File:** [`services/pool-manager/public/admin.html`](https://github.com/reclaimprotocol/popcorn/blob/main/services/pool-manager/public/admin.html#L180-L203) (lines 180, 192, 203)
**Project:** popcorn
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `xss`

## Owners

**Suggested assignee:** `codex@openai.com` _(via last-committer)_

## Finding

The admin page renders `/admin/servers` data with `innerHTML` and interpolates `p.sessionId` directly into both text and an inline `onclick` handler. Normal authenticated clients can choose `sessionId` on `POST /session`; the backend stores it as-is in Redis and `/admin/servers` reflects Redis session IDs into this page. A malicious client can create a session ID containing HTML or JavaScript-breaking characters, and the payload will execute when an administrator opens or polls the admin page. Because this runs on the admin origin with Basic auth automatically sent on same-origin requests, the payload can call admin endpoints, fetch session details including privileged URLs returned by the backend, or shut down GameServers.

## Recommendation

Do not build admin rows with HTML string concatenation. Render untrusted values with `textContent`/DOM APIs, store IDs in `data-*` attributes, and attach event listeners programmatically. Also validate session IDs server-side to a strict safe character set and length.

## Recent committers (`git log`)

- Codex <codex@openai.com> (2026-05-04)
- Abdul Rashid <ar1242112@gmail.com> (2026-03-01)
