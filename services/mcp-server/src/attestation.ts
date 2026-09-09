/** The verifier generates this challenge locally and retains it for comparison. */
export const NONCE_PATTERN = '^[0-9a-f]{64}$';
export function validAttestationNonce(nonce: unknown): nonce is string {
  return typeof nonce === 'string' && /^[0-9a-f]{64}$/.test(nonce);
}

export function verificationInstructions(sessionId: string, nonce: string, gatewayOrigin: string) {
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
