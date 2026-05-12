# [HIGH] Public get and delete routes do not enforce session ownership

**File:** [`services/pool-manager/index.ts`](https://github.com/reclaimprotocol/popcorn/blob/main/services/pool-manager/index.ts#L120-L281) (lines 120, 167, 174, 242, 247, 275, 281)
**Project:** popcorn
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `cross-tenant-id`

## Owners

**Suggested assignee:** `codex@openai.com` _(via last-committer)_

## Finding

Sessions store the creating clientId, but getSessionDetails and deleteSession only look up by caller-supplied sessionId. The public GET and DELETE routes authenticate the client but never verify that the session belongs to that client. Any valid client that knows or guesses another session ID can mint fresh connection URLs for it or delete it.

## Recommendation

Pass the authenticated identity into get/delete operations and require session.clientId to match identity.clientId for public routes. Keep admin routes as the explicit cross-client exception.

## Recent committers (`git log`)

- Codex <codex@openai.com> (2026-05-04)
- Abdul Rashid <ar1242112@gmail.com> (2026-04-16)
