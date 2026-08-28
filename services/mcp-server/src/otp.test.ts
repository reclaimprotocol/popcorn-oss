import { describe, expect, test } from 'bun:test';
import { OTP_MAX_ATTEMPTS, generateCode, hashCode, hashEmail, normalizeEmail, verifyCodeHash, verifyEmailOtp } from './otp';
import { parseStsResponse, resolveCredentials, signRequest, __resetCredentialCache } from './ses';
import { InMemoryStore } from './store';

function seed(store: InMemoryStore, code: string, overrides: Record<string, unknown> = {}) {
  const id = 'chal-1';
  store.putOtp({
    id,
    emailHash: hashEmail('user@example.com'),
    subject: 'popcorn:test-subject',
    codeHash: hashCode(id, code),
    attempts: 0,
    verified: false,
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    ...overrides,
  } as any);
  return id;
}

describe('email otp', () => {
  test('normalizes and rejects bad addresses', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com');
    expect(normalizeEmail('nope')).toBeNull();
    expect(normalizeEmail(`${'a'.repeat(250)}@example.com`)).toBeNull();
  });

  test('generates 6-digit codes', () => {
    for (let i = 0; i < 50; i += 1) expect(generateCode()).toMatch(/^\d{6}$/);
  });

  test('accepts the right code once', async () => {
    const store = new InMemoryStore();
    const id = seed(store, '123456');
    expect(await verifyEmailOtp(store, id, '123456')).toEqual({ ok: true, subject: 'popcorn:test-subject' });
    const replay = await verifyEmailOtp(store, id, '123456');
    expect(replay.ok).toBe(false);
  });

  test('rejects a wrong code and counts the attempt', async () => {
    const store = new InMemoryStore();
    const id = seed(store, '123456');
    const result = await verifyEmailOtp(store, id, '000000');
    expect(result).toMatchObject({ ok: false, error: 'invalid_code' });
    expect((await store.getOtp(id))?.attempts).toBe(1);
  });

  test('locks out after too many attempts', async () => {
    const store = new InMemoryStore();
    const id = seed(store, '123456', { attempts: OTP_MAX_ATTEMPTS });
    expect(await verifyEmailOtp(store, id, '123456')).toMatchObject({ error: 'too_many_attempts' });
  });

  test('rejects expired challenges', async () => {
    const store = new InMemoryStore();
    const id = seed(store, '123456', { expiresAt: Date.now() - 1 });
    expect(await verifyEmailOtp(store, id, '123456')).toMatchObject({ error: 'expired' });
  });

  test('challenges never persist the plaintext address', async () => {
    const store = new InMemoryStore();
    const id = seed(store, '123456');
    expect(JSON.stringify(await store.getOtp(id))).not.toContain('user@example.com');
  });

  test('code hashes are challenge-scoped', () => {
    expect(verifyCodeHash('chal-1', '123456', hashCode('chal-2', '123456'))).toBe(false);
  });
});

describe('ses credentials', () => {
  test('prefers static keys', async () => {
    __resetCredentialCache();
    const resolved = await resolveCredentials({ AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'SECRET' } as any);
    expect(resolved.accessKeyId).toBe('AKID');
  });

  test('parses STS web-identity credentials (IRSA)', () => {
    const xml = `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials>
      <AccessKeyId>ASIA123</AccessKeyId><SecretAccessKey>s3cret</SecretAccessKey>
      <SessionToken>tok</SessionToken><Expiration>2026-08-28T13:00:00Z</Expiration>
    </Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`;
    const parsed = parseStsResponse(xml);
    expect(parsed).toMatchObject({ accessKeyId: 'ASIA123', secretAccessKey: 's3cret', sessionToken: 'tok' });
  });

  test('fails loudly when no credential source exists', async () => {
    __resetCredentialCache();
    await expect(resolveCredentials({} as any)).rejects.toThrow(/no AWS credentials/);
  });
});

describe('ses signing', () => {
  test('produces a deterministic SigV4 authorization header', () => {
    const signed = signRequest({
      config: {
        region: 'us-east-1',
        fromAddress: 'noreply@reclaimprotocol.org',
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'SECRET',
      },
      method: 'POST',
      host: 'email.us-east-1.amazonaws.com',
      path: '/v2/email/outbound-emails',
      payload: '{}',
      now: new Date('2026-08-28T12:00:00Z'),
    });
    expect(signed.amzDate).toBe('20260828T120000Z');
    expect(signed.authorization).toContain('Credential=AKIDEXAMPLE/20260828/us-east-1/ses/aws4_request');
    expect(signed.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });
});
