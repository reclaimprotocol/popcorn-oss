// UNIT TEST ONLY: synthetic claims signed by an ephemeral TEST-JWKS key.
// These fixtures are NOT Google evidence and never leave this test process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifyProof, fetchGoogleKeys, ISSUER, DISCOVERY_URL, JWKS_URL } from './verify.mjs';
import { canonicalRunBinding, runBindingHash } from './confidential-space.mjs';

const testGoogle = generateKeyPairSync('rsa', { modulusLength: 2048 });
const run = generateKeyPairSync('ed25519');
const testJWKS = { keys: [{ ...testGoogle.publicKey.export({ format: 'jwk' }), kid: 'TEST_ONLY_CS_RSA', alg: 'RS256' }] };
const now = 2000000000;
const challenge = 'ab'.repeat(32);
const imageDigest = 'sha256:' + '1'.repeat(64);
const signerID = '2'.repeat(64);
const policy = {
  proof_version: 'cs-v1', audience: 'https://verifier.example',
  hardware_models: ['GCP_AMD_SEV'], workload_image_digests: [imageDigest],
  container_args: ['/usr/local/bin/minimal-vnc-entrypoint'],
  container_env: { POPCORN_CONFIDENTIAL_SPACE: 'true', ATTESTATION_TOKEN_AUDIENCE: 'https://verifier.example', ENABLE_AGONES: 'false' },
  max_age_seconds: 300, clock_skew_seconds: 0,
};
const { workload_image_digests, ...withoutDigests } = policy;
const signerPolicy = { ...withoutDigests, image_signing_key_ids: [signerID] };
function fixture({ claims: claimChanges = {}, proof: proofChanges = {}, container: containerChanges = {}, header = {} } = {}) {
  const publicKey = run.publicKey.export({ format: 'jwk' }).x;
  const canonical = canonicalRunBinding(challenge, publicKey, policy.audience);
  const claims = {
    iss: ISSUER, aud: policy.audience, iat: now - 10, nbf: now - 10, exp: now + 300,
    swname: 'CONFIDENTIAL_SPACE', dbgstat: 'disabled-since-boot', secboot: true,
    hwmodel: 'GCP_AMD_SEV', eat_nonce: [runBindingHash(challenge, publicKey, policy.audience)],
    submods: { container: {
      image_digest: imageDigest,
      // TEST ONLY placeholder signature claim: Google image-signature
      // validation is not implemented or simulated by this unit test.
      image_signatures: [{ key_id: signerID, signature: 'TEST_ONLY_SIGNATURE_CLAIM', signature_algorithm: 'ECDSA_P256_SHA256' }],
      args: policy.container_args, env: policy.container_env,
      ...containerChanges,
    } }, ...claimChanges,
  };
  const input = [{ alg: 'RS256', kid: 'TEST_ONLY_CS_RSA', ...header }, claims]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return {
    proof_version: 'cs-v1', nonce: challenge, audience: policy.audience,
    run_public_key: publicKey, run_signature: sign(null, canonical, run.privateKey).toString('base64url'),
    attestation: { token: input + '.' + sign('RSA-SHA256', Buffer.from(input), testGoogle.privateKey).toString('base64url') },
    ...proofChanges,
  };
}
const check = (proof = fixture(), trustedPolicy = policy, nonce = challenge) => verifyProof(proof, nonce, trustedPolicy, testJWKS, now);

test('TEST-JWKS: accepts measured digest and bound ephemeral key', () => {
  const proof = fixture();
  const result = check(proof);
  assert.equal(result.confidential_space_run_key_verified, true);
  assert.equal(result.run_public_key, proof.run_public_key);
  assert.equal(result.workload_image_digest, imageDigest);
});
test('TEST-JWKS: accepts an explicitly trusted image-signing key policy', () => {
  assert.equal(check(fixture(), signerPolicy).confidential_space_run_key_verified, true);
});
test('shared public Go/JavaScript canonical vector matches byte-for-byte', () => {
  const vector = JSON.parse(readFileSync(new URL('../../images/minimal-vnc-desktop/proxy/testdata/run-binding.json', import.meta.url)));
  assert.equal(canonicalRunBinding(vector.challenge, vector.run_public_key, vector.audience).toString('hex'), vector.canonical_hex);
  assert.equal(runBindingHash(vector.challenge, vector.run_public_key, vector.audience), vector.sha256);
});

