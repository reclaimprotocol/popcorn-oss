# [FALSE POSITIVE] Public session responses expose full-access CDP URL

**File:** [`services/pool-manager/index.ts`](https://github.com/reclaimprotocol/popcorn/blob/main/services/pool-manager/index.ts#L90-L261) (lines 90, 91, 99, 160, 174, 261)
**Project:** popcorn
**Original severity:** HIGH  •  **Confidence:** high  •  **Slug:** `secrets-exposure`

## Triage update

False positive as written. `cdpInternalUrl` is a legacy/misleading field name:
in this product flow it represents the intentionally exposed full-access CDP
URL, not an accidental internal-service-only URL. Public session responses are
expected to provide this full CDP capability when the caller is authorized to
create/access that session.

Future scans should not flag `cdpInternalUrl` exposure by name alone. Instead,
flag cases where unrelated service/admin credentials are exposed, where a route
returns full-access CDP contrary to the current product policy, or where the
gateway scope check for the full-access CDP route is weakened unexpectedly.

## Owners

**Suggested assignee:** `codex@openai.com` _(via last-committer)_

## Finding

buildSessionDetails returns `cdpInternalUrl`, but this is currently intended
full-access CDP behavior despite the field name.

## Recommendation

No code change required for this finding under current product semantics. Keep
the DeepSec project context updated if full-access CDP policy changes.

## Recent committers (`git log`)

- Codex <codex@openai.com> (2026-05-04)
- Abdul Rashid <ar1242112@gmail.com> (2026-04-16)
