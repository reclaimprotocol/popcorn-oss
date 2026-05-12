# [MEDIUM] Unauthenticated heartbeat endpoint allows unbounded Redis writes

**File:** [`services/pool-manager/index.ts`](https://github.com/reclaimprotocol/popcorn/blob/main/services/pool-manager/index.ts#L265-L269) (lines 265, 266, 268, 269)
**Project:** popcorn
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `missing-auth`

## Owners

**Suggested assignee:** `codex@openai.com` _(via last-committer)_

## Finding

POST /heartbeat has no authentication and writes body.name directly into the pod_heartbeats Redis hash. Through the gateway fallback this is a public write sink; an attacker can spoof heartbeat state and grow Redis memory indefinitely by submitting many unique names.

## Recommendation

Authenticate heartbeat calls with a pod/service token or restrict the route to internal network paths. Validate pod names, cap length, add TTL/cleanup, and rate limit writes.

## Recent committers (`git log`)

- Codex <codex@openai.com> (2026-05-04)
- Abdul Rashid <ar1242112@gmail.com> (2026-04-16)