for (const [name, changes, reason] of [
  ['issuer', { iss: 'https://attacker.example' }, /issuer/],
  ['audience', { aud: 'https://other.example' }, /audience/],
  ['expired', { exp: now }, /expired/],
  ['future issuance', { iat: now + 1 }, /future/],
  ['stale issuance', { iat: now - 301 }, /stale/],
  ['not-before', { nbf: now + 1 }, /not yet valid/],
  ['missing not-before', { nbf: undefined }, /not-before/],
  ['invalid validity window', { nbf: now + 300 }, /not yet valid|not-before/],
  ['debug mode', { dbgstat: 'enabled' }, /debug/],
  ['missing debug status', { dbgstat: undefined }, /debug/],
  ['workload type', { swname: 'GCE' }, /workload type/],
  ['secure boot', { secboot: false }, /secure boot/],
  ['hardware', { hwmodel: 'GCP_SHIELDED_VM' }, /hardware/],
  ['nonce', { eat_nonce: ['3'.repeat(64)] }, /binding/],
  ['extra nonce', { eat_nonce: ['3'.repeat(64), '4'.repeat(64)] }, /binding/],
]) test(`TEST-JWKS: rejects ${name}`, () => assert.throws(() => check(fixture({ claims: changes })), reason));

test('TEST-JWKS: rejects substituted key even with attacker possession signature', () => {
  const attacker = generateKeyPairSync('ed25519');
  const proof = fixture();
  proof.run_public_key = attacker.publicKey.export({ format: 'jwk' }).x;
  proof.run_signature = sign(null, canonicalRunBinding(challenge, proof.run_public_key, proof.audience), attacker.privateKey).toString('base64url');
  assert.throws(() => check(proof), /binding mismatch/);
});
test('TEST-JWKS: rejects supplied private key and unsupported proof fields', () => {
  assert.throws(() => check(fixture({ proof: { run_private_key: 'TEST ONLY supplied key' } })), /unsupported proof fields/);
});
test('TEST-JWKS: rejects mismatched challenge and cross-request reuse', () => {
  assert.throws(() => check(fixture(), policy, 'cd'.repeat(32)), /challenge mismatch/);
  assert.throws(() => check(fixture({ proof: { nonce: 'cd'.repeat(32) } }), policy, 'cd'.repeat(32)), /binding mismatch/);
});
test('TEST-JWKS: audience is bound both in the tuple and signed aud', () => {
  assert.throws(() => check(fixture({ proof: { audience: 'https://other.example' } })), /audience/);
  assert.throws(() => check(fixture({ claims: { aud: 'https://other.example' }, proof: { audience: 'https://other.example' } }),
    { ...policy, audience: 'https://other.example', container_env: { ...policy.container_env, ATTESTATION_TOKEN_AUDIENCE: 'https://other.example' } }), /binding mismatch/);
});
test('TEST-JWKS: rejects wrong Google signature, key ID and algorithm', () => {
  const proof = fixture();
  const parts = proof.attestation.token.split('.');
  parts[2] = Buffer.alloc(256).toString('base64url');
  proof.attestation.token = parts.join('.');
  assert.throws(() => check(proof), /signature/);
  assert.throws(() => check(fixture({ header: { kid: 'untrusted' } })), /signing key/);
  assert.throws(() => check(fixture({ header: { alg: 'HS256' } })), /JWT header/);
  assert.throws(() => verifyProof(fixture(), challenge, policy, { keys: [] }, now), /signing key/);
});
test('TEST-JWKS: rejects missing or invalid run-key possession signature', () => {
  assert.throws(() => check(fixture({ proof: { run_signature: Buffer.alloc(64).toString('base64url') } })), /possession signature/);
  assert.throws(() => check(fixture({ proof: { run_signature: undefined } })), /signature encoding/);
});
test('TEST-JWKS: rejects wrong measured image digest', () => {
  assert.throws(() => check(fixture({ container: { image_digest: 'sha256:' + '3'.repeat(64) } })), /image digest/);
});
test('TEST-JWKS: rejects untrusted or missing image signer', () => {
  for (const image_signatures of [[], undefined, [{ key_id: '3'.repeat(64), signature_algorithm: 'ECDSA_P256_SHA256', signature: 'TEST_ONLY' }]]) {
    assert.throws(() => check(fixture({ container: { image_signatures } }), signerPolicy), /untrusted image signer/);
  }
});
test('TEST-JWKS: rejects image signer claims with missing signature or wrong algorithm', () => {
  for (const signature of [{ key_id: signerID }, { key_id: signerID, signature: 'TEST_ONLY', signature_algorithm: 'unknown' }]) {
    assert.throws(() => check(fixture({ container: { image_signatures: [signature] } }), signerPolicy), /untrusted image signer/);
  }
});
for (const [name, container] of [
  ['arguments', { args: ['/bin/sh', '-c', 'unapproved command'] }],
  ['environment', { env: { ...policy.container_env, RUN_PRIVATE_KEY: 'TEST_ONLY' } }],
  ['command override', { cmd_override: ['/bin/sh'] }],
  ['environment override', { env_override: { APP_COMMAND: 'unapproved' } }],
]) test(`TEST-JWKS: rejects ${name} despite approved image`, () => assert.throws(() => check(fixture({ container })), /unapproved|forbidden/));

