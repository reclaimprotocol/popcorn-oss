# [MEDIUM] Verifier does not enforce expected GCP project or workload identity

**File:** [`scripts/attestation/verify_gcp_proof.js`](https://github.com/reclaimprotocol/popcorn/blob/main/scripts/attestation/verify_gcp_proof.js#L167-L189) (lines 167, 181, 183, 187, 188, 189)
**Project:** popcorn
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-attestation-binding`

## Owners

**Suggested assignee:** `codex@openai.com` _(via last-committer)_

## Finding

The verifier validates the Google Confidential Computing JWT signature, audience, nonce, image digests, hardware model, and secure boot, but it only prints the GCE project, zone, and instance claims. It does not compare them to an expected Popcorn project, cluster, node pool, service account, or session binding. If a proof from the same signed images running in another GCP project is supplied via --proof-file or --proof-url, the script can accept it as valid even though it does not prove the workload came from the intended Popcorn fleet.

## Recommendation

Require explicit expected GCP project and workload identity constraints, and fail if claims.submods.gce does not match them. Prefer fetching proofs through the session gateway and bind pod/session metadata into the attested nonce payload.

## Recent committers (`git log`)

- Codex <codex@openai.com> (2026-04-30)
- Abdul Rashid <ar1242112@gmail.com> (2026-04-10)
