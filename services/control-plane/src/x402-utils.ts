import crypto from 'node:crypto';
import { isBase64UrlX25519PublicKey } from './liveview-e2e';

// The paid retry can spend up to 30s in verification, 30s establishing the
// reconciliation block through Base RPC, 30s in regional preflight, 90s in
// settlement, and 30s starting the workload extension. Four minutes includes
// scheduling/ledger margin and prevents charging after the GameServer is gone.
export const X402_EXTENSION_ACTIVATION_SAFETY_MS = 240_000;

export function hasX402ExtensionActivationWindow(expiresAt: Date, now = Date.now()): boolean {
  return expiresAt.getTime() > now + X402_EXTENSION_ACTIVATION_SAFETY_MS;
}

export function deriveSessionCapability(secret: string, sessionId: string): string {
  return `x402s_${crypto.createHmac('sha256', secret)
    .update(`popcorn:x402:session-capability:${sessionId}`)
    .digest('base64url')}`;
}

export function publicX402SessionUrl(publicBaseUrl: string, capability: string): string {
  return new URL(
    `/v1/x402/sessions/${encodeURIComponent(capability)}`,
    `${publicBaseUrl}/`,
  ).toString();
}

export function isOwnedPublicX402Session(
  session: {
    sessionId: string;
    clientId: string;
    region: string | null;
    clusterName: string;
  } | undefined,
  access: { sessionId: string } | undefined,
  expected: { clientId: string; region: string; clusterName: string },
): boolean {
  return !!session && !!access
    && access.sessionId === session.sessionId
    && session.clientId === expected.clientId
    && session.region === expected.region
    && session.clusterName === expected.clusterName;
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

export interface PublicX402Endpoints {
  liveViewUrl?: string;
  connectUrl?: string;
  vncUrl?: string;
  vncWsUrl?: string;
  liveViewE2e?: {
    version: 1;
    protocol: 'Noise_IK_25519_ChaChaPoly_SHA256';
    clientPublicKey: string;
    podPublicKey: string;
    podUid: string;
    e2eRfbUrl: string;
    e2eControlUrl: string;
  };
}

// Explicitly allow only restricted public endpoints on the configured gateway.
// Internal CDP/API/token fields are never copied, even if a pool manager adds
// new response fields later. Missing LiveView compatibility fields can be
// reconstructed from an older regional response during a rolling upgrade.
export function publicX402Endpoints(
  regional: Record<string, unknown>,
  publicGatewayUrl: string,
  sessionId: string,
): PublicX402Endpoints {
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
  const basePath = expected.pathname.replace(/\/+$/, '');
  const relativeSegments = (value: URL | undefined): string[] => {
    if (!value) return [];
    if (basePath && value.pathname !== basePath && !value.pathname.startsWith(`${basePath}/`)) return [];
    return value.pathname.slice(basePath.length).split('/').filter(Boolean);
  };
  const live = allow(regional.url, 'https:', true);
  const connect = allow(regional.cdpUrl, 'wss:');
  const providedVnc = allow(regional.vncUrl, 'https:', true);
  const providedVncWs = allow(regional.vncWsUrl, 'wss:');
  const e2e = regional.liveViewE2e;
  const encodedSessionId = encodeURIComponent(sessionId);
  const liveSegments = relativeSegments(live);
  const connectSegments = relativeSegments(connect);
  const browserRoute = live && !live.search && liveSegments.length === 3
    && /^browser(?:-|$)/.test(liveSegments[0]!)
    && liveSegments[1] === encodedSessionId
    && !!liveSegments[2];
  const vncParams = live?.searchParams;
  const liveViewRoute = live && liveSegments.length === 4
    && (liveSegments[0] === 'vnc' || liveSegments[0] === 'liveview')
    && liveSegments[1] === encodedSessionId
    && !!liveSegments[2]
    && liveSegments[3] === 'liveview.html'
    && vncParams?.size === 3
    && vncParams.get('resize') === 'scale'
    && vncParams.get('reconnect') === '1'
    && vncParams.get('reconnect_delay') === '2000';
  const liveViewUrl = browserRoute || liveViewRoute ? live?.toString() : undefined;
  const connectUrl = connect && connectSegments.length === 3
    && connectSegments[0] === 'cdp-agent'
    && connectSegments[1] === encodedSessionId
    && !!connectSegments[2]
    ? connect.toString() : undefined;

  const providedVncSegments = relativeSegments(providedVnc);
  const providedVncParams = providedVnc?.searchParams;
  const providedVncToken = providedVnc && providedVncSegments.length === 4
    && providedVncSegments[0] === 'liveview'
    && providedVncSegments[1] === encodedSessionId
    && !!providedVncSegments[2]
    && providedVncSegments[3] === 'liveview.html'
    && providedVncParams?.size === 3
    && providedVncParams.get('resize') === 'scale'
    && providedVncParams.get('reconnect') === '1'
    && providedVncParams.get('reconnect_delay') === '2000'
    ? providedVncSegments[2] : undefined;
  const fallbackToken = browserRoute || liveViewRoute ? liveSegments[2] : undefined;
  const restrictedToken = providedVncToken || fallbackToken;

  const gatewayBase = expected.href.replace(/\/+$/, '');
  const websocketGateway = new URL(expected.href);
  websocketGateway.protocol = 'wss:';
  const websocketBase = websocketGateway.href.replace(/\/+$/, '');
  const vncUrl = providedVncToken
    ? providedVnc!.toString()
    : restrictedToken
      ? `${gatewayBase}/liveview/${encodedSessionId}/${restrictedToken}/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000`
      : undefined;

  const providedVncWsSegments = relativeSegments(providedVncWs);
  const vncWsUrl = providedVncWs && restrictedToken
    && providedVncWsSegments.length === 3
    && providedVncWsSegments[0] === 'liveview-ws'
    && providedVncWsSegments[1] === encodedSessionId
    && providedVncWsSegments[2] === restrictedToken
    ? providedVncWs.toString()
    : restrictedToken
      ? `${websocketBase}/liveview-ws/${encodedSessionId}/${restrictedToken}`
      : undefined;
  const liveViewE2e = e2e && typeof e2e === 'object' && !Array.isArray(e2e)
    ? e2e as PublicX402Endpoints['liveViewE2e']
    : undefined;
  const validE2e = liveViewE2e?.version === 1
    && liveViewE2e.protocol === 'Noise_IK_25519_ChaChaPoly_SHA256'
    && isBase64UrlX25519PublicKey(liveViewE2e.clientPublicKey)
    && isBase64UrlX25519PublicKey(liveViewE2e.podPublicKey)
    && typeof liveViewE2e.podUid === 'string' && !!liveViewE2e.podUid
    && typeof liveViewE2e.e2eRfbUrl === 'string'
    && typeof liveViewE2e.e2eControlUrl === 'string'
    && (() => {
      const rfb = allow(liveViewE2e.e2eRfbUrl, 'wss:');
      const control = allow(liveViewE2e.e2eControlUrl, 'wss:');
      const rfbSegments = relativeSegments(rfb);
      const controlSegments = relativeSegments(control);
      return !!rfb && !!control && !!restrictedToken
        && rfbSegments.join('/') === `liveview-e2e-rfb/${encodedSessionId}/${restrictedToken}`
        && controlSegments.join('/') === `liveview-e2e-control/${encodedSessionId}/${restrictedToken}`;
    })();
  return {
    ...(liveViewUrl || vncUrl ? { liveViewUrl: liveViewUrl || vncUrl } : {}),
    ...(connectUrl ? { connectUrl } : {}),
    ...(vncUrl ? { vncUrl } : {}),
    ...(vncWsUrl ? { vncWsUrl } : {}),
    ...(validE2e ? { liveViewE2e } : {}),
  };
}
