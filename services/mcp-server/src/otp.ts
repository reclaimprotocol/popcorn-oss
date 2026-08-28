import crypto from 'crypto';
import { McpConfig } from './config';
import type { McpStore, OtpChallenge } from './store';
import { readSesConfig, sendEmail } from './ses';
import { subjectFor } from './oauth';

/**
 * Email OTP sign-in. There is no sign-up step: proving control of an email
 * address IS the account. The email is never stored — only a salted hash of
 * the code and the derived OAuth subject.
 */

export const OTP_TTL_SECONDS = 600;
export const OTP_MAX_ATTEMPTS = 5;

export function normalizeEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Salted hash of an address; the plaintext email is never persisted. */
export function hashEmail(email: string): string {
  return crypto.createHmac('sha256', McpConfig.tokenSigningKey).update(`email:${email}`).digest('hex');
}

export function hashCode(challengeId: string, code: string): string {
  return crypto.createHmac('sha256', McpConfig.tokenSigningKey).update(`${challengeId}:${code}`).digest('hex');
}

export function verifyCodeHash(challengeId: string, code: string, expected: string): boolean {
  const actual = hashCode(challengeId, code);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export type OtpSendResult =
  | { ok: true; challengeId: string }
  | { ok: false; error: 'invalid_email' | 'rate_limited' | 'send_failed'; message: string };

export async function startEmailOtp(
  store: McpStore,
  rawEmail: string,
  now = Date.now(),
): Promise<OtpSendResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, error: 'invalid_email', message: 'Enter a valid email address.' };

  const emailHash = hashEmail(email);
  const recent = await store.countRecentOtps(emailHash, now - 15 * 60_000);
  if (recent >= McpConfig.otpMaxPerWindow) {
    return { ok: false, error: 'rate_limited', message: 'Too many codes requested. Try again in a few minutes.' };
  }

  const challengeId = crypto.randomBytes(16).toString('hex');
  const code = generateCode();
  const challenge: OtpChallenge = {
    id: challengeId,
    emailHash,
    subject: subjectFor(email),
    codeHash: hashCode(challengeId, code),
    attempts: 0,
    verified: false,
    createdAt: now,
    expiresAt: now + OTP_TTL_SECONDS * 1000,
  };
  await store.putOtp(challenge);

  try {
    await sendEmail({
      config: readSesConfig(),
      to: email,
      subject: `${code} is your Popcorn sign-in code`,
      text: `Your Popcorn sign-in code is ${code}. It expires in 10 minutes.\n\nSomeone is authorizing an AI agent to run browser sessions on your behalf and spend your Popcorn credit. If that wasn't you, ignore this email.`,
      html: `<div style="font-family:system-ui;line-height:1.5">
  <p>Your Popcorn sign-in code is:</p>
  <p style="font-size:2rem;letter-spacing:.25rem;font-weight:600">${code}</p>
  <p>It expires in 10 minutes.</p>
  <p style="color:#666">Someone is authorizing an AI agent to run browser sessions on your behalf and spend your Popcorn credit. If that wasn't you, ignore this email.</p>
</div>`,
    });
  } catch (error) {
    return { ok: false, error: 'send_failed', message: (error as Error).message };
  }

  return { ok: true, challengeId };
}

export type OtpVerifyResult =
  | { ok: true; subject: string }
  | { ok: false; error: 'not_found' | 'expired' | 'too_many_attempts' | 'invalid_code'; message: string };

export async function verifyEmailOtp(
  store: McpStore,
  challengeId: string,
  code: string,
  now = Date.now(),
): Promise<OtpVerifyResult> {
  const challenge = await store.getOtp(challengeId);
  if (!challenge || challenge.verified) {
    return { ok: false, error: 'not_found', message: 'That sign-in request is no longer valid. Start again.' };
  }
  if (challenge.expiresAt <= now) {
    return { ok: false, error: 'expired', message: 'That code expired. Request a new one.' };
  }
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, error: 'too_many_attempts', message: 'Too many incorrect codes. Request a new one.' };
  }
  await store.updateOtp(challengeId, { attempts: challenge.attempts + 1 });
  if (!/^\d{6}$/.test(code.trim()) || !verifyCodeHash(challengeId, code.trim(), challenge.codeHash)) {
    return { ok: false, error: 'invalid_code', message: 'That code is not correct.' };
  }
  await store.updateOtp(challengeId, { verified: true });
  return { ok: true, subject: challenge.subject };
}
