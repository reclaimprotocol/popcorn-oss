#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const ISSUER = 'https://confidentialcomputing.googleapis.com';
export const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
export const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@confidentialspace-sign.iam.gserviceaccount.com';

export function digestBinding(proof) {
  return createHash('sha256').update([
    'v3',
    `workload.container_name=${proof.workload.container_name}`,
    `workload.image_digest=${proof.workload.image_digest}`,
    `verifier.container_name=${proof.verifier.container_name}`,
    `verifier.image_digest=${proof.verifier.image_digest}`,
  ].join('\n'), 'utf8').digest('hex');
}

function validatePolicy(policy) {
  for (const name of ['audience', 'project_id', 'zone', 'instance_name']) {
    assert(typeof policy?.[name] === 'string' && policy[name].length > 0, `trusted policy requires ${name}`);
  }
  if (policy.service_account !== undefined) assert(typeof policy.service_account === 'string' && policy.service_account.length > 0, 'invalid service_account policy');
  for (const name of ['workload_image_digests', 'verifier_image_digests']) {
    assert(Array.isArray(policy[name]) && policy[name].length > 0 &&
      policy[name].every(value => typeof value === 'string' && /^[^\s]+@sha256:[0-9a-f]{64}$/.test(value)),
    `trusted policy requires pinned ${name}`);
  }
  assert(Number.isSafeInteger(policy.max_age_seconds) && policy.max_age_seconds > 0, 'trusted policy requires positive max_age_seconds');
  assert(Number.isSafeInteger(policy.clock_skew_seconds) && policy.clock_skew_seconds >= 0, 'trusted policy requires nonnegative clock_skew_seconds');
}

/** jwks must come from an independently trusted source, never from the proof. */
export function verifyProof(proof, nonce, policy, jwks, now = Math.floor(Date.now() / 1000)) {
  validatePolicy(policy);
  assert(typeof nonce === 'string' && /^[0-9a-f]{64}$/.test(nonce), 'supply the locally retained 32-byte nonce');
  assert(proof && !proof.error && proof.proof_version === 'v3', 'invalid proof version or error');
  assert(proof.tee_provider === 'gcp' && proof.tee_technology === 'amd-sev', 'unexpected proof platform');
  assert(proof.nonce === nonce, 'proof nonce mismatch');
  assert(proof.workload?.container_name === 'browser-runtime', 'unexpected workload container');
  assert(proof.verifier?.container_name === 'browser-runtime-attestor', 'unexpected verifier container');
  assert(policy.workload_image_digests.includes(proof.workload.image_digest), 'workload digest is not allowed');
  assert(policy.verifier_image_digests.includes(proof.verifier.image_digest), 'verifier digest is not allowed');
  const token = proof.attestation?.token;
  assert(typeof token === 'string' && token.length < 262144, 'invalid token');
  const parts = token.split('.');
  assert(parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)), 'invalid JWT encoding');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  assert(header.alg === 'RS256' && typeof header.kid === 'string' && !header.crit, 'unsupported JWT header');
  const keys = (jwks?.keys ?? []).filter(key => key.kid === header.kid && key.kty === 'RSA' &&
    (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
  assert(keys.length === 1, 'signing key missing or ambiguous');
  assert(verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key: keys[0], format: 'jwk' }), Buffer.from(parts[2], 'base64url')), 'invalid JWT signature');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  assert(claims.iss === ISSUER, 'issuer mismatch');
  assert(claims.aud === policy.audience, 'audience mismatch');
  const skew = policy.clock_skew_seconds;
  assert(Number.isSafeInteger(claims.exp) && Number.isSafeInteger(claims.iat), 'missing token time claims');
  assert(claims.exp > now - skew && claims.exp > claims.iat, 'token expired or invalid lifetime');
  assert(claims.iat <= now + skew && now - claims.iat <= policy.max_age_seconds + skew, 'token is future-dated or stale');
  if (claims.nbf !== undefined) assert(Number.isSafeInteger(claims.nbf) && claims.nbf <= now + skew, 'token not yet valid');
  const nonces = typeof claims.eat_nonce === 'string' ? [claims.eat_nonce] : claims.eat_nonce;
  assert(Array.isArray(nonces) && nonces.includes(nonce), 'signed nonce mismatch');
  assert(nonces.includes(digestBinding(proof)), 'signed image binding mismatch');
  assert(claims.hwmodel === 'GCP_AMD_SEV' && claims.secboot === true, 'platform policy failed');
  const gce = claims.submods?.gce;
  assert(gce?.project_id === policy.project_id && gce?.zone === policy.zone, 'cloud identity mismatch');
  assert(gce.instance_name === policy.instance_name, 'instance identity mismatch');
  const accounts = [...(Array.isArray(claims.google_service_accounts) ? claims.google_service_accounts : []), gce.service_account, gce.service_account_id];
  if (policy.service_account !== undefined) assert(accounts.includes(policy.service_account), 'service account mismatch');
  return {
    platform_and_image_assertion_verified: true,
    scope: 'Google-signed platform claims and nonce-bound orchestrator-reported image identities satisfy the supplied policy.',
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert(response.ok, `trusted key endpoint returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      assert(length <= 262144, 'key response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function fetchGoogleKeys() {
  const discovery = await fetchJson(DISCOVERY_URL);
  assert(discovery.issuer === ISSUER && discovery.jwks_uri === JWKS_URL, 'unexpected Google discovery configuration');
  return fetchJson(JWKS_URL);
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(['--proof', '--nonce', '--policy'].includes(args[i]) && args[i + 1] && !options[args[i]], 'invalid or duplicate option');
    options[args[i]] = args[i + 1];
  }
  assert(options['--proof'] && options['--nonce'] && options['--policy'],
    'Usage: node verify.mjs --proof proof.json --nonce <locally-retained-nonce> --policy trusted-policy.json');
  const proof = JSON.parse(await readFile(options['--proof'], 'utf8'));
  const policy = JSON.parse(await readFile(options['--policy'], 'utf8'));
  validatePolicy(policy);
  console.log(JSON.stringify(verifyProof(proof, options['--nonce'], policy, await fetchGoogleKeys()), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Verification failed: ${error.message}`); process.exitCode = 1; });
}
