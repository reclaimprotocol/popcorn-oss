export const LIVEVIEW_E2E_VERSION = 1;
export const LIVEVIEW_E2E_PROTOCOL = "Noise_IK_25519_ChaChaPoly_SHA256";
export const E2E_CLIENT_PUBLIC_KEY_ANNOTATION = "popcorn.dev/e2e-client-public-key";
export const E2E_BINDING_SECRET_HASH_ANNOTATION = "popcorn.dev/e2e-binding-secret-hash";
// Game containers can publish metadata only through the Agones SDK namespace.
export const E2E_POD_PUBLIC_KEY_ANNOTATION = "agones.dev/sdk-e2e-public-key";
export const E2E_POD_VERSION_ANNOTATION = "agones.dev/sdk-e2e-version";
export const E2E_VERSION_ANNOTATION = "popcorn.dev/e2e-version";

export interface LiveViewE2eRequest {
    version: 1;
    clientPublicKey?: string;
    bindingSecretHash?: string;
}

export interface LiveViewE2eBinding extends LiveViewE2eRequest {
    podPublicKey: string;
    podUid: string;
}

// A Noise static key is the raw 32-byte X25519 public key, represented without
// padding so it is safe in JSON and Kubernetes annotations. Do not accept a
// PEM, JWK, or arbitrary base64 spelling: canonical input prevents the same
// key from having multiple persisted identities.
export function isBase64UrlX25519PublicKey(value: unknown): value is string {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
    try {
        const decoded = Buffer.from(value, "base64url");
        return decoded.length === 32 && decoded.toString("base64url") === value;
    } catch {
        return false;
    }
}

export function readLiveViewE2eRequest(value: unknown): { value?: LiveViewE2eRequest; error?: string } {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { error: "liveViewE2e must be an object when provided" };
    }
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== LIVEVIEW_E2E_VERSION) {
        return { error: "liveViewE2e.version must be 1" };
    }
    const hasClientKey = candidate.clientPublicKey !== undefined;
    const hasBindingHash = candidate.bindingSecretHash !== undefined;
    if (hasClientKey === hasBindingHash) {
        return { error: "liveViewE2e must contain exactly one clientPublicKey or bindingSecretHash" };
    }
    if (hasClientKey && !isBase64UrlX25519PublicKey(candidate.clientPublicKey)) {
        return { error: "liveViewE2e.clientPublicKey must be a canonical base64url raw 32-byte X25519 public key" };
    }
    if (hasBindingHash && !isBase64UrlX25519PublicKey(candidate.bindingSecretHash)) {
        return { error: "liveViewE2e.bindingSecretHash must be a canonical base64url SHA-256 digest" };
    }
    return { value: {
        version: LIVEVIEW_E2E_VERSION,
        ...(hasClientKey ? { clientPublicKey: candidate.clientPublicKey as string } : {}),
        ...(hasBindingHash ? { bindingSecretHash: candidate.bindingSecretHash as string } : {}),
    } };
}
