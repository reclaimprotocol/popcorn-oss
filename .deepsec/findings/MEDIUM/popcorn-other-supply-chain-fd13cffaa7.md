# [MEDIUM] Privileged image build uses mutable action tags

**File:** [`.github/workflows/image-build.yaml`](https://github.com/reclaimprotocol/popcorn/blob/main/.github/workflows/image-build.yaml#L54-L433) (lines 54, 93, 100, 106, 114, 118, 362, 369, 375, 433)
**Project:** popcorn
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-supply-chain`

## Owners

**Suggested assignee:** `ar1242112@gmail.com` _(via last-committer)_

## Finding

The build and manifest jobs use mutable action refs while holding write permissions, OIDC cloud credentials, registry access, and signing secrets. A compromised action tag could execute attacker-controlled code with access to those credentials.

## Recommendation

Pin external actions to full commit SHAs and review updates through normal code review.

## Recent committers (`git log`)

- Abdul Rashid <ar1242112@gmail.com> (2026-05-06)
- Codex <codex@openai.com> (2026-04-30)
