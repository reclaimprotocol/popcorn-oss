# Confidential Space browser run-key binding

This is an opt-in **code and unit-test implementation**, not a deployed service.
No GCP resources are created by these changes. No real Confidential Space token
has been obtained or validated as part of this milestone. Unit fixtures marked
**MOCK** or **TEST-JWKS** are not Google evidence.

## Architecture and trust boundary

The browser's `novnc-proxy` process generates a separate Ed25519 signing key with
`crypto/rand` at startup when Confidential Space mode is enabled. The private
key remains in process memory: no import API, request parameter, environment
variable, persistence, export, or generic signing endpoint exists. This key is
separate from the existing X25519 Noise transport key. One **run** means one
proxy process lifetime; a process restart makes a new key. A Chromium restart,
page navigation, or repeated proof request does not rotate it.

The browser workload itself calls the Confidential Space launcher. The old
GKE attestor sidecar is not involved. This follows Google's documented
[custom-token workload/launcher flow](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/connect-external-resources):

1. The relying party generates and retains a random 32-byte challenge.
2. The workload combines that challenge with its own run public key and its
   configured audience, then hashes the canonical bytes defined below.
3. It sends `POST http://localhost/v1/token` through the fixed Unix socket
   `/run/container_launcher/teeserver.sock`. The JSON body contains
   `audience`, `token_type: "OIDC"`, and `nonces: ["<tuple SHA-256 hex>"]`.
4. The launcher collects evidence and obtains a Google token. The workload
   returns that opaque token and an Ed25519 signature over the canonical tuple.
5. The relying party's verifier checks the Google signature, Confidential Space
   and workload claims, the hash, and the run-key possession signature.

Unlike the legacy VM token, Confidential Space supplies an authenticated
workload-container identity. This identity anchors the review of the code that
generates the run key and chooses the nonce. Nonces remain workload-supplied
claims; Google does not inspect an Ed25519 allocation or certify the key as
TPM-generated/nonexportable. Key origin and custody rely on the approved
workload code, approved launch configuration, and Confidential Space isolation.

