# [MEDIUM] Public credential validation endpoint lacks service authentication

**File:** [`services/analytics-service/index.ts`](https://github.com/reclaimprotocol/popcorn/blob/main/services/analytics-service/index.ts#L75-L90) (lines 75, 77, 83, 87, 90)
**Project:** popcorn
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `missing-auth`

## Owners

**Suggested assignee:** `codex@openai.com` _(via last-committer)_

## Finding

The `/validate` route has no route-level authentication or rate limiting, unlike the session mutation endpoints using `SERVICE_AUTH_TOKEN` and the admin endpoints using `ADMIN_TOKEN`. It accepts user-controlled `clientId` and `clientSecret` from JSON and calls `ClientService.validateCredentials`; that imported service performs a database lookup and a bcrypt comparison for active clients. The deployment templates expose the analytics service through a GCE ingress when analytics is enabled and several cluster configs set public analytics domains, so an internet caller can use this route directly as a credential-validity oracle and, with a known client ID, repeatedly trigger expensive bcrypt checks outside the intended pool-manager path.

## Recommendation

Require a pool-manager service credential, mTLS, or equivalent service-to-service authentication on `/validate`, and keep the analytics service internal-only where possible. Add per-client/IP rate limiting and generic responses for failed validations.

## Recent committers (`git log`)

- Codex <codex@openai.com> (2026-05-04)
- Abdul Rashid <ar1242112@gmail.com> (2026-04-03)
