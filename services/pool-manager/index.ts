import { Hono } from "hono";
import { timingSafeEqual } from "crypto";
import { DB } from "./src/services/db";
import { Agones } from "./src/services/agones";
import { Auth } from "./src/services/auth";
import { ClickHouse } from "./src/services/clickhouse";
import { buildMetadataAnnotationsPatch, K8s } from "./src/services/k8s";
import { RuntimeConfig } from "./src/config";
import { normalizeExpiresAt } from "./src/session-ttl";
import { OtelEvents } from "./src/services/otel";
import { retry } from "./src/services/retry";
import { buildSessionMetadata } from "./src/session-metadata";
import { browserRoutePort } from "./src/allocation-port";
import {
    readSessionAccessRequest,
    sessionAccessFields,
    storedSessionAccess,
    storedSessionTokenExpiresAt,
    type SessionAccessPolicy,
} from "./src/session-access";
import { buildSessionUrls, websocketBaseUrl } from "./src/session-urls";
import { closeProxyCdpSession, presetExtensionProxy } from "./src/extension-proxy";
import { proxyPreset, readSessionProxy, type SessionProxy } from "./src/session-proxy";

const app = new Hono();
const PORT = 3000;

const CLUSTER_NAME = process.env.CLUSTER_NAME || "unknown";
const GAME_SERVER_NAMESPACE = RuntimeConfig.gameServerNamespace;
const GAME_SERVER_FLEET = RuntimeConfig.gameServerFleet;
const POPCORN_REGION = process.env.POPCORN_REGION || "unknown";
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_METADATA_PATCH_ATTEMPTS = 3;
const SESSION_METADATA_PATCH_DELAY_MS = 250;
const POOL_MANAGER_SERVICE_AUTH_TOKEN = requireEnv("POOL_MANAGER_SERVICE_AUTH_TOKEN");
const EXTRA_SESSION_URLS = readExtraSessionUrls(process.env.POOL_MANAGER_SESSION_EXTENSION_URLS);
const ANNOTATION_SESSION_EXPIRES_AT = "popcorn.dev/expires-at";

interface ClientIdentity {
    clientId: string;
    clientName: string;
}

class DuplicateSessionIdError extends Error {
    constructor() {
        super("Session ID already exists");
        this.name = "DuplicateSessionIdError";
    }
}

class SessionTelemetryAnnotationError extends Error {
    constructor(namespace: string, podName: string, cause: unknown) {
        super(`Failed to annotate Pod ${namespace}/${podName} with session metadata; refusing allocation because session log correlation would be unavailable`);
        this.name = "SessionTelemetryAnnotationError";
        this.cause = cause;
    }
}

function getBearerCredential(c: any): string | null {
    const header = c.req.header("Authorization");
    if (!header) return null;

    const match = header.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || null;
}

function isControlPlaneRequest(c: any): boolean {
    const credential = getBearerCredential(c);
    return constantTimeEqual(credential || undefined, POOL_MANAGER_SERVICE_AUTH_TOKEN);
}

function constantTimeEqual(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) return false;
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

function requireControlPlane(c: any): Response | null {
    if (isControlPlaneRequest(c)) {
        return null;
    }
    return c.json({ error: "Unauthorized" }, 401);
}

function requireEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function isValidSessionId(sessionId: string): boolean {
    return SESSION_ID_PATTERN.test(sessionId);
}

function requestBaseUrl(c: any): string {
    const host = c.req.header("Host") || "localhost";
    const protocol = c.req.header("X-Forwarded-Proto") || "http";
    return `${protocol}://${host}`;
}

function normalizeBaseUrl(rawBaseUrl: string | undefined | null): string | null {
    if (!rawBaseUrl || typeof rawBaseUrl !== "string") {
        return null;
    }
    try {
        const parsed = new URL(rawBaseUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return null;
        }
        return parsed.href.replace(/\/+$/, "");
    } catch {
        return null;
    }
}

