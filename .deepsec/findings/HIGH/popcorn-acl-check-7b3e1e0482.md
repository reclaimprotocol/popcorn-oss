# [HIGH] Gateway JWTs are not bound to the session path

**File:** [`services/pool-manager/index.ts`](https://github.com/reclaimprotocol/popcorn/blob/main/services/pool-manager/index.ts#L90-L101) (lines 90, 97, 98, 99, 100, 101)
**Project:** popcorn
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `acl-check`

## Owners

**Suggested assignee:** `codex@openai.com` _(via last-committer)_

## Finding

buildSessionDetails signs JWTs for a session and embeds the sessionId separately in gateway paths. Following the gateway flow shows the token signature/scope is checked, but the JWT sub is not compared to the path session_id before nginx uses that path value to select Redis route keys. A valid token for one session can therefore be replayed against another known session path for browser, CDP, API, or AI routing; a valid internal token can be replayed against another session's internal CDP route.

## Recommendation

Bind gateway authorization to the routed session: pass the path session_id into auth.check and reject unless jwt_obj.payload.sub exactly matches it. Add cross-session replay tests for every gateway route.

## Recent committers (`git log`)

- Codex <codex@openai.com> (2026-05-04)
- Abdul Rashid <ar1242112@gmail.com> (2026-04-16)
