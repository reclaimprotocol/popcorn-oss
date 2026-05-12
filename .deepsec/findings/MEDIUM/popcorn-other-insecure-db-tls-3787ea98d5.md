# [MEDIUM] Database TLS mode does not verify the server certificate

**File:** [`services/analytics-service/src/database-config.ts`](https://github.com/reclaimprotocol/popcorn/blob/main/services/analytics-service/src/database-config.ts#L6-L24) (lines 6, 24)
**Project:** popcorn
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-insecure-db-tls`

## Owners

**Suggested assignee:** `codex@openai.com` _(via last-committer)_

## Finding

DATABASE_SSL is collapsed to either false or the postgres.js string mode 'require'. In postgres.js, 'require' disables certificate verification, so enabling DATABASE_SSL encrypts the connection but still permits an in-network attacker to impersonate the PostgreSQL server and capture credentials or analytics data. There is no supported path here for verify-full or a CA-backed TLS options object.

## Recommendation

Support a verified TLS mode for production, for example DATABASE_SSL=verify-full plus CA configuration, and pass postgres.js TLS options with rejectUnauthorized enabled. Avoid mapping boolean true to 'require' when the expectation is authenticated TLS.

## Recent committers (`git log`)

- Codex <codex@openai.com> (2026-05-04)
- Abdul Rashid <ar1242112@gmail.com> (2026-04-13)
