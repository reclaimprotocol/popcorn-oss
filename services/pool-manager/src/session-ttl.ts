export const DEFAULT_ROUTE_TTL_SECONDS = 3600 * 24;

export function normalizeExpiresAt(rawExpiresAt: unknown): string | undefined {
    if (typeof rawExpiresAt !== "string" || !rawExpiresAt.trim()) {
        return undefined;
    }
    const timestamp = Date.parse(rawExpiresAt);
    if (!Number.isFinite(timestamp)) {
        return undefined;
    }
    return new Date(timestamp).toISOString();
}

export function routeTtlSeconds(expiresAt?: string, now = Date.now()): number {
    if (!expiresAt) {
        return DEFAULT_ROUTE_TTL_SECONDS;
    }
    return Math.max(1, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}
