import crypto from 'node:crypto';

// The paid retry can spend up to 30s in verification, 30s establishing the
// reconciliation block through Base RPC, 30s in regional preflight, 90s in
// settlement, and 30s starting the workload extension. Four minutes includes
// scheduling/ledger margin and prevents charging after the GameServer is gone.
export const X402_EXTENSION_ACTIVATION_SAFETY_MS = 240_000;

export function hasX402ExtensionActivationWindow(expiresAt: Date, now = Date.now()): boolean {
  return expiresAt.getTime() > now + X402_EXTENSION_ACTIVATION_SAFETY_MS;
}

export function deriveManagementToken(secret: string, sessionId: string): string {
  return `x402_${crypto.createHmac('sha256', secret).update(`popcorn:${sessionId}`).digest('base64url')}`;
}

export function encryptX402SettlementRequest(secret: string, value: unknown): string {
  const key = crypto.createHash('sha256').update(`popcorn:x402:settlement:${secret}`).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

export function decryptX402SettlementRequest<T>(secret: string, encrypted: string): T {
  const [ivValue, tagValue, payloadValue] = encrypted.split('.');
  if (!ivValue || !tagValue || !payloadValue) throw new Error('Invalid encrypted settlement request');
  const key = crypto.createHash('sha256').update(`popcorn:x402:settlement:${secret}`).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  const cleartext = Buffer.concat([
    decipher.update(Buffer.from(payloadValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(cleartext) as T;
}

export function selectTrustedClientAddress(
  forwardedFor: string | undefined,
  realIp: string | undefined,
  trustedProxyHops: number,
): string {
  if (trustedProxyHops <= 0) return 'direct';
  const chain = (forwardedFor || '').split(',').map((value) => value.trim()).filter(Boolean);
  const candidate = chain.length >= trustedProxyHops
    ? chain[chain.length - trustedProxyHops]
    : realIp?.trim();
  return candidate && candidate.length <= 128 ? candidate : 'unknown';
}

// Explicitly allow only restricted public endpoints on the configured gateway.
// Internal CDP/API/token fields are never copied, even if a pool manager adds
// new response fields later.
export function publicX402Endpoints(
  regional: Record<string, unknown>,
  publicGatewayUrl: string,
  sessionId: string,
): { liveViewUrl?: string; connectUrl?: string } {
  let expected: URL;
  try {
    expected = new URL(publicGatewayUrl);
  } catch {
    return {};
  }
  if (expected.protocol !== 'https:') return {};

  const allow = (value: unknown, protocol: 'https:' | 'wss:', permitQuery = false): URL | undefined => {
    if (typeof value !== 'string') return undefined;
    try {
      const parsed = new URL(value);
      return parsed.protocol === protocol && parsed.host === expected.host
        && !parsed.username && !parsed.password && (permitQuery || !parsed.search) && !parsed.hash
        ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  const live = allow(regional.url, 'https:', true);
  const connect = allow(regional.cdpUrl, 'wss:');
  const encodedSessionId = encodeURIComponent(sessionId);
  const liveSegments = live?.pathname.split('/').filter(Boolean) || [];
  const connectSegments = connect?.pathname.split('/').filter(Boolean) || [];
  const browserRoute = live && !live.search && liveSegments.length === 3
    && /^browser(?:-|$)/.test(liveSegments[0]!)
    && liveSegments[1] === encodedSessionId
    && !!liveSegments[2];
  const vncParams = live?.searchParams;
  const vncRoute = live && liveSegments.length === 4
    && liveSegments[0] === 'vnc'
    && liveSegments[1] === encodedSessionId
    && !!liveSegments[2]
    && liveSegments[3] === 'liveview.html'
    && vncParams?.size === 3
    && vncParams.get('resize') === 'scale'
    && vncParams.get('reconnect') === '1'
    && vncParams.get('reconnect_delay') === '2000';
  const liveViewUrl = browserRoute || vncRoute ? live?.toString() : undefined;
  const connectUrl = connect && connectSegments.length === 3
    && connectSegments[0] === 'cdp-agent'
    && connectSegments[1] === encodedSessionId
    && !!connectSegments[2]
    ? connect.toString() : undefined;
  return {
    ...(liveViewUrl ? { liveViewUrl } : {}),
    ...(connectUrl ? { connectUrl } : {}),
  };
}
