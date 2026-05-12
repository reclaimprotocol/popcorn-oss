# [HIGH] Image build workflow executes untrusted refs with registry, repository, and cosign credentials

**File:** [`.github/workflows/image-build.yaml`](https://github.com/reclaimprotocol/popcorn/blob/main/.github/workflows/image-build.yaml#L4-L414) (lines 4, 8, 9, 14, 16, 20, 22, 37, 38, 39, 56, 58, 63, 95, 97, 99, 102, 103, 130, 168, 182, 286, 294, 333, 334, 335, 349, 364, 369, 382, 414)
**Project:** popcorn
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `other-ci-credential-exposure`

## Owners

**Suggested assignee:** `ar1242112@gmail.com` _(via last-committer)_

## Finding

The workflow runs on broad feature branch patterns and also accepts a manual/called `target_ref`. It checks out that ref, authenticates to GCP, runs repository scripts from the checkout, builds Docker contexts from the checkout, and signs browser images with `COSIGN_PRIVATE_KEY`. An actor able to push a matching branch or dispatch/call the workflow for an attacker-controlled ref can modify build scripts or Dockerfiles to exfiltrate credentials, publish malicious images, or abuse the cosign signing key. The `target_ref` expression is also interpolated directly into shell, which makes valid shell-metacharacter ref names an additional command-execution path.

## Recommendation

Limit privileged image builds to protected branches/tags or environment-approved refs, validate manual/called refs against an allowlist before checkout, run trusted CI scripts from a protected ref, use least-privilege job permissions, and expose cosign credentials only in a tightly scoped job after provenance checks pass.

## Recent committers (`git log`)

- Abdul Rashid <ar1242112@gmail.com> (2026-05-06)
- Codex <codex@openai.com> (2026-04-30)
