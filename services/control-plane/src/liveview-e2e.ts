import crypto from 'crypto';

export const LIVEVIEW_E2E_VERSION = 1;
export const LIVEVIEW_E2E_PROTOCOL = 'Noise_IK_25519_ChaChaPoly_SHA256';
export const LIVEVIEW_ENCRYPTION_E2E = 'e2e';
export const LIVEVIEW_E2E_FRAGMENT_KEY = 'popcorn-e2e';

export interface LiveViewE2eRequest {
  version: 1;
  clientPublicKey?: string;
  bindingSecretHash?: string;
}

export interface LiveViewE2eResponse {
  version: 1;
  protocol: typeof LIVEVIEW_E2E_PROTOCOL;
  clientPublicKey?: string;
  bindingSecret?: string;
  podPublicKey: string;
  podUid: string;
  e2eRfbUrl: string;
  e2eControlUrl: string;
}

export interface LiveViewE2eEnrollment {
  sessionKey: string;
  bindingSecret: string;
  request: LiveViewE2eRequest;
}

export function isBase64UrlX25519PublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === value;
  } catch {
    return false;
  }
}

export const isBase64Url32Bytes = isBase64UrlX25519PublicKey;

export function readLiveViewEncryption(value: unknown): { enabled: boolean; error?: string } {
  if (value === undefined) return { enabled: false };
  if (value === LIVEVIEW_ENCRYPTION_E2E) return { enabled: true };
  return { enabled: false, error: 'liveViewEncryption must be "e2e" when provided' };
}

export function createLiveViewE2eEnrollment(): LiveViewE2eEnrollment {
  const secret = crypto.randomBytes(32);
  return {
    sessionKey: crypto.randomBytes(32).toString('base64url'),
    bindingSecret: secret.toString('base64url'),
    request: {
      version: LIVEVIEW_E2E_VERSION,
      bindingSecretHash: crypto.createHash('sha256').update(secret).digest('base64url'),
    },
  };
}

// The fragment is available to the viewer but is never included in the HTTP
// request to the gateway. It carries the one-time enrollment response into the
// unified viewer so a create-response URL is directly usable without trusting
// the gateway with the binding secret.
export function withLiveViewE2eBootstrapFragment(
  url: string,
  sessionId: string,
  sessionKey: string,
  liveViewE2e: LiveViewE2eResponse,
): string {
  const parsed = new URL(url);
  if (!isBase64Url32Bytes(sessionKey)) throw new TypeError('sessionKey must be a canonical base64url raw 32-byte value');
  const payload = Buffer.from(JSON.stringify({ sessionId, sessionKey, liveViewE2e }), 'utf8').toString('base64url');
  parsed.hash = `${LIVEVIEW_E2E_FRAGMENT_KEY}=${payload}`;
  return parsed.toString();
}

export function readLiveViewE2eRequest(value: unknown): { value?: LiveViewE2eRequest; error?: string } {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'liveViewE2e must be an object when provided' };
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== LIVEVIEW_E2E_VERSION) return { error: 'liveViewE2e.version must be 1' };
  const hasClientKey = candidate.clientPublicKey !== undefined;
  const hasBindingHash = candidate.bindingSecretHash !== undefined;
  if (hasClientKey === hasBindingHash) {
    return { error: 'liveViewE2e must contain exactly one clientPublicKey or bindingSecretHash' };
  }
  if (hasClientKey && !isBase64UrlX25519PublicKey(candidate.clientPublicKey)) {
    return { error: 'liveViewE2e.clientPublicKey must be a canonical base64url raw 32-byte X25519 public key' };
  }
  if (hasBindingHash && !isBase64Url32Bytes(candidate.bindingSecretHash)) {
    return { error: 'liveViewE2e.bindingSecretHash must be a canonical base64url SHA-256 digest' };
  }
  return { value: {
    version: LIVEVIEW_E2E_VERSION,
    ...(hasClientKey ? { clientPublicKey: candidate.clientPublicKey as string } : {}),
    ...(hasBindingHash ? { bindingSecretHash: candidate.bindingSecretHash as string } : {}),
  } };
}

export function isLiveViewE2eResponse(value: unknown): value is LiveViewE2eResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === LIVEVIEW_E2E_VERSION
    && candidate.protocol === LIVEVIEW_E2E_PROTOCOL
    && (candidate.clientPublicKey === undefined || isBase64UrlX25519PublicKey(candidate.clientPublicKey))
    && (candidate.bindingSecret === undefined || isBase64Url32Bytes(candidate.bindingSecret))
    && isBase64UrlX25519PublicKey(candidate.podPublicKey)
    && typeof candidate.podUid === 'string' && candidate.podUid.length > 0
    && typeof candidate.e2eRfbUrl === 'string' && candidate.e2eRfbUrl.length > 0
    && typeof candidate.e2eControlUrl === 'string' && candidate.e2eControlUrl.length > 0;
}
