# [BUG] DATABASE_URL fallback is unreachable without individual Postgres variables

**File:** [`services/analytics-service/src/database-config.ts`](https://github.com/reclaimprotocol/popcorn/blob/main/services/analytics-service/src/database-config.ts#L1-L20) (lines 1, 3, 4, 20)
**Project:** popcorn
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-config-logic-bug`

## Owners

**Suggested assignee:** `codex@openai.com` _(via last-committer)_

## Finding

The module requires POSTGRES_HOST, POSTGRES_USER, and POSTGRES_PASSWORD before checking process.env.DATABASE_URL. As a result, a deployment configured with only DATABASE_URL, which the config appears to support, fails during module initialization before the fallback can be used. This affects both app startup and migrations because both import this config.

## Recommendation

Check DATABASE_URL first and only require POSTGRES_HOST, POSTGRES_USER, and POSTGRES_PASSWORD when constructing the connection string from individual fields.

## Recent committers (`git log`)

- Codex <codex@openai.com> (2026-05-04)
- Abdul Rashid <ar1242112@gmail.com> (2026-04-13)
