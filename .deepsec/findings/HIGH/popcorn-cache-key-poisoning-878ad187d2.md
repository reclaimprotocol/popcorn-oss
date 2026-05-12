# [HIGH] User-controlled session IDs can poison Redis route keys

**File:** [`services/pool-manager/src/services/db.ts`](https://github.com/reclaimprotocol/popcorn/blob/main/services/pool-manager/src/services/db.ts#L17-L43) (lines 17, 18, 24, 30, 32, 34, 36, 43)
**Project:** popcorn
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `cache-key-poisoning`

## Owners

**Suggested assignee:** `ar1242112@gmail.com` _(via last-committer)_

## Finding

DB.createSession builds Redis routing keys by concatenating the raw session ID into keys like route:${id}, route:cdp:${id}, route:api:${id}, and route:cdp-internal:${id}. The public pool-manager create path accepts an optional sessionId as-is, so a valid client can choose an existing session ID to overwrite that session's routing records, or choose delimiter-bearing IDs such as cdp:<victimId> so route:${id} collides with another session's route:cdp:<victimId> key. Because the gateway trusts these Redis keys for browser/CDP/API/AI routing, this enables cross-session route poisoning or denial of service when a victim session ID is known.

## Recommendation

Do not use caller-supplied IDs directly in Redis route keys. Prefer full server-generated high-entropy IDs, reject duplicates with HSETNX/SET NX or a transaction, validate IDs to a delimiter-free format, and encode or namespace key components so one route family cannot collide with another.

## Recent committers (`git log`)

- Abdul Rashid <ar1242112@gmail.com> (2026-04-09)
- Karam19 <karam.shbeb1@hotmail.com> (2026-03-31)