Google's [current claim reference](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/token-claims)
documents `swname`, `dbgstat`, `secboot`, hardware, time claims, and
`submods.container`. The [signed-image codelab](https://codelabs.developers.google.com/signed-container-image-codelab)
explains the split between Google's image-signature validation and the relying
party's trusted public-key policy. No undocumented GCP claim is introduced.

## Canonical tuple and proof format

Serialization is binary, not JSON. All fields are required and encoded in this
fixed order:

| Bytes | Meaning |
| --- | --- |
| ASCII `popcorn/confidential-space/run-key/v1` followed by one NUL byte | Domain and encoding version |
| `u32be(32)` followed by 32 bytes | Challenge decoded from exactly 64 lowercase hexadecimal characters |
| `u32be(32)` followed by 32 bytes | Raw Ed25519 public key decoded from canonical, unpadded base64url |
| `u32be(N)` followed by N bytes | Configured custom audience, 1–512 printable ASCII bytes excluding spaces |

There is no trailing delimiter or newline. `u32be` is an unsigned four-byte
big-endian integer. Uppercase challenge hex, padded/aliased base64url, Unicode
audiences, whitespace, and default STS audiences are rejected. SHA-256 produces
64 lowercase hex characters; this string is the sole launcher nonce. The
Ed25519 possession signature covers the canonical bytes themselves.

A shared public encoding vector lives at
`images/minimal-vnc-desktop/proxy/testdata/run-binding.json`; both Go and
JavaScript tests assert its exact bytes and hash. It contains no private key.

`GET :8085/proof?nonce=<64 lowercase hex characters>` returns:

```json
{
  "proof_version": "cs-v1",
  "nonce": "<original challenge>",
  "audience": "<workload-configured relying-party audience>",
  "run_public_key": "<32 bytes, unpadded base64url>",
  "run_signature": "<64 bytes, unpadded base64url>",
  "attestation": { "token": "<Google OIDC JWT>" }
}
```

This is a schema illustration, not evidence. An optional `audience` query
parameter can confirm the configured value; it cannot select another audience.
Unknown/duplicate query parameters, supplied key fields, and request bodies are
rejected before launcher IPC. Missing launcher, redirects, non-200 responses,
and empty/oversized responses fail closed with a clean HTTP error. Successful
retrieval does not claim verification. Responses use `Cache-Control: no-store`.

## Independent verification

Use Node.js 20 or later and a separately reviewed copy of the verifier. The CLI
accepts only `--proof`, `--nonce`, and an explicit trusted `--policy`; there is
no launcher/JWKS override or mock CLI mode.

```sh
node scripts/attestation/verify.mjs \
  --proof proof.json \
  --nonce '<locally retained 64-character challenge>' \
  --policy trusted-cs-policy.json
```

The policy must explicitly require `proof_version: "cs-v1"`. A minimal
**incomplete policy template** is:

```json
{
  "proof_version": "cs-v1",
  "audience": "https://verifier.example",
  "hardware_models": ["GCP_AMD_SEV"],
  "workload_image_digests": ["sha256:<approved 64 lowercase hex digest>"],
  "container_args": ["/usr/local/bin/minimal-vnc-entrypoint"],
  "container_env": {
    "POPCORN_CONFIDENTIAL_SPACE": "true",
    "ATTESTATION_TOKEN_AUDIENCE": "https://verifier.example",
    "ENABLE_AGONES": "false"
  },
  "max_age_seconds": 300,
  "clock_skew_seconds": 0
}
```

Replace the image placeholder and approve **all** actual measured container
arguments and environment values through trusted build/deployment inventory.
The template's environment is not a claim about a live token: the existing
image includes additional defaults that may appear in the token. The verifier
requires exact `container.args` and `container.env` equality. Explicit
`env_override` values, when present, must also match that approved environment;
nonempty `cmd_override` is rejected. This prevents an approved image from
silently authorizing an unapproved command or key-injection environment.

Alternatively, replace `workload_image_digests` with
`image_signing_key_ids: ["<trusted public-key SHA-256 fingerprint>"]`.
The modes are mutually exclusive: a digest failure never falls back to a
signer. The fingerprint is the lowercase SHA-256 of the public key's DER SPKI,
as documented by Google. Signer mode trusts images authorized by that signer;
it does not pin a particular release. The matching signature assertion must
carry a documented signature algorithm. No unsigned proof field can introduce
a trusted image or signer. Unknown policy fields are rejected instead of
silently ignoring a security constraint.

Verification performs these checks in order:

- Verify RS256 against independently fetched Google discovery/JWKS at fixed
  HTTPS URLs; check `iss`, `aud`, `iat`, `exp`, and `nbf`.
- Require `swname=CONFIDENTIAL_SPACE`, `dbgstat=disabled-since-boot`,
  `secboot=true`, and a configured confidential hardware model. Shielded VM
  alone is not accepted. Supported allowlist choices are AMD SEV, AMD SEV ES,
  and Intel TDX as represented by Google's documented claim values.
- Compare the retained challenge and configured audience; recompute the tuple
  hash and require it as the only `eat_nonce` value (string or singleton array).
- Enforce the measured image digest or trusted image-signature assertion,
  exact launch configuration, and the Ed25519 possession signature.

Success returns `confidential_space_run_key_verified: true`, the bound public
key, audience, measured digest, and the verification scope. Failure exits
nonzero and prints its reason. The caller must associate each challenge with
the intended request, accept it once, and discard it afterward. This stateless
verifier does not maintain a replay database; reusing the same expected challenge
can accept the same still-valid proof again.

| Value | Enforcement |
| --- | --- |
| Challenge | Included in the canonical tuple hash in signed `eat_nonce`; compared with the independently retained challenge |
| Run public key | Included in the same hash; Ed25519 signature demonstrates possession; approved measured code generates and retains it |
| Image digest | Direct signed `submods.container.image_digest` allowlist, or Google's validated `submods.container.image_signatures` matched to a trusted key ID |
| Audience | Direct signed `aud` equality plus inclusion in the tuple hash; workload configuration selects it |

## Compatibility and future deployment notes

The existing `services/attestor` v3 GKE implementation and its chart settings
remain unchanged. Existing clients and v3 policies keep their prior behavior.
They cannot verify `cs-v1`. A Confidential Space policy cannot accept v3.
`verify_runtime` accepts either evidence format and returns the corresponding
independent verification instructions with `status: not_performed`; retrieval
alone never sets a verified flag. Its session/challenge input contract is
unchanged. No session routing or allocation migration is implemented here.

The browser image build already compiles `proxy/*.go`, so the new code is
included without a dependency or Docker build change. On a **future** production
Confidential Space deployment, enable the mode with:

```text
POPCORN_CONFIDENTIAL_SPACE=true
ATTESTATION_TOKEN_AUDIENCE=<approved custom audience>
ENABLE_AGONES=false
```

The signing key and launcher endpoint have no environment configuration.
Ordinary browser deployments leave the mode disabled. Enabling a flag on Kind
or ordinary GKE does not produce Confidential Space evidence: token requests
fail when the fixed launcher socket is unavailable. Do not run the legacy
attestor beside this endpoint; both use port 8085. The browser-fleet chart is
not a Confidential Space deployment mechanism and was not changed.

Before any separately authorized deployment: build/review the resulting amd64
browser image, approve its digest or signing key and launch configuration,
select a production Confidential Space image with secure boot and approved
hardware, and validate launcher socket access for the image's existing `kernel`
user, Chromium sandbox/startup, memory/filesystem requirements, and routing to
port 8085. Publishing images, creating a VM/service account/IAM policy, wiring
allocation or gateway routing, and obtaining a live token remain deployment
work. No resource-creation command or provisioning workflow is included here.

The approved code, Google attestation service and key distribution, production
Confidential Space launcher, platform isolation, verifier clock, and trusted
policy are trust assumptions. This milestone does **not** attest a browser
response, extracted fact, model, application output, Noise key, authenticated
user/session ID, or TLS channel. A relayed proof is not by itself a secure data
channel. It also does not prove absence of runtime vulnerabilities or physical
key erasure. No stronger hardware-root claim is made for SEV than Google
documents; the verifier pins the accepted hardware model.

## Unit tests

Requires Go 1.26 for the existing browser proxy module, Bun, and Node.js 20+.
From the repository root:

```sh
bash scripts/attestation/test.sh
```

The script runs the browser proxy and legacy attestor Go suites, installs MCP
dependencies from the frozen lockfile and runs its tests, then runs both
independent verifier suites. The normal OSS CI workflow also runs these suites.

All launcher fixtures use a temporary Unix socket **only inside Go unit tests**.
All new verifier tokens use ephemeral **TEST-JWKS** signing keys generated in
the test process. MCP retrieval uses explicitly labeled test responses. No
fixture key is committed and no fixture is accepted by the production CLI.
The signer-policy test uses a synthetic signature *claim*; it tests policy
enforcement, not Google's actual image-signature validation.

Negative cases cover supplied/substituted keys, malformed or mismatched
challenges/audiences, altered Google or run signatures, wrong issuer or key,
expiry/not-before, debug mode, wrong workload type/hardware/secure boot, wrong
digest, untrusted signer, unapproved launch configuration, version downgrade,
malformed serialization, and launcher failures. Existing v3 positive tests
remain intact. These tests establish code behavior, not a successful external
Confidential Space integration.
