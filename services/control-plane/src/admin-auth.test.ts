import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  authorizeGoogleUser,
  createAdminSession,
  isGoogleOAuthConfigured,
  isAdminAuthPath,
  isPasswordLoginConfigured,
  parseHtpasswd,
  readAdminAuthConfig,
  verifyAdminPassword,
  verifyAdminSession,
} from './admin-auth';

describe('control plane admin auth', () => {
  test('allows login assets without an admin session', () => {
    expect(isAdminAuthPath('/admin/assets/favicon-32.png')).toBe(true);
    expect(isAdminAuthPath('/admin/assets/site.webmanifest')).toBe(true);
    expect(isAdminAuthPath('/admin/clients')).toBe(false);
  });

  test('verifies legacy password credentials', async () => {
    const config = readAdminAuthConfig({
      ADMIN_USER: 'admin',
      ADMIN_PASS: 'admin-pass',
      ADMIN_SESSION_SECRET: 'test-secret',
    });

    expect(isPasswordLoginConfigured(config)).toBe(true);
    expect(await verifyAdminPassword('admin', 'admin-pass', config)).toBe(true);
    expect(await verifyAdminPassword('admin', 'wrong', config)).toBe(false);
  });

  test('verifies bcrypt htpasswd credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'popcorn-control-plane-auth-'));
    const passwordFile = join(dir, 'admin.htpasswd');
    const hash = await Bun.password.hash('file-pass', {
      algorithm: 'bcrypt',
      cost: 4,
    });
    writeFileSync(passwordFile, `file-admin:${hash}\n`);

    const config = readAdminAuthConfig({
      ADMIN_PASSWORD_FILE: passwordFile,
      ADMIN_SESSION_SECRET: 'test-secret',
    });

    expect(parseHtpasswd(`file-admin:${hash}\n`).has('file-admin')).toBe(true);
    expect(await verifyAdminPassword('file-admin', 'file-pass', config)).toBe(true);
    expect(await verifyAdminPassword('file-admin', 'wrong', config)).toBe(false);
  });

  test('signs and verifies admin sessions', () => {
    const config = readAdminAuthConfig({
      ADMIN_SESSION_SECRET: 'test-secret',
      ADMIN_SESSION_TTL_SECONDS: '60',
    });

    const session = createAdminSession({
      id: 'admin',
      displayName: 'Admin',
      strategy: 'password',
    }, config, 1000);

    expect(verifyAdminSession(session, config, 2000)?.id).toBe('admin');
    expect(verifyAdminSession(`${session}tampered`, config, 2000)).toBeNull();
    expect(verifyAdminSession(session, config, 62000)).toBeNull();
  });

  test('authorizes Google users by email or domain', () => {
    const config = readAdminAuthConfig({
      ADMIN_AUTH_STRATEGIES: 'google',
      ADMIN_SESSION_SECRET: 'test-secret',
      ADMIN_GOOGLE_CLIENT_ID: 'client',
      ADMIN_GOOGLE_CLIENT_SECRET: 'secret',
      ADMIN_GOOGLE_REDIRECT_URI: 'https://control-plane.example.com/admin/auth/google/callback',
      ADMIN_GOOGLE_ALLOWED_EMAILS: 'person@example.com',
      ADMIN_GOOGLE_ALLOWED_DOMAINS: 'example.com',
    });

    expect(isGoogleOAuthConfigured(config)).toBe(true);
    expect(authorizeGoogleUser({ email: 'person@example.com', email_verified: true }, config)?.id).toBe('person@example.com');
    expect(authorizeGoogleUser({ email: 'admin@example.com', email_verified: 'true' }, config)?.id).toBe('admin@example.com');
    expect(authorizeGoogleUser({ email: 'outsider@example.net', email_verified: true }, config)).toBeNull();
    expect(authorizeGoogleUser({ email: 'admin@example.com', email_verified: false }, config)).toBeNull();
  });
});
