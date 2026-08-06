import { normalizeExpiresAt } from "./session-ttl";

export type SessionTokenMode = "expiring" | "route-bound";
export type SessionCdpScope = "restricted" | "automation";

export interface SessionAccessPolicy {
    tokenMode: SessionTokenMode;
    cdpScope: SessionCdpScope;
    accessExpiresAt?: string;
}

export interface SessionAccessRequest {
    tokenExpiresAt?: string;
    accessPolicy?: SessionAccessPolicy;
}

export interface SessionAccessRequestResult {
    value?: SessionAccessRequest;
    error?: string;
}

const DEFAULT_ACCESS_POLICY: SessionAccessPolicy = {
    tokenMode: "expiring",
    cdpScope: "restricted",
};

export function readSessionAccessRequest(body: any, sessionExpiresAt?: string): SessionAccessRequestResult {
    const retiredFields = ["restrictedTokenExpiresAt", "automationProfile", "publicAccessExpiresAt"]
        .filter((field) => body?.[field] !== undefined);
    if (retiredFields.length) {
        return { error: `Unsupported session access fields: ${retiredFields.join(", ")}` };
    }

    const tokenExpiresAt = body?.tokenExpiresAt === undefined
        ? undefined
        : normalizeExpiresAt(body.tokenExpiresAt);

    if (body?.tokenExpiresAt !== undefined && !tokenExpiresAt) {
        return { error: "Invalid tokenExpiresAt" };
    }

    let policy: SessionAccessPolicy | undefined;
    if (body?.accessPolicy !== undefined) {
        if (!body.accessPolicy || typeof body.accessPolicy !== "object" || Array.isArray(body.accessPolicy)) {
            return { error: "Invalid accessPolicy" };
        }
        const tokenMode = body.accessPolicy.tokenMode;
        const cdpScope = body.accessPolicy.cdpScope;
        if ((tokenMode !== "expiring" && tokenMode !== "route-bound")
            || (cdpScope !== "restricted" && cdpScope !== "automation")) {
            return { error: "Invalid accessPolicy" };
        }
        const accessExpiresAt = body.accessPolicy.accessExpiresAt === undefined
            ? undefined
            : normalizeExpiresAt(body.accessPolicy.accessExpiresAt);
        if (body.accessPolicy.accessExpiresAt !== undefined && !accessExpiresAt) {
            return { error: "Invalid accessPolicy.accessExpiresAt" };
        }
        if (tokenMode === "route-bound" && !accessExpiresAt) {
            return { error: "Route-bound accessPolicy requires accessExpiresAt" };
        }
        if (tokenMode === "expiring" && accessExpiresAt) {
            return { error: "Expiring accessPolicy cannot set accessExpiresAt" };
        }
        if (accessExpiresAt && sessionExpiresAt
            && Date.parse(accessExpiresAt) > Date.parse(sessionExpiresAt)) {
            return { error: "accessPolicy.accessExpiresAt cannot exceed expiresAt" };
        }
        policy = { tokenMode, cdpScope, ...(accessExpiresAt ? { accessExpiresAt } : {}) };
    }

    return {
        value: {
            tokenExpiresAt,
            accessPolicy: policy || { ...DEFAULT_ACCESS_POLICY },
        },
    };
}

export function storedSessionAccess(session: any): SessionAccessPolicy {
    const storedPolicy = session?.accessPolicy;
    const tokenMode = storedPolicy?.tokenMode === "route-bound" || storedPolicy?.tokenMode === "expiring"
        ? storedPolicy.tokenMode
        : "expiring";
    const cdpScope = storedPolicy?.cdpScope === "automation" || storedPolicy?.cdpScope === "restricted"
        ? storedPolicy.cdpScope
        : "restricted";
    const accessExpiresAt = normalizeExpiresAt(session?.accessExpiresAt)
        || normalizeExpiresAt(storedPolicy?.accessExpiresAt);
    return {
        tokenMode,
        cdpScope,
        ...(accessExpiresAt ? { accessExpiresAt } : {}),
    };
}

export function storedSessionTokenExpiresAt(session: any): string | undefined {
    return normalizeExpiresAt(session?.tokenExpiresAt)
        || normalizeExpiresAt(session?.expiresAt);
}

export function sessionAccessFields(
    tokenExpiresAt: string | undefined,
    accessPolicy: SessionAccessPolicy,
): Record<string, unknown> {
    return {
        ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
        accessPolicy,
        ...(accessPolicy.accessExpiresAt
            ? { accessExpiresAt: accessPolicy.accessExpiresAt }
            : {}),
    };
}
