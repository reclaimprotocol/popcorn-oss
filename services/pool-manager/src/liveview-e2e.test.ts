import { describe, expect, test } from 'bun:test';
import { readLiveViewE2eRequest } from './liveview-e2e';

const publicKey = Buffer.alloc(32, 9).toString('base64url');

describe('LiveView E2EE request validation', () => {
    test('allows default-mode sessions to omit the optional E2EE request', () => {
        expect(readLiveViewE2eRequest(undefined)).toEqual({});
        expect(readLiveViewE2eRequest(null).error).toContain('object');
    });

    test('requires canonical base64url raw 32-byte X25519 public keys', () => {
        expect(readLiveViewE2eRequest({ version: 1, clientPublicKey: publicKey }).value)
            .toEqual({ version: 1, clientPublicKey: publicKey });
        expect(readLiveViewE2eRequest({ version: 1, clientPublicKey: 'not-a-key' }).error).toContain('base64url');
        expect(readLiveViewE2eRequest({ version: 3, clientPublicKey: publicKey }).error).toContain('version');
    });

    test('accepts a hash-only first-connection enrollment binding', () => {
        const bindingSecretHash = Buffer.alloc(32, 4).toString('base64url');
        expect(readLiveViewE2eRequest({ version: 1, bindingSecretHash }).value)
            .toEqual({ version: 1, bindingSecretHash });
        expect(readLiveViewE2eRequest({ version: 1, clientPublicKey: publicKey, bindingSecretHash }).error)
            .toContain('exactly one');
    });
});
