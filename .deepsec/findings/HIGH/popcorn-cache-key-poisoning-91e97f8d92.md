# [HIGH] Caller-controlled session IDs can overwrite Redis route mappings

**File:** [`services/pool-manager/index.ts`](https://github.com/reclaimprotocol/popcorn/blob/main/services/pool-manager/index.ts#L78-L261) (lines 78, 80, 107, 124, 254, 260, 261)
**Project:** popcorn
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `cache-key-poisoning`

## Owners

**Suggested assignee:** `codex@openai.com` _(via last-committer)_

## Finding

readRequestedSessionId accepts body.sessionId and createSession uses it directly as the Redis session and route key. The public POST /session path does not validate uniqueness or ownership before DB.createSession writes route:* keys. A client who knows a victim session ID can create a new session with that ID, overwriting the victim's routing entries and causing existing victim URLs for that session ID to route to the attacker's newly allocated pod.

## Recommendation

Reject duplicate session IDs unless the existing session belongs to the same client and the operation is an explicit resume. Use an atomic create-if-absent operation or transaction for the session hash and all route keys.

## Recent committers (`git log`)

- Codex <codex@openai.com> (2026-05-04)
- Abdul Rashid <ar1242112@gmail.com> (2026-04-16)
