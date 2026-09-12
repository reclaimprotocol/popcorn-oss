/** The verifier generates this challenge locally and retains it for comparison. */
export const NONCE_PATTERN = '^[0-9a-f]{64}$';
export function validAttestationNonce(nonce: unknown): nonce is string {
  return typeof nonce === 'string' && /^[0-9a-f]{64}$/.test(nonce);
}

export function verificationInstructions(sessionId: string, nonce: string, gatewayOrigin: string, proofVersion = 'v3') {
  if (proofVersion === 'cs-v1') return {
    status: 'not_performed', nonce_source: 'caller', requested_session_id: sessionId, expected_nonce: nonce,
    token_path: 'attestation.attestation.token', proof_version: 'cs-v1',
    issuer: 'https://confidentialcomputing.googleapis.com',
    discovery_url: 'https://confidentialcomputing.googleapis.com/.well-known/openid-configuration',
    jwks_url: 'https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@confidentialspace-sign.iam.gserviceaccount.com',
    algorithm: 'RS256', audience_hint: null, audience_hint_source: 'use_independently_trusted_policy',
    required_claims: ['iss', 'aud', 'iat', 'exp', 'nbf', 'eat_nonce', 'hwmodel', 'secboot', 'swname', 'dbgstat', 'submods.container'],
    checks: [
      'Require trusted policy proof_version=cs-v1. Reject legacy v3 evidence for a Confidential Space request.',
      'Fetch Google keys independently and verify RS256, issuer, audience, exp, iat, nbf, maximum age and allowed clock skew.',
      'Require swname=CONFIDENTIAL_SPACE, dbgstat=disabled-since-boot, secboot=true and an explicitly approved confidential hardware model.',
      'Recompute SHA-256 of the canonical challenge, raw Ed25519 run public key and audience tuple; require this single eat_nonce.',
      'Check the measured container image digest or trusted image-signing key ID, and exact approved container arguments and environment.',
      'Verify the Ed25519 run_signature over the canonical tuple. Retain and consume the challenge locally; this verifier does not store replay state.',
    ],
    digest_binding: {
      algorithm: 'SHA-256', output: 'lowercase hex',
      domain: 'popcorn/confidential-space/run-key/v1 followed by NUL',
      encoding: 'Each field is prefixed by its 4-byte unsigned big-endian byte length.',
      fields: ['challenge decoded from 64 lowercase hex characters (32 bytes)',
        'run_public_key decoded from canonical unpadded base64url (32 bytes)', 'configured custom audience (1-512 printable ASCII bytes, no spaces)'],
      claim: 'eat_nonce is the tuple hash, as a string or a single-element array',
    },
    trusted_policy_required: ['proof_version', 'audience', 'hardware_models', 'container_args', 'container_env',
      'exactly one of workload_image_digests or image_signing_key_ids', 'max_age_seconds', 'clock_skew_seconds'],
    policy_source: 'Obtain the approved workload code, image identity, launch configuration and verifier through a separately trusted channel.',
    verification_scope: 'Google-attested Confidential Space workload identity and the bound run key satisfy policy. Key custody relies on the approved code and Confidential Space isolation; this does not attest browser data or bind a transport channel.',
    proves_after_verification: [
      'The Google-signed token satisfies the required Confidential Space, hardware and freshness policy.',
      'The measured workload image identity and launch configuration satisfy independently trusted policy.',
      'The signed nonce binds the original challenge, run public key and audience.',
      'The workload demonstrates possession of the corresponding Ed25519 signing key.',
    ],
    verifier: { repository: 'https://github.com/reclaimprotocol/popcorn-oss', path: 'scripts/attestation/verify.mjs',
      command: 'node scripts/attestation/verify.mjs --proof proof.json --nonce <locally-retained-nonce> --policy trusted-cs-policy.json' },
  };
  return {
    status: 'not_performed',
    nonce_source: 'caller',
    requested_session_id: sessionId,
    expected_nonce: nonce,
    token_path: 'attestation.attestation.token',
    issuer: 'https://confidentialcomputing.googleapis.com',
    discovery_url: 'https://confidentialcomputing.googleapis.com/.well-known/openid-configuration',
    jwks_url: 'https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@confidentialspace-sign.iam.gserviceaccount.com',
    algorithm: 'RS256',
    audience_hint: gatewayOrigin,
    audience_hint_source: 'control_plane_session_url',
    required_claims: ['iss', 'aud', 'iat', 'exp', 'eat_nonce', 'hwmodel', 'secboot', 'submods.gce'],
    checks: [
      'Fetch keys independently from the fixed Google issuer and verify the RS256 signature before trusting claims.',
      'Compare the signed issuer and audience to independently trusted policy; check exp, iat, optional nbf, maximum age and allowed clock skew.',
      'Compare both the proof nonce and signed eat_nonce to the original locally retained challenge; recompute the image-binding hash.',
      'Require approved digest-pinned images and signed project, zone, instance name, hardware and secure-boot claims. Enforce any configured service-account constraint.',
    ],
    expected_hwmodel: 'GCP_AMD_SEV',
    expected_secboot: true,
    digest_binding: {
      algorithm: 'SHA-256', encoding: 'UTF-8', output: 'lowercase hex',
      separator: '\n', trailing_newline: false,
      lines: ['v3', 'workload.container_name=<proof.workload.container_name>',
        'workload.image_digest=<proof.workload.image_digest>',
        'verifier.container_name=<proof.verifier.container_name>',
        'verifier.image_digest=<proof.verifier.image_digest>'],
      claim: 'eat_nonce must contain both the caller nonce and the recomputed digest binding',
    },
    trusted_policy_required: ['audience', 'project_id', 'zone', 'instance_name',
      'workload_image_digests', 'verifier_image_digests', 'max_age_seconds', 'clock_skew_seconds'],
    optional_policy: { service_account: 'If configured, requires a matching signed service-account claim.' },
    policy_source: 'Obtain approved identities, image digests, and verifier code through a separately trusted channel.',
    verification_scope: 'A successful independent check establishes that Google-signed platform claims and nonce-bound, orchestrator-reported image identities satisfy the supplied policy.',
    proves_after_verification: [
      'The token signature validates against Google signing keys and the expected issuer.',
      'The signed challenge matches the original caller nonce and satisfies the configured token freshness policy.',
      'Signed audience, project, zone, instance name, hardware model and secure-boot claims match the approved policy.',
      'The signed image-binding hash matches the reported workload and attestor image identities, and both digests are approved by policy.',
      'Any configured service-account constraint matches a signed claim.',
    ],
    verifier: { repository: 'https://github.com/reclaimprotocol/popcorn-oss', path: 'scripts/attestation/verify.mjs',
      command: 'node scripts/attestation/verify.mjs --proof proof.json --nonce <locally-retained-nonce> --policy trusted-policy.json' },
  };
}