function readExtraSessionUrls(raw: string | undefined): Record<string, string> {
    if (!raw?.trim()) {
        return {};
    }

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            console.warn("Ignoring POOL_MANAGER_SESSION_EXTENSION_URLS because it is not a JSON object");
            return {};
        }

        return Object.fromEntries(
            Object.entries(parsed).filter((entry): entry is [string, string] => {
                const [key, value] = entry;
                return /^[A-Za-z][A-Za-z0-9_]*$/.test(key) && typeof value === "string";
            })
        );
    } catch (e) {
        console.warn("Ignoring POOL_MANAGER_SESSION_EXTENSION_URLS because it is invalid JSON:", e);
        return {};
    }
}

function expandSessionUrlTemplate(template: string, values: Record<string, string>): string {
    return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key) => values[key] ?? match);
}

async function annotatePodWithSessionMetadata(namespace: string, podName: string, sessionId: string) {
    let metadata = buildSessionMetadata(sessionId);
    try {
        await retry(async () => {
            metadata = buildSessionMetadata(sessionId);
            await K8s.patchPod(
                namespace,
                podName,
                buildMetadataAnnotationsPatch(metadata.annotations),
            );
        }, {
            attempts: SESSION_METADATA_PATCH_ATTEMPTS,
            delayMs: SESSION_METADATA_PATCH_DELAY_MS,
        });
    } catch (error) {
        throw new SessionTelemetryAnnotationError(namespace, podName, error);
    }
    return metadata;
}

function buildSessionDetails(c: any, sessionId: string, session: any, publicBaseUrl?: string | null) {
    const baseUrl = publicBaseUrl || requestBaseUrl(c);
    const wsBase = websocketBaseUrl(baseUrl);
    const accessPolicy = storedSessionAccess(session);
    const tokenExpiresAt = storedSessionTokenExpiresAt(session);
    const routeBound = accessPolicy.tokenMode === "route-bound";
    const token = Auth.signToken(
        sessionId,
        'restricted',
        tokenExpiresAt,
        routeBound,
    );
    const automationToken = accessPolicy.cdpScope === "automation"
        ? Auth.signToken(
            sessionId,
            'automation',
            tokenExpiresAt,
            routeBound,
        )
        : null;
    const internalToken = Auth.signToken(sessionId, 'internal', session.expiresAt);

    const details: Record<string, unknown> = {
        success: true,
        sessionId,
        ...buildSessionUrls({
            baseUrl,
            browserPodId: session.name,
            sessionId,
            restrictedToken: token,
            automationToken,
            internalToken,
        }),
        browserPodId: session.name,
        allocationRequestedAt: session.allocationRequestedAt,
        gameServerAllocatedAt: session.gameServerAllocatedAt,
        gameServerAllocationLatencyMs: session.gameServerAllocationLatencyMs,
        boundAt: session.boundAt,
    };

    if (session.expiresAt) {
        details.expiresAt = session.expiresAt;
    }

    const templateValues = {
        baseUrl,
        wsBase,
        sessionId,
        browserPodId: session.name,
        restrictedToken: token,
        internalToken,
    };

    for (const [key, template] of Object.entries(EXTRA_SESSION_URLS)) {
        // LiveView is part of the core session contract. Deployment-specific
        // URL templates may add fields or override legacy aliases, but cannot
        // remove or replace these canonical endpoints.
        if (key === "vncUrl" || key === "vncWsUrl") continue;
        details[key] = expandSessionUrlTemplate(template, templateValues);
    }

    return details;
}

