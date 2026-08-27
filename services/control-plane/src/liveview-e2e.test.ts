import { describe, expect, test } from 'bun:test';
import {
  createLiveViewE2eEnrollment,
  LIVEVIEW_E2E_PROTOCOL,
  readLiveViewE2eRequest,
  readLiveViewEncryption,
  withLiveViewE2eBootstrapFragment,
} from './liveview-e2e';

const publicKey = Buffer.alloc(32, 7).toString('base64url');

describe('LiveView E2EE request validation', () => {
  test('allows default-mode sessions to omit the optional E2EE request', () => {
    expect(readLiveViewE2eRequest(undefined)).toEqual({});
    expect(readLiveViewE2eRequest(null).error).toContain('object');
  });

  test('accepts only version 1 canonical raw X25519 public keys', () => {
    expect(readLiveViewE2eRequest({ version: 1, clientPublicKey: publicKey }).value)
      .toEqual({ version: 1, clientPublicKey: publicKey });
    expect(readLiveViewE2eRequest({ version: 2, clientPublicKey: publicKey }).error).toContain('version');
    expect(readLiveViewE2eRequest({ version: 1, clientPublicKey: `${publicKey}=` }).error).toContain('base64url');
    expect(readLiveViewE2eRequest({ version: 1, clientPublicKey: Buffer.alloc(31).toString('base64url') }).error).toContain('base64url');
  });

  test('accepts the public e2e flag and creates a hash-only pod enrollment', () => {
    expect(readLiveViewEncryption(undefined)).toEqual({ enabled: false });
    expect(readLiveViewEncryption('e2e')).toEqual({ enabled: true });
    expect(readLiveViewEncryption(true).error).toContain('liveViewEncryption');
    const enrollment = createLiveViewE2eEnrollment();
    const nextEnrollment = createLiveViewE2eEnrollment();
    expect(enrollment.sessionKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nextEnrollment.sessionKey).not.toBe(enrollment.sessionKey);
    expect(enrollment.bindingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(enrollment.request.bindingSecretHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(enrollment.request).not.toHaveProperty('clientPublicKey');
    expect(readLiveViewE2eRequest(enrollment.request).value).toEqual(enrollment.request);
  });

  test('places one-time bootstrap metadata in a URL fragment', () => {
    const enrollment = createLiveViewE2eEnrollment();
    const liveViewE2e = {
      version: 1 as const,
      protocol: LIVEVIEW_E2E_PROTOCOL,
      bindingSecret: enrollment.bindingSecret,
      podPublicKey: publicKey,
      podUid: 'pod-uid',
      e2eRfbUrl: 'wss://gateway.example/liveview-e2e-rfb/demo/token',
      e2eControlUrl: 'wss://gateway.example/liveview-e2e-control/demo/token',
    };
    const result = new URL(withLiveViewE2eBootstrapFragment(
      'https://gateway.example/liveview/demo/token/liveview.html?encryption=e2e',
      'demo',
      enrollment.sessionKey,
      liveViewE2e,
    ));
    expect(result.pathname).toBe('/liveview/demo/token/liveview.html');
    expect(result.search).toBe('?encryption=e2e');
    const payload = JSON.parse(Buffer.from(result.hash.split('=', 2)[1], 'base64url').toString('utf8'));
    expect(payload).toEqual({ sessionId: 'demo', sessionKey: enrollment.sessionKey, liveViewE2e });
  });
});
