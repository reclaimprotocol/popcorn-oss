# [MEDIUM] OIDC-enabled testbox workflow uses mutable external action tags

**File:** [`.github/workflows/image-build-testbox.yml`](https://github.com/reclaimprotocol/popcorn/blob/main/.github/workflows/image-build-testbox.yml#L18-L65) (lines 18, 20, 29, 34, 37, 40, 42, 43, 46, 54, 57, 65)
**Project:** popcorn
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-supply-chain`

## Owners

**Suggested assignee:** `ar1242112@gmail.com` _(via last-committer)_

## Finding

This workflow grants `id-token: write`, checks out with GH_PAT when available, authenticates to GCP, and then invokes several actions by mutable major/version tags, including Blacksmith, Google auth/setup, checkout, and cosign installer actions. A compromised or retagged action could run code in a job that has access to the issued cloud credentials and repository token context.

## Recommendation

Pin all external actions to full commit SHAs and keep the OIDC/GH_PAT-authenticated portion of the job as small as possible.

## Recent committers (`git log`)

- Abdul Rashid <ar1242112@gmail.com> (2026-04-20)