async function allocateSessionLocally(
    identity: ClientIdentity,
    requestedSessionId?: string,
    expiresAt?: string,
    tokenExpiresAt?: string,
    accessPolicy: SessionAccessPolicy = { tokenMode: "expiring", cdpScope: "restricted" },
    proxy: SessionProxy = null,
) {
    const allocationRequestedAt = new Date();
    if (requestedSessionId && !isValidSessionId(requestedSessionId)) {
        throw new Error("INVALID_SESSION_ID");
    }

    const sessionId = requestedSessionId || crypto.randomUUID().slice(0, 8);
    let allocatedGameServerName: string | null = null;
    let sessionCreated = false;

    if (requestedSessionId) {
        const duplicate = await DB.sessionExists(sessionId);
        if (duplicate) {
            throw new DuplicateSessionIdError();
        }
    }

    console.log(`🚀 Allocation request for session: ${sessionId} (client: ${identity.clientId})`);

    try {
        const allocation = await Agones.allocate(GAME_SERVER_NAMESPACE, GAME_SERVER_FLEET, sessionId);
        const gameServerAllocatedAt = new Date();
        allocatedGameServerName = allocation.gameServerName;
        const port = browserRoutePort(allocation.ports);
        const podUrl = `http://${allocation.address}:${port}`;

        const podMetadata = await K8s.getPodMetadata(allocation.gameServerName, GAME_SERVER_NAMESPACE);
        const bound = await annotatePodWithSessionMetadata(podMetadata.namespace, allocation.gameServerName, sessionId);

        const podData = {
            name: allocation.gameServerName,
            namespace: GAME_SERVER_NAMESPACE,
            url: podUrl,
            ports: allocation.ports,
            podUid: podMetadata.uid || undefined,
            allocationRequestedAt: allocationRequestedAt.toISOString(),
            gameServerAllocatedAt: gameServerAllocatedAt.toISOString(),
            gameServerAllocationLatencyMs: Math.max(0, gameServerAllocatedAt.getTime() - allocationRequestedAt.getTime()),
            boundAt: bound.boundAt,
            clientId: identity.clientId,
            clientName: identity.clientName,
            createdAt: Date.now(),
            ...(expiresAt ? { expiresAt } : {}),
            ...sessionAccessFields(tokenExpiresAt, accessPolicy),
        };

        if (proxy) {
            const preset = proxyPreset(proxy.country, sessionId);
            if ("error" in preset) throw new Error(preset.error);
            await presetExtensionProxy(sessionId, allocation.address, preset.value);
        }

        const sessionAnnotations = {
            ...bound.annotations,
            ...(expiresAt ? { [ANNOTATION_SESSION_EXPIRES_AT]: expiresAt } : {}),
        };

        try {
            await K8s.patchGameServer(GAME_SERVER_NAMESPACE, allocation.gameServerName, {
                metadata: {
                    annotations: sessionAnnotations,
                }
            });
        } catch (e) {
            console.error(`❌ Failed to annotate GameServer with session metadata:`, e);
            if (expiresAt) {
                throw e;
            }
        }

        const created = await DB.createSession(sessionId, podData);
        if (!created) {
            throw new DuplicateSessionIdError();
        }
        sessionCreated = true;

        OtelEvents.sessionStart({
            sessionId,
            clusterName: CLUSTER_NAME,
            namespace: podMetadata.namespace,
            podName: allocation.gameServerName,
            podUid: podMetadata.uid,
            at: bound.boundAt,
            region: POPCORN_REGION,
        }).catch((error) => {
            console.error("❌ Failed to emit session.start OTEL event:", error);
        });

        if (podMetadata.uid) {
            ClickHouse.createSessionBinding({
                sessionId,
                clusterName: CLUSTER_NAME,
                namespace: podMetadata.namespace,
                podName: allocation.gameServerName,
                podUid: podMetadata.uid,
                boundAt: bound.boundAt,
            }).catch((error) => {
                console.error("❌ Failed to write session binding to ClickHouse:", error);
            });
        } else {
            console.warn(`⚠️ Pod UID missing for ${allocation.gameServerName}; skipping session binding insert`);
        }

        return { sessionId, podData };
    } catch (e) {
        closeProxyCdpSession(sessionId);
        if (allocatedGameServerName) {
            if (sessionCreated) {
                try {
                    await DB.deleteSession(sessionId);
                } catch (cleanupError) {
                    console.error(`Failed to clean up session state for ${sessionId}:`, cleanupError);
                }
            }

            try {
                await Agones.shutdownGameServer(allocatedGameServerName, GAME_SERVER_NAMESPACE);
            } catch (shutdownError) {
                console.error(`Failed to shutdown allocated GameServer ${allocatedGameServerName}:`, shutdownError);
            }
        }
        throw e;
    }
}

function allocationErrorResponse(c: any, e: unknown): Response {
    if ((e as Error).message === "INVALID_SESSION_ID") {
        return c.json({ error: "Invalid session ID. Use 1-64 chars in [A-Za-z0-9_-]." }, 400);
    }

    if (e instanceof DuplicateSessionIdError) {
        return c.json({ error: e.message }, 409);
    }

    if (e instanceof SessionTelemetryAnnotationError) {
        console.error("Failed to allocate session with required telemetry correlation:", e);
        return c.json({ error: "Failed to allocate browser instance with session log correlation" }, 503);
    }

    console.error("Failed to allocate session:", e);
    return c.json({ error: "Failed to allocate browser instance" }, 503);
}

