# [MEDIUM] Verifier workflow uses mutable action tags with OIDC enabled

**File:** [`.github/workflows/verify-reproducible-images.yaml`](https://github.com/reclaimprotocol/popcorn/blob/main/.github/workflows/verify-reproducible-images.yaml#L23-L82) (lines 23, 35, 43, 49, 57, 82)
**Project:** popcorn
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-supply-chain`

## Owners

**Suggested assignee:** `ar1242112@gmail.com` _(via last-committer)_

## Finding

The workflow grants OIDC, authenticates to GCP, and invokes checkout, Google, Blacksmith, and artifact actions by mutable tags. A compromised or retagged action could execute with access to the workflow's cloud and repository credential context.

## Recommendation

Pin external actions to full commit SHAs and periodically update them through reviewed pull requests.

## Recent committers (`git log`)

- Abdul Rashid <ar1242112@gmail.com> (2026-05-04)
- Codex <codex@openai.com> (2026-04-30)
