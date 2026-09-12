import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const RUN_PROOF_VERSION = 'cs-v1';
const DOMAIN = 'popcorn/confidential-space/run-key/v1\0';
const HARDWARE = ['GCP_AMD_SEV', 'GCP_AMD_SEV_ES', 'GCP_INTEL_TDX'];
const SIGNATURE_ALGORITHMS = ['RSASSA_PSS_SHA256', 'RSASSA_PKCS1V15_SHA256', 'ECDSA_P256_SHA256'];
const audienceValid = value => typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value) &&
  !['https://sts.google.com', 'https://sts.googleapis.com'].includes(value);
const stringMap = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.values(value).every(item => typeof item === 'string');

function decodeCanonicalBase64url(value, bytes, label) {
  assert(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), `invalid ${label} encoding`);
  const decoded = Buffer.from(value, 'base64url');
  assert(decoded.length === bytes && decoded.toString('base64url') === value, `noncanonical ${label}`);
  return decoded;
}

export function canonicalRunBinding(challenge, runPublicKey, audience) {
  assert(typeof challenge === 'string' && /^[0-9a-f]{64}$/.test(challenge), 'invalid canonical challenge');
  assert(audienceValid(audience), 'invalid canonical audience');
  const fields = [Buffer.from(challenge, 'hex'), decodeCanonicalBase64url(runPublicKey, 32, 'run public key'), Buffer.from(audience, 'ascii')];
  return Buffer.concat([Buffer.from(DOMAIN, 'ascii'), ...fields.flatMap(field => {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(field.length);
    return [size, field];
  })]);
}

export function runBindingHash(challenge, runPublicKey, audience) {
  return createHash('sha256').update(canonicalRunBinding(challenge, runPublicKey, audience)).digest('hex');
}

export function validateConfidentialSpacePolicy(policy) {
  assert(policy?.proof_version === RUN_PROOF_VERSION, 'trusted policy must require cs-v1');
  const policyFields = ['proof_version', 'audience', 'hardware_models', 'workload_image_digests', 'image_signing_key_ids',
    'container_args', 'container_env', 'max_age_seconds', 'clock_skew_seconds'];
  assert(Object.keys(policy).every(key => policyFields.includes(key)), 'unsupported Confidential Space policy field');
  assert(audienceValid(policy.audience), 'trusted policy requires a custom audience');
  assert(Array.isArray(policy.hardware_models) && policy.hardware_models.length > 0 &&
    policy.hardware_models.every(model => HARDWARE.includes(model)), 'trusted policy requires approved confidential hardware models');
  const digestMode = policy.workload_image_digests !== undefined;
  const signerMode = policy.image_signing_key_ids !== undefined;
  assert(digestMode !== signerMode, 'choose exactly one image trust mode: measured digests or signing key IDs');
  const values = digestMode ? policy.workload_image_digests : policy.image_signing_key_ids;
  const pattern = digestMode ? /^sha256:[0-9a-f]{64}$/ : /^[0-9a-f]{64}$/;
  assert(Array.isArray(values) && values.length > 0 && values.every(value => typeof value === 'string' && pattern.test(value)), 'invalid image trust allowlist');
  assert(Array.isArray(policy.container_args) && policy.container_args.length > 0 &&
    policy.container_args.every(value => typeof value === 'string'), 'trusted policy requires exact container_args');
  assert(stringMap(policy.container_env), 'trusted policy requires exact container_env');
  assert(policy.container_env.POPCORN_CONFIDENTIAL_SPACE === 'true' &&
    policy.container_env.ATTESTATION_TOKEN_AUDIENCE === policy.audience, 'container environment must enable CS and select the trusted audience');
  assert(Number.isSafeInteger(policy.max_age_seconds) && policy.max_age_seconds > 0, 'trusted policy requires positive max_age_seconds');
  assert(Number.isSafeInteger(policy.clock_skew_seconds) && policy.clock_skew_seconds >= 0, 'trusted policy requires nonnegative clock_skew_seconds');
}

