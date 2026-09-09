# Independent v3 proof verification

Run this verifier on the agent's own trusted machine using Node.js 20 or later.
Obtain the verifier code and deployment policy through a separately trusted
channel and pin the version you reviewed. Use that approved policy for the
expected identities and image digests.

1. Generate a fresh challenge locally, for example:

   ```sh
   node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
   ```

2. Retain that value and the request time locally, associated with the intended
   session. Call `verify_runtime` with `{"session_id":"...","nonce":"<64 lowercase hex characters>"}`.
   Use the locally retained nonce as the expected challenge. Generate a new
   challenge for each verification and accept responses to the current request.
3. Save the returned `attestation` object as `proof.json`. `evidence_available`
   confirms retrieval; complete independent verification with the local command
   below.
4. Obtain an approved policy separately. This example is deliberately incomplete;
   replace its placeholders with deployment-approved identities and digests:

   ```json
   {
     "audience": "https://<approved-regional-gateway>",
     "project_id": "<approved-GCP-project>",
     "zone": "<approved-GCP-zone>",
     "instance_name": "<approved-GCP-instance>",
     "workload_image_digests": ["<approved-registry/image>@sha256:<64 hex characters>"],
     "verifier_image_digests": ["<approved-registry/attestor>@sha256:<64 hex characters>"],
     "max_age_seconds": 300,
     "clock_skew_seconds": 30
   }
   ```

   Image allowlists are exact digest-pinned references, established through a
   trusted release/signature review process. The response's `audience_hint`
   comes from control-plane routing; compare it with your approved gateway. Pin the instance name using
   independently authenticated deployment inventory. Missing required policy
   fields fail. An optional `service_account` field enforces a matching signed
   account claim when configured.

5. Run:

   ```sh
   node scripts/attestation/verify.mjs --proof proof.json --nonce <locally-retained-nonce> --policy trusted-policy.json
   ```

The verifier fetches Google's OIDC discovery and JWKS over HTTPS from fixed
trusted URLs, rejects redirects and unexpected discovery destinations, and
checks RS256 signatures, issuer, audience, expiration, issuance age, optional
not-before, challenge, image binding, hardware model, secure boot, project,
zone, exact instance name, optional service account, and approved image digests.
Verification failures exit nonzero. Signed token time claims and the locally
retained challenge provide the freshness checks.

Google reference: [Confidential VM token claims](https://docs.cloud.google.com/confidential-computing/confidential-vm/docs/token-claims).
[OIDC discovery](https://confidentialcomputing.googleapis.com/.well-known/openid-configuration)
provides the Google signing-key URL. Key IDs rotate; the verifier retrieves
current keys using the published key IDs.

## What success establishes

A successful result says `platform_and_image_assertion_verified: true`: Google's
signed platform claims and the nonce-bound, orchestrator-reported image
identities satisfy your supplied policy. The image-binding hash is SHA-256 of
these UTF-8 lines, joined with LF and **no trailing newline**:

```text
v3
workload.container_name=<proof.workload.container_name>
workload.image_digest=<proof.workload.image_digest>
verifier.container_name=<proof.verifier.container_name>
verifier.image_digest=<proof.verifier.image_digest>
```

The JWT's `eat_nonce` must contain both your original challenge and that hash.
The verifier recomputes the hash from the reported image identities.

Successful verification establishes:

- The token signature validates against Google's signing keys and expected issuer.
- The signed challenge matches the caller's locally retained nonce and meets the
  configured freshness policy.
- Signed audience, project, zone, exact instance name, hardware model, and secure
  boot claims match the approved policy.
- The signed hash binds the orchestrator-reported workload and attestor image
  identities, and both image digests appear in the approved allowlists.
- Any configured service-account constraint matches a signed claim.

Tests: `node --test scripts/attestation/verify.test.mjs`.
