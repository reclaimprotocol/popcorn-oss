# [HIGH] Reproducibility verifier checks out and runs a user-supplied ref after cloud authentication

**File:** [`.github/workflows/verify-reproducible-images.yaml`](https://github.com/reclaimprotocol/popcorn/blob/main/.github/workflows/verify-reproducible-images.yaml#L4-L66) (lines 4, 6, 21, 23, 37, 40, 42, 45, 46, 57, 63, 65, 66)
**Project:** popcorn
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `other-ci-credential-exposure`

## Owners

**Suggested assignee:** `ar1242112@gmail.com` _(via last-committer)_

## Finding

The manual `commit_sha` input is treated as an arbitrary checkout ref, but the workflow authenticates to GCP and then executes `./scripts/ci/check-reproducible-images.sh` from that checked-out ref with `GH_TOKEN` set to GH_PAT when available. A dispatcher can point the workflow at a malicious branch/tag rather than a trusted immutable commit and run attacker-controlled code with registry and GitHub credentials. The same input is interpolated directly into the shell command, so a valid ref name containing command substitution can also execute code in the authenticated step.

## Recommendation

Require and validate a full 40-character commit SHA before checkout, reject branch/tag names, ensure the commit is reachable from an approved protected ref, run verifier scripts from a trusted checkout, and pass inputs through environment variables instead of direct shell interpolation.

## Recent committers (`git log`)

- Abdul Rashid <ar1242112@gmail.com> (2026-05-04)
- Codex <codex@openai.com> (2026-04-30)
