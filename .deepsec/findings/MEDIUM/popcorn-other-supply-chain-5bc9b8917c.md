# [MEDIUM] Secret sync job exposes decryption and GCP credentials to mutable external code

**File:** [`.github/workflows/secret-sync.yaml`](https://github.com/reclaimprotocol/popcorn/blob/main/.github/workflows/secret-sync.yaml#L13-L65) (lines 13, 20, 23, 28, 30, 31, 34, 42, 43, 65)
**Project:** popcorn
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-supply-chain`

## Owners

**Suggested assignee:** `codex@openai.com` _(via last-committer)_

## Finding

The job sets `SOPS_AGE_KEY` at job scope, authenticates to GCP Secret Manager via OIDC, uses mutable action tags, and downloads the SOPS binary with `curl` without checksum or signature verification. If an action tag or downloaded release asset is compromised, attacker-controlled code could decrypt repository secrets or write malicious Secret Manager versions.

## Recommendation

Pin actions by full commit SHA, verify the downloaded SOPS binary with a published checksum/signature, and scope `SOPS_AGE_KEY` only to the exact steps that decrypt secrets.

## Recent committers (`git log`)

- Codex <codex@openai.com> (2026-04-30)
- Abdul Rashid Reshamwala <abdulrreshamwala@reclaimprotocol.org> (2026-04-20)
