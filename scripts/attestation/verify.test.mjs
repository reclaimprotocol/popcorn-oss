import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyProof, digestBinding, ISSUER } from './verify.mjs';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256' }] };
const nonce = 'ab'.repeat(32);
const now = 2000000000;
const workload = 'registry.example/browser@sha256:' + '1'.repeat(64);
const verifier = 'registry.example/attestor@sha256:' + '2'.repeat(64);
const policy = { audience: 'https://gateway.example', project_id: 'expected-project', zone: 'expected-zone', instance_name: 'expected-instance',
  service_account: 'attestor@example.iam.gserviceaccount.com', workload_image_digests: [workload],
  verifier_image_digests: [verifier], max_age_seconds: 300, clock_skew_seconds: 30 };
function fixture(changeClaims = {}, changeProof = {}, header = { alg: 'RS256', kid: 'test' }) {
  const proof = { proof_version: 'v3', tee_provider: 'gcp', tee_technology: 'amd-sev', nonce,
    workload: { container_name: 'browser-runtime', image_digest: workload },
    verifier: { container_name: 'browser-runtime-attestor', image_digest: verifier } };
  const claims = { iss: ISSUER, aud: policy.audience, iat: now - 10, exp: now + 300,
    eat_nonce: [nonce, digestBinding(proof)], hwmodel: 'GCP_AMD_SEV', secboot: true,
    submods: { gce: { project_id: policy.project_id, zone: policy.zone, instance_name: policy.instance_name } },
    google_service_accounts: [policy.service_account], ...changeClaims };
  const input = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return { ...proof, attestation: { token: input + '.' + sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url') }, ...changeProof };
}
test('verifies signed platform claims and reported image identities against policy', () => {
  assert.deepEqual(verifyProof(fixture(), nonce, policy, jwks, now), {
    platform_and_image_assertion_verified: true,
    scope: 'Google-signed platform claims and nonce-bound orchestrator-reported image identities satisfy the supplied policy.',
  });
});
for (const [name, claims] of Object.entries({ issuer: { iss: 'https://evil.example' }, audience: { aud: 'other' },
  expired: { exp: now - 31 }, future: { iat: now + 31 }, stale: { iat: now - 331 },
  notYetValid: { nbf: now + 31 }, missingTime: { iat: null }, nonce: { eat_nonce: ['cd'.repeat(32)] },
  imageBinding: { eat_nonce: [nonce] }, secureBoot: { secboot: false }, hardware: { hwmodel: 'other' },
  project: { submods: { gce: { project_id: 'other', zone: policy.zone } } },
  zone: { submods: { gce: { project_id: policy.project_id, zone: 'other' } } }, accounts: { google_service_accounts: [] },
})) test(`rejects signed token violating ${name}`, () => assert.throws(() => verifyProof(fixture(claims), nonce, policy, jwks, now)));
test('rejects forged signature and wrong signing key', () => {
  const proof = fixture();
  const parts = proof.attestation.token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ iss: ISSUER })).toString('base64url');
  proof.attestation.token = parts.join('.');
  assert.throws(() => verifyProof(proof, nonce, policy, jwks, now), /signature/);
  assert.throws(() => verifyProof(fixture(), nonce, policy, { keys: [] }, now), /signing key/);
});
test('rejects unexpected JWT algorithms', () => assert.throws(() => verifyProof(fixture({}, {}, { alg: 'HS256', kid: 'test' }), nonce, policy, jwks, now)));
test('rejects altered proof or missing trust policy', () => {
  assert.throws(() => verifyProof(fixture({}, { nonce: 'cd'.repeat(32) }), nonce, policy, jwks, now));
  assert.throws(() => verifyProof(fixture(), nonce, {}, jwks, now));
  assert.throws(() => verifyProof(fixture(), nonce, { ...policy, workload_image_digests: [verifier] }, jwks, now));
});
test('digest binding has no trailing newline and uses the specified field order', () => {
  assert.equal(digestBinding(fixture()), 'ba37a4bc565962533b54716ded496d45cd0e2bc79e5f45a0ee81c874a680779e');
});

test('requires independently pinned instance, even without a service-account claim', () => {
  const { service_account, ...instancePolicy } = policy;
  assert.equal(verifyProof(fixture({ google_service_accounts: undefined }), nonce, instancePolicy, jwks, now).platform_and_image_assertion_verified, true);
  assert.throws(() => verifyProof(fixture(), nonce, { ...instancePolicy, instance_name: 'other' }, jwks, now), /instance identity/);
  assert.throws(() => verifyProof(fixture(), nonce, { ...instancePolicy, instance_name: undefined }, jwks, now), /requires instance_name/);
});
