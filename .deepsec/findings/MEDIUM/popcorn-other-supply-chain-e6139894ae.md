# [MEDIUM] Privileged workflow uses mutable action tags

**File:** [`.github/workflows/cluster-deploy.yaml`](https://github.com/reclaimprotocol/popcorn/blob/main/.github/workflows/cluster-deploy.yaml#L39-L144) (lines 39, 46, 52, 60, 131, 138, 144)
**Project:** popcorn
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-supply-chain`

## Owners

**Suggested assignee:** `codex@openai.com` _(via last-committer)_

## Finding

The workflow runs with `contents: write`, OIDC cloud authentication, GH_PAT, and registry access, but its actions are referenced by mutable tags such as `actions/checkout@v4`, `google-github-actions/auth@v2`, and `sigstore/cosign-installer@v3.5.0`. If any referenced action tag is moved or the upstream action is compromised, attacker-controlled action code would execute with these credentials.

## Recommendation

Pin third-party actions to reviewed full-length commit SHAs and use dependency automation to update those SHAs deliberately.

## Recent committers (`git log`)

- Codex <codex@openai.com> (2026-04-30)
