# [HIGH] Privileged deploy workflow runs a caller-selected branch with cloud and signing secrets

**File:** [`.github/workflows/cluster-deploy.yaml`](https://github.com/reclaimprotocol/popcorn/blob/main/.github/workflows/cluster-deploy.yaml#L4-L256) (lines 4, 6, 22, 23, 24, 41, 43, 45, 48, 49, 65, 116, 119, 133, 135, 138, 151, 154, 221, 230, 256)
**Project:** popcorn
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `other-ci-credential-exposure`

## Owners

**Suggested assignee:** `codex@openai.com` _(via last-committer)_

## Finding

The manual dispatch input lets the caller choose an arbitrary branch, then the workflow checks out that ref with GH_PAT, obtains GCP OIDC credentials, and later runs scripts from the selected checkout. It also calls the image-build reusable workflow with `secrets: inherit`, so a malicious or compromised branch selected for deployment can execute repository-controlled scripts/Dockerfiles with registry write access, repository write access, and inherited signing secrets. The branch input is also interpolated directly into a shell assignment after cloud auth, so a valid ref name containing shell command substitution can execute in the runner context.

## Recommendation

Restrict deployments to protected refs or explicit environment-approved choices, validate the branch against an allowlist before checkout, avoid running helper scripts from the deploy target ref, pass only required secrets instead of `secrets: inherit`, and move untrusted workflow inputs into environment variables rather than interpolating them directly in shell.

## Recent committers (`git log`)

- Codex <codex@openai.com> (2026-04-30)
