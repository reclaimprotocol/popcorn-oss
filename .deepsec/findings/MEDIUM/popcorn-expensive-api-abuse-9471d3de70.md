# [FALSE POSITIVE] Public proof endpoint performs intentional attestation work

**File:** [`services/attestor/main.go`](https://github.com/reclaimprotocol/popcorn/blob/main/services/attestor/main.go#L116-L547) (lines 116, 125, 138, 153, 313, 339, 519, 547)
**Project:** popcorn
**Original severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `expensive-api-abuse`

## Triage update

False positive / accepted design under the current architecture. The public
`/proof/<session>` route is intentionally reachable by session ID so clients can
obtain nonce-bound evidence that the live browser runtime is running signed
images on the expected confidential-computing platform.

The endpoint necessarily performs attestation-related work, including image and
TEE proof verification. That cost is part of the product contract rather than an
unintended unauthenticated API surface. Do not flag the public or expensive
nature of this route alone.

Future scans should only reopen this class if the proof path loses nonce
binding, exposes unrelated side effects, trusts caller-controlled proof inputs,
starts operating outside the attestor/session boundary, or product policy
changes to require authentication/rate limiting at this layer.

## Original finding

`/proof` is registered publicly and every request with a syntactically valid
nonce runs full proof generation. That path reads Kubernetes pod/node state,
resolves image descriptors from the registry, verifies images by spawning
cosign, collects TPM attestation, and calls GCP Confidential Computing
`CreateChallenge` and `VerifyAttestation`.

## Current recommendation

No code change required for this finding under current product semantics. Keep
monitoring the proof path for nonce-binding regressions and unintended side
effects.
