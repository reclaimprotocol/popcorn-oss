# [HIGH_BUG] Allocation failures after GameServer creation leak capacity

**File:** [`services/pool-manager/index.ts`](https://github.com/reclaimprotocol/popcorn/blob/main/services/pool-manager/index.ts#L112-L163) (lines 112, 124, 161, 163)
**Project:** popcorn
**Severity:** HIGH_BUG  •  **Confidence:** high  •  **Slug:** `other-resource-leak`

## Owners

**Suggested assignee:** `codex@openai.com` _(via last-committer)_

## Finding

createSession allocates an Agones GameServer before persisting the session in Redis. If DB.createSession or later setup fails, the catch block returns 503 without shutting down the already allocated GameServer. During Redis or setup outages, repeated create attempts can strand allocated browser pods and exhaust fleet capacity.

## Recommendation

Track the allocated GameServer name and best-effort shut it down in the error path whenever allocation succeeded but session creation did not complete.

## Recent committers (`git log`)

- Codex <codex@openai.com> (2026-05-04)
- Abdul Rashid <ar1242112@gmail.com> (2026-04-16)