async function createControlPlaneSession(c: any): Promise<Response> {
    try {
        const body = await c.req.json();
        const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
        const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
        const clientName = typeof body?.clientName === "string" ? body.clientName.trim() : "";
        const publicBaseUrl = normalizeBaseUrl(body?.publicGatewayUrl);
        const expiresAt = normalizeExpiresAt(body?.expiresAt);
        const access = readSessionAccessRequest(body, expiresAt);

        if (!sessionId || !clientId || !clientName || !publicBaseUrl) {
            return c.json({ error: "Missing sessionId, clientId, clientName, or valid publicGatewayUrl" }, 400);
        }

        if (body?.expiresAt && !expiresAt) {
            return c.json({ error: "Invalid expiresAt" }, 400);
        }

        if (access.error || !access.value?.accessPolicy) {
            return c.json({ error: access.error || "Invalid session access policy" }, 400);
        }
        const proxy = readSessionProxy(body);
        if ("error" in proxy) return c.json({ error: proxy.error }, 400);

        if (expiresAt && access.value.tokenExpiresAt
            && Date.parse(access.value.tokenExpiresAt) < Date.parse(expiresAt)) {
            return c.json({ error: "tokenExpiresAt cannot precede expiresAt" }, 400);
        }

        const allocation = await allocateSessionLocally(
            { clientId, clientName },
            sessionId,
            expiresAt,
            access.value.tokenExpiresAt,
            access.value.accessPolicy,
            proxy.value,
        );
        return c.json(buildSessionDetails(c, allocation.sessionId, allocation.podData, publicBaseUrl));
    } catch (e) {
        return allocationErrorResponse(c, e);
    }
}

async function extendLocalSessionTtl(c: any, sessionId: string): Promise<Response> {
    try {
        const body = await c.req.json();
        const expiresAt = normalizeExpiresAt(body?.expiresAt);
        if (!expiresAt) {
            return c.json({ success: false, error: "Missing or invalid expiresAt" }, 400);
        }

        const session = await DB.getSession(sessionId);
        if (!session) {
            return c.json({ success: false, error: "Session not found" }, 404);
        }

        if (!session.name) {
            return c.json({ success: false, error: "Session has no GameServer name" }, 409);
        }

        const currentAccessPolicy = storedSessionAccess(session);
        const updatedAccessPolicy = currentAccessPolicy.tokenMode === "route-bound"
            ? {
                ...currentAccessPolicy,
                accessExpiresAt: currentAccessPolicy.accessExpiresAt || session.expiresAt,
            }
            : currentAccessPolicy;
        const updatedSession = {
            ...session,
            expiresAt,
            ...sessionAccessFields(expiresAt, updatedAccessPolicy),
        };
        await DB.updateSession(sessionId, updatedSession);

        // Refresh Redis/session state before extending Kubernetes cleanup. If Redis
        // fails, the GameServer still expires at the previous annotation.
        try {
            await K8s.patchGameServer(session.namespace || GAME_SERVER_NAMESPACE, session.name, {
                metadata: {
                    annotations: {
                        [ANNOTATION_SESSION_EXPIRES_AT]: expiresAt,
                    },
                },
            });
        } catch (error) {
            await DB.updateSession(sessionId, session);
            throw error;
        }

        return c.json(buildSessionDetails(c, sessionId, updatedSession, normalizeBaseUrl(c.req.query("publicGatewayUrl"))));
    } catch (error) {
        console.error("❌ Failed to extend session TTL:", error);
        return c.json({ success: false, error: "Failed to extend session TTL" }, 502);
    }
}