// claims MUST already have passed Google JWT verification. The public entry
// point is verifyProof in verify.mjs, which also enforces the trusted policy.
export function verifyConfidentialSpaceClaims(proof, challenge, policy, claims, now) {
  assert(proof && !proof.error && proof.proof_version === RUN_PROOF_VERSION, 'Confidential Space proof version mismatch');
  assert(isDeepStrictEqual(Object.keys(proof).sort(), ['attestation', 'audience', 'nonce', 'proof_version', 'run_public_key', 'run_signature']), 'unsupported proof fields; supplied run keys are not accepted');
  assert(proof.attestation && isDeepStrictEqual(Object.keys(proof.attestation), ['token']), 'unsupported attestation fields');
  assert(proof.nonce === challenge, 'proof challenge mismatch');
  assert(proof.audience === policy.audience, 'proof audience mismatch');
  assert(claims.swname === 'CONFIDENTIAL_SPACE', 'wrong workload type: expected CONFIDENTIAL_SPACE');
  assert(claims.dbgstat === 'disabled-since-boot', 'debug Confidential Space is forbidden');
  assert(claims.secboot === true, 'secure boot required');
  assert(policy.hardware_models.includes(claims.hwmodel), 'unapproved hardware model');
  assert(Number.isSafeInteger(claims.nbf) && claims.nbf <= now + policy.clock_skew_seconds && claims.exp > claims.nbf, 'missing or invalid not-before');
  const canonical = canonicalRunBinding(challenge, proof.run_public_key, policy.audience);
  const expectedHash = createHash('sha256').update(canonical).digest('hex');
  const nonces = typeof claims.eat_nonce === 'string' ? [claims.eat_nonce] : claims.eat_nonce;
  assert(Array.isArray(nonces) && nonces.length === 1 && nonces[0] === expectedHash, 'signed run-key binding mismatch');

  const container = claims.submods?.container;
  assert(container && /^sha256:[0-9a-f]{64}$/.test(container.image_digest), 'missing measured container image digest');
  if (policy.workload_image_digests) {
    assert(policy.workload_image_digests.includes(container.image_digest), 'unapproved measured image digest');
  } else {
    // These are Google's authenticated image-signature assertions, not an
    // unsigned signer ID supplied alongside the proof. Google validates the
    // image signature; the relying party pins the public-key fingerprint.
    assert(Array.isArray(container.image_signatures) && container.image_signatures.some(signature =>
      policy.image_signing_key_ids.includes(signature?.key_id) &&
      SIGNATURE_ALGORITHMS.includes(signature.signature_algorithm) &&
      typeof signature.signature === 'string' && signature.signature.length > 0), 'untrusted image signer');
  }
  assert(isDeepStrictEqual(container.args, policy.container_args), 'unapproved container arguments');
  assert(isDeepStrictEqual(container.env, policy.container_env), 'unapproved container environment');
  if (container.cmd_override !== undefined) assert(isDeepStrictEqual(container.cmd_override, []), 'container command overrides are forbidden');
  if (container.env_override !== undefined) {
    assert(stringMap(container.env_override) && Object.entries(container.env_override).every(([key, value]) =>
      Object.hasOwn(policy.container_env, key) && policy.container_env[key] === value), 'unapproved environment override');
  }
  const signature = decodeCanonicalBase64url(proof.run_signature, 64, 'run signature');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: proof.run_public_key }, format: 'jwk' });
  assert(verify(null, canonical, key, signature), 'invalid run-key possession signature');
  return {
    confidential_space_run_key_verified: true,
    run_public_key: proof.run_public_key,
    audience: policy.audience,
    workload_image_digest: container.image_digest,
    scope: 'Google-attested Confidential Space workload identity and the challenge-bound run key satisfy the supplied policy. Key custody relies on the approved workload code and Confidential Space isolation; application data and transport are not attested by this proof.',
  };
}