test('TEST-JWKS: rejects proof-version downgrade and ambiguous trust policy', () => {
  assert.throws(() => check(fixture({ proof: { proof_version: 'v3' } })), /version/);
  assert.throws(() => check(fixture(), { ...policy, proof_version: undefined }), /policy/);
  assert.throws(() => check(fixture(), { ...policy, image_signing_key_ids: [signerID] }), /exactly one/);
  assert.throws(() => check(fixture(), { ...policy, workload_image_digests: [] }), /allowlist/);
  assert.throws(() => check(fixture(), { ...policy, container_env: undefined }), /container_env/);
  assert.throws(() => check(fixture(), { ...policy, project_id: 'must-not-be-silently-ignored' }), /unsupported.*policy field/);
  assert.throws(() => check(fixture(), { ...policy, container_env: { ...policy.container_env, POPCORN_CONFIDENTIAL_SPACE: 'false' } }), /enable CS/);
});
test('rejects malformed canonical serialization rather than normalizing it', () => {
  const key = fixture().run_public_key;
  for (const args of [[challenge.toUpperCase(), key, policy.audience], [challenge, key + '=', policy.audience],
    [challenge, key, 'https://verifier.example\n'], [challenge, key, 'https://é.example']]) {
    assert.throws(() => canonicalRunBinding(...args), /canonical|encoding/);
  }
});
test('TEST-JWKS: fixed Google discovery/JWKS path, no proof-provided key endpoint', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    urls.push(url);
    assert.equal(options.redirect, 'error');
    if (url === DISCOVERY_URL) return Response.json({ issuer: ISSUER, jwks_uri: JWKS_URL });
    assert.equal(url, JWKS_URL);
    return Response.json(testJWKS);
  });
  assert.deepEqual(await fetchGoogleKeys(), testJWKS);
  assert.deepEqual(urls, [DISCOVERY_URL, JWKS_URL]);
});
test('TEST-JWKS: refuses discovery redirect to an untrusted signing-key URL', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, DISCOVERY_URL);
    return Response.json({ issuer: ISSUER, jwks_uri: 'https://attacker.example/jwks' });
  });
  await assert.rejects(fetchGoogleKeys(), /discovery/);
});
