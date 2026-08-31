import crypto from 'crypto';
import { McpConfig } from './config';
import type { DeviceNonce, McpStore } from './store';

/**
 * Anonymous device identity.
 *
 * There is no account, no email and no password. The authorization page
 * generates a non-extractable ECDSA P-256 keypair in the browser, keeps it in
 * IndexedDB, and proves possession by signing a server nonce. The public key
 * IS the identity: its thumbprint becomes the OAuth subject that owns the
 * Popcorn credit balance.
 *
 * Consequences we state plainly in the UI: clearing site data or switching
 * browsers means a new identity and a new balance.
 */

export type PublicKeyJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string };

export function isPublicKeyJwk(value: unknown): value is PublicKeyJwk {
  const jwk = value as PublicKeyJwk;
  return (
    !!jwk &&
    jwk.kty === 'EC' &&
    jwk.crv === 'P-256' &&
    typeof jwk.x === 'string' &&
    typeof jwk.y === 'string' &&
    jwk.x.length <= 128 &&
    jwk.y.length <= 128
  );
}

/** RFC 7638 JWK thumbprint — canonical, so the same key always maps to the same subject. */
export function jwkThumbprint(jwk: PublicKeyJwk): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

/** Pseudonymous subject for a device key. */
export function subjectForKey(jwk: PublicKeyJwk): string {
  const thumbprint = jwkThumbprint(jwk);
  return `device:${crypto.createHmac('sha256', McpConfig.tokenSigningKey).update(thumbprint).digest('hex').slice(0, 32)}`;
}

export async function issueNonce(store: McpStore, now = Date.now()): Promise<DeviceNonce> {
  const nonce: DeviceNonce = {
    value: crypto.randomBytes(32).toString('base64url'),
    createdAt: now,
    expiresAt: now + 5 * 60_000,
    consumed: false,
  };
  await store.putNonce(nonce);
  return nonce;
}

export type ProofResult =
  | { ok: true; subject: string }
  | { ok: false; error: 'bad_key' | 'bad_nonce' | 'bad_signature'; message: string };

/**
 * Verify an ECDSA P-256 / SHA-256 signature (WebCrypto raw r||s) over the nonce.
 * The nonce is single-use, so a captured proof cannot be replayed.
 */
export async function verifyDeviceProof(
  store: McpStore,
  input: { publicKeyJwk: unknown; nonce: string; signatureB64: string },
  now = Date.now(),
): Promise<ProofResult> {
  if (!isPublicKeyJwk(input.publicKeyJwk)) {
    return { ok: false, error: 'bad_key', message: 'A P-256 public key is required.' };
  }
  const nonce = await store.consumeNonce(input.nonce);
  if (!nonce || nonce.expiresAt <= now) {
    return { ok: false, error: 'bad_nonce', message: 'That sign-in attempt expired. Reload and try again.' };
  }

  let signature: Uint8Array<ArrayBuffer>;
  try {
    const decoded = Buffer.from(input.signatureB64, 'base64');
    const copy = new Uint8Array(new ArrayBuffer(decoded.byteLength));
    copy.set(decoded);
    signature = copy;
  } catch {
    return { ok: false, error: 'bad_signature', message: 'Malformed signature.' };
  }
  if (signature.length !== 64) {
    return { ok: false, error: 'bad_signature', message: 'Malformed signature.' };
  }

  const key = await crypto.subtle.importKey(
    'jwk',
    { ...input.publicKeyJwk, ext: true } as any,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    signature,
    new TextEncoder().encode(nonce.value),
  );
  if (!valid) return { ok: false, error: 'bad_signature', message: 'Could not verify this device.' };

  const subject = subjectForKey(input.publicKeyJwk);
  await store.putDevice({ subject, thumbprint: jwkThumbprint(input.publicKeyJwk), createdAt: now });
  return { ok: true, subject };
}
