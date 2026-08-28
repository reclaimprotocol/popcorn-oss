import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import { issueNonce, jwkThumbprint, subjectForKey, verifyDeviceProof, type PublicKeyJwk } from './device';
import { InMemoryStore } from './store';

async function deviceKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as any;
  const publicKeyJwk: PublicKeyJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  return { pair, publicKeyJwk };
}

async function sign(pair: CryptoKeyPair, nonce: string) {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.privateKey,
    new TextEncoder().encode(nonce),
  );
  return Buffer.from(new Uint8Array(signature)).toString('base64');
}

describe('anonymous device identity', () => {
  test('a valid signature over the nonce authenticates a brand-new identity', async () => {
    const store = new InMemoryStore();
    const { pair, publicKeyJwk } = await deviceKeyPair();
    const nonce = await issueNonce(store);
    const result = await verifyDeviceProof(store, {
      publicKeyJwk,
      nonce: nonce.value,
      signatureB64: await sign(pair, nonce.value),
    });
    expect(result).toEqual({ ok: true, subject: subjectForKey(publicKeyJwk) });
    expect(await store.getDevice(subjectForKey(publicKeyJwk))).not.toBeNull();
  });

  test('the same key always maps to the same subject and balance', async () => {
    const { publicKeyJwk } = await deviceKeyPair();
    expect(subjectForKey(publicKeyJwk)).toBe(subjectForKey({ ...publicKeyJwk }));
  });

  test('different keys are different identities', async () => {
    const a = await deviceKeyPair();
    const b = await deviceKeyPair();
    expect(subjectForKey(a.publicKeyJwk)).not.toBe(subjectForKey(b.publicKeyJwk));
  });

  test('a nonce cannot be replayed', async () => {
    const store = new InMemoryStore();
    const { pair, publicKeyJwk } = await deviceKeyPair();
    const nonce = await issueNonce(store);
    const signature = await sign(pair, nonce.value);
    expect((await verifyDeviceProof(store, { publicKeyJwk, nonce: nonce.value, signatureB64: signature })).ok).toBe(true);
    const replay = await verifyDeviceProof(store, { publicKeyJwk, nonce: nonce.value, signatureB64: signature });
    expect(replay).toMatchObject({ ok: false, error: 'bad_nonce' });
  });

  test('a signature from another key is rejected', async () => {
    const store = new InMemoryStore();
    const victim = await deviceKeyPair();
    const attacker = await deviceKeyPair();
    const nonce = await issueNonce(store);
    const result = await verifyDeviceProof(store, {
      publicKeyJwk: victim.publicKeyJwk,
      nonce: nonce.value,
      signatureB64: await sign(attacker.pair, nonce.value),
    });
    expect(result).toMatchObject({ ok: false, error: 'bad_signature' });
  });

  test('expired nonces are refused', async () => {
    const store = new InMemoryStore();
    const { pair, publicKeyJwk } = await deviceKeyPair();
    const nonce = await issueNonce(store, Date.now() - 10 * 60_000);
    const result = await verifyDeviceProof(store, {
      publicKeyJwk,
      nonce: nonce.value,
      signatureB64: await sign(pair, nonce.value),
    });
    expect(result).toMatchObject({ ok: false, error: 'bad_nonce' });
  });

  test('rejects non-P-256 keys', async () => {
    const store = new InMemoryStore();
    const nonce = await issueNonce(store);
    const result = await verifyDeviceProof(store, {
      publicKeyJwk: { kty: 'RSA', n: 'x' },
      nonce: nonce.value,
      signatureB64: 'AAAA',
    });
    expect(result).toMatchObject({ ok: false, error: 'bad_key' });
  });

  test('thumbprints are canonical (RFC 7638 member order)', async () => {
    const { publicKeyJwk } = await deviceKeyPair();
    const reordered = { y: publicKeyJwk.y, x: publicKeyJwk.x, crv: publicKeyJwk.crv, kty: publicKeyJwk.kty } as PublicKeyJwk;
    expect(jwkThumbprint(reordered)).toBe(jwkThumbprint(publicKeyJwk));
  });
});