async function activateLocalSessionAccess(c: any, sessionId: string): Promise<Response> {
    try {
        const body = await c.req.json();
        const expiresAt = normalizeExpiresAt(body?.expiresAt);
        if (!expiresAt) {
            return c.json({ success: false, error: "Missing or invalid expiresAt" }, 400);
        }

        const session = await DB.getSession(sessionId);
        if (!session) {
            return c.json({ success: false, error: "Session not found" }, 404);
        }
        const currentAccessPolicy = storedSessionAccess(session);
        if (currentAccessPolicy.tokenMode !== "route-bound") {
            return c.json({ success: false, error: "Session does not use route-bound access" }, 409);
        }
        if (!session.expiresAt || Date.parse(expiresAt) !== Date.parse(session.expiresAt)) {
            return c.json({ success: false, error: "Access deadline must match the active session deadline" }, 409);
        }

        const updatedSession = {
            ...session,
            ...sessionAccessFields(
                storedSessionTokenExpiresAt(session),
                { ...currentAccessPolicy, accessExpiresAt: expiresAt },
            ),
        };
        await DB.updateSession(sessionId, updatedSession);
        return c.json(buildSessionDetails(
            c,
            sessionId,
            updatedSession,
            normalizeBaseUrl(c.req.query("publicGatewayUrl")),
        ));
    } catch (error) {
        console.error("❌ Failed to activate session access:", error);
        return c.json({ success: false, error: "Failed to activate session access" }, 502);
    }
}

async function reallocateExpiredSession(c: any, sessionId: string): Promise<Response> {
    try {
        const body = await c.req.json();
        const expiresAt = normalizeExpiresAt(body?.expiresAt);
        const publicBaseUrl = normalizeBaseUrl(body?.publicGatewayUrl);
        if (!expiresAt || !publicBaseUrl || Date.parse(expiresAt) <= Date.now()) {
            return c.json({ success: false, error: "Missing or invalid future expiresAt/publicGatewayUrl" }, 400);
        }

        const existing = await DB.getSession(sessionId);
        if (body?.accessPolicy === undefined) {
            return c.json({ success: false, error: "Missing accessPolicy" }, 400);
        }
        const access = readSessionAccessRequest(body, expiresAt);
        if (access.error || !access.value?.accessPolicy) {
            return c.json({ success: false, error: access.error || "Invalid session access policy" }, 400);
        }
        const proxy = readSessionProxy(body);
        if ("error" in proxy) return c.json({ success: false, error: proxy.error }, 400);

        const clientId = typeof body?.clientId === "string" && body.clientId.trim()
            ? body.clientId.trim()
            : existing?.clientId || "";
        const clientName = typeof body?.clientName === "string" && body.clientName.trim()
            ? body.clientName.trim()
            : existing?.clientName || "";
        if (!clientId || !clientName) {
            return c.json({ success: false, error: "Missing clientId or clientName" }, 400);
        }

        if (existing) {
            if (existing.expiresAt && Date.parse(existing.expiresAt) > Date.now()) {
                // Idempotent reconciliation after a caller timeout: the
                // replacement may have completed even when its response did not.
                return c.json(buildSessionDetails(c, sessionId, existing, publicBaseUrl));
            }
            // The TTL controller has already made the old GameServer unusable.
            // Clear stale routing/session metadata before allocating a new pod
            // under the same public session ID and deterministic URL tokens.
            await DB.deleteSession(sessionId);
        }

        const allocation = await allocateSessionLocally(
            { clientId, clientName },
            sessionId,
            expiresAt,
            access.value.tokenExpiresAt,
            access.value.accessPolicy,
            proxy.value,
        );
        return c.json(buildSessionDetails(c, allocation.sessionId, allocation.podData, publicBaseUrl));
    } catch (error) {
        console.error("❌ Failed to reallocate expired session:", error);
        return allocationErrorResponse(c, error);
    }
}

async function getSessionDetails(c: any, sessionId: string, publicBaseUrl?: string | null): Promise<Response> {
    const session = await DB.getSession(sessionId);

    if (!session) {
        return c.json({ success: false, error: "Session not found" }, 404);
    }

    return c.json(buildSessionDetails(c, sessionId, session, publicBaseUrl));
}

