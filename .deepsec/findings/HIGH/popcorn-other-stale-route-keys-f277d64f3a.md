# [HIGH] Session deletion leaves CDP, API, AI, and internal route keys active

**File:** [`services/pool-manager/index.ts`](https://github.com/reclaimprotocol/popcorn/blob/main/services/pool-manager/index.ts#L177-L188) (lines 177, 180, 184, 188)
**Project:** popcorn
**Severity:** HIGH  •  **Confidence:** medium  •  **Slug:** `other-stale-route-keys`

## Owners

**Suggested assignee:** `codex@openai.com` _(via last-committer)_

## Finding

deleteSession delegates cleanup to DB.deleteSession, which removes the session hash and only route:<id>. The related route:cdp:<id>, route:cdp-internal:<id>, route:api:<id>, and route:ai:<id> keys remain until their 24h TTL. Existing JWTs can continue routing during pod shutdown, and stale IP:port mappings may later point at a different user's pod if Kubernetes reuses the IP.

## Recommendation

Delete every route key for the session in the same cleanup path, and consider a session revocation marker checked by the gateway before proxying.

## Recent committers (`git log`)

- Codex <codex@openai.com> (2026-05-04)
- Abdul Rashid <ar1242112@gmail.com> (2026-04-16)
