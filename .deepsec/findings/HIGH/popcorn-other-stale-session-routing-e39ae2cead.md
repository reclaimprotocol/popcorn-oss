# [HIGH] Session cleanup leaves stale privileged route keys

**File:** [`services/pool-manager/src/services/db.ts`](https://github.com/reclaimprotocol/popcorn/blob/main/services/pool-manager/src/services/db.ts#L18-L67) (lines 18, 24, 30, 32, 34, 36, 43, 63, 64, 65, 66, 67)
**Project:** popcorn
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `other-stale-session-routing`

## Owners

**Suggested assignee:** `ar1242112@gmail.com` _(via last-committer)_

## Finding

createSession stores the session record in the sessions hash without a TTL and creates several 24-hour route keys. deleteSession removes only the sessions hash field and route:${id}; it does not delete route:cdp:${id}, route:api:${id}, route:ai:${id}, or route:cdp-internal:${id}. Gateway locations use those remaining keys for CDP, kernel API, AI, and internal CDP routing. Existing JWTs can therefore continue reaching stale privileged routes after explicit deletion, and TTL-controller GameServer expiry can leave session records/routes alive long enough to target a reused pod IP.

## Recommendation

Make session and route lifetimes match the GameServer lifetime. Delete all route prefixes and the session record atomically on every delete/expiry path, and have the TTL cleanup path remove Redis state before or while deleting the GameServer.

## Recent committers (`git log`)

- Abdul Rashid <ar1242112@gmail.com> (2026-04-09)
- Karam19 <karam.shbeb1@hotmail.com> (2026-03-31)