// Best-effort read of the pod's viewer RTT aggregate (proxy GET /rtstats).
// Must run before the GameServer shutdown — the aggregate lives only in pod
// memory. Short timeout so telemetry never slows a kill.
async function fetchViewerRttSummary(podUrl: string, sessionId: string): Promise<Record<string, unknown> | null> {
    try {
        const res = await fetch(`${podUrl}/rtstats?sid=${encodeURIComponent(sessionId)}`, {
            signal: AbortSignal.timeout(1500),
        });
        if (!res.ok) return null;
        const body = await res.json();
        if (!body || typeof body !== "object" || Array.isArray(body)) return null;
        return Number((body as Record<string, unknown>).sampleCount) >= 1 ? body as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

async function deleteLocalSession(sessionId: string) {
    const session = await DB.getSession(sessionId);

    if (!session) {
        return { deleted: false, notFound: true, session: null, viewerRtt: null };
    }

    // Killed sessions never reach TTL expiry, so capture the RTT aggregate here
    // and ride it back on the DELETE response for the control plane to record.
    const viewerRtt = session.url ? await fetchViewerRttSummary(session.url, sessionId) : null;

    const namespace = session.namespace || GAME_SERVER_NAMESPACE;
    const endedAt = new Date().toISOString();
    let podUid = session.podUid || null;

    if (session.name && !podUid) {
        const podMetadata = await K8s.getPodMetadata(session.name, namespace);
        podUid = podMetadata.uid;
    }

    // Stop holding a privileged CDP connection even if workload shutdown fails.
    closeProxyCdpSession(sessionId);

    if (session.name) {
        await Agones.shutdownGameServer(session.name, namespace);
    }

    await DB.deleteSession(sessionId);
    OtelEvents.sessionEnd({
        sessionId,
        clusterName: CLUSTER_NAME,
        namespace,
        podName: session.name,
        podUid,
        at: endedAt,
        region: POPCORN_REGION,
    }).catch((error) => {
        console.error("❌ Failed to emit session.end OTEL event:", error);
    });

    return { deleted: true, notFound: false, session, viewerRtt };
}

async function listServerStatuses() {
    const gameServers = await Agones.listGameServers(GAME_SERVER_NAMESPACE);
    const stats = await DB.getStats();

    const podToSession = new Map<string, string>();
    for (const [sid, raw] of Object.entries(stats.activeSessions)) {
        try {
            const data = JSON.parse(raw as string);
            if (data.name) {
                podToSession.set(data.name, sid);
            }
        } catch (e) { }
    }

    return gameServers.map((gs: any) => ({
        name: gs.name,
        status: gs.state || gs.status,
        sessionId: podToSession.get(gs.name) || null
    }));
}

app.get("/internal/servers", async (c) => {
    const unauthorized = requireControlPlane(c);
    if (unauthorized) return unauthorized;
    return c.json(await listServerStatuses());
});

app.post("/internal/sessions", async (c) => {
    const unauthorized = requireControlPlane(c);
    if (unauthorized) return unauthorized;
    return createControlPlaneSession(c);
});

app.get("/internal/session/:id", async (c) => {
    const unauthorized = requireControlPlane(c);
    if (unauthorized) return unauthorized;
    return getSessionDetails(c, c.req.param("id"), normalizeBaseUrl(c.req.query("publicGatewayUrl")));
});

app.patch("/internal/session/:id/ttl", async (c) => {
    const unauthorized = requireControlPlane(c);
    if (unauthorized) return unauthorized;
    return extendLocalSessionTtl(c, c.req.param("id"));
});

app.patch("/internal/session/:id/access-ttl", async (c) => {
    const unauthorized = requireControlPlane(c);
    if (unauthorized) return unauthorized;
    return activateLocalSessionAccess(c, c.req.param("id"));
});

app.post("/internal/session/:id/reallocate-expired", async (c) => {
    const unauthorized = requireControlPlane(c);
    if (unauthorized) return unauthorized;
    return reallocateExpiredSession(c, c.req.param("id"));
});

app.delete("/internal/session/:id", async (c) => {
    const unauthorized = requireControlPlane(c);
    if (unauthorized) return unauthorized;
    try {
        const result = await deleteLocalSession(c.req.param("id"));
        if (result.notFound) {
            return c.json({ success: false, error: "Session not found" }, 404);
        }
        return c.json({
            success: true,
            deleted: result.deleted,
            ...(result.viewerRtt ? { viewerRtt: result.viewerRtt } : {}),
        }, 200);
    } catch (error) {
        console.error("❌ Failed to delete session:", error);
        return c.json({ success: false, error: "Failed to delete session" }, 502);
    }
});

// GET /health
app.get("/health", (c) => c.text("OK"));

export default {
    port: PORT,
    fetch: app.fetch,
};
