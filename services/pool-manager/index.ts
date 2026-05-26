import { Hono } from "hono";
import { timingSafeEqual } from "crypto";
import { DB } from "./src/services/db";
import { Agones } from "./src/services/agones";
import { Auth } from "./src/services/auth";
import { ClickHouse } from "./src/services/clickhouse";
import { K8s } from "./src/services/k8s";
import { RuntimeConfig } from "./src/config";
import { normalizeExpiresAt } from "./src/session-ttl";

const app = new Hono();
const PORT = 3000;

const CLUSTER_NAME = process.env.CLUSTER_NAME || "unknown";
const GAME_SERVER_NAMESPACE = RuntimeConfig.gameServerNamespace;
const GAME_SERVER_FLEET = RuntimeConfig.gameServerFleet;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const POOL_MANAGER_SERVICE_AUTH_TOKEN = requireEnv("POOL_MANAGER_SERVICE_AUTH_TOKEN");
const EXTRA_SESSION_URLS = readExtraSessionUrls(process.env.POOL_MANAGER_EXTRA_SESSION_URLS);
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
            console.warn("Ignoring POOL_MANAGER_EXTRA_SESSION_URLS because it is not a JSON object");
            return {};
        }

        return Object.fromEntries(
            Object.entries(parsed).filter((entry): entry is [string, string] => {
                const [key, value] = entry;
                return /^[A-Za-z][A-Za-z0-9_]*$/.test(key) && typeof value === "string";
            })
        );
    } catch (e) {
        console.warn("Ignoring POOL_MANAGER_EXTRA_SESSION_URLS because it is invalid JSON:", e);
        return {};
    }
}

function expandSessionUrlTemplate(template: string, values: Record<string, string>): string {
    return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key) => values[key] ?? match);
}

function buildSessionDetails(c: any, sessionId: string, session: any, publicBaseUrl?: string | null) {
    const baseUrl = publicBaseUrl || requestBaseUrl(c);
    const parsedBase = new URL(baseUrl);
    const wsBase = `${parsedBase.protocol === "https:" ? "wss:" : "ws:"}//${parsedBase.host}`;
    const token = Auth.signToken(sessionId, 'restricted', session.expiresAt);
    const internalToken = Auth.signToken(sessionId, 'internal', session.expiresAt);

    const details: Record<string, unknown> = {
        success: true,
        sessionId,
        url: `${baseUrl}/${session.name}/${sessionId}/${token}/`,
        cdpUrl: `${wsBase}/cdp/${sessionId}/${token}/`,
        cdpInternalUrl: `${wsBase}/cdp-internal/${sessionId}/${internalToken}/`,
        apiUrl: `${baseUrl}/api/${sessionId}/${internalToken}/`,
        browserPodId: session.name
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
        details[key] = expandSessionUrlTemplate(template, templateValues);
    }

    return details;
}

async function allocateSessionLocally(identity: ClientIdentity, requestedSessionId?: string, expiresAt?: string) {
    if (requestedSessionId && !isValidSessionId(requestedSessionId)) {
        throw new Error("INVALID_SESSION_ID");
    }

    const sessionId = requestedSessionId || crypto.randomUUID().slice(0, 8);
    let allocatedGameServerName: string | null = null;

    if (requestedSessionId) {
        const duplicate = await DB.sessionExists(sessionId);
        if (duplicate) {
            throw new DuplicateSessionIdError();
        }
    }

    console.log(`🚀 Allocation request for session: ${sessionId} (client: ${identity.clientId})`);

    try {
        const allocation = await Agones.allocate(GAME_SERVER_NAMESPACE, GAME_SERVER_FLEET, sessionId);
        allocatedGameServerName = allocation.gameServerName;
        const port = allocation.ports?.[0]?.port || 8080;
        const podUrl = `http://${allocation.address}:${port}`;

        const podData = {
            name: allocation.gameServerName,
            namespace: GAME_SERVER_NAMESPACE,
            url: podUrl,
            ports: allocation.ports,
            clientId: identity.clientId,
            createdAt: Date.now(),
            ...(expiresAt ? { expiresAt } : {}),
        };

        const created = await DB.createSession(sessionId, podData);
        if (!created) {
            throw new DuplicateSessionIdError();
        }

        const boundAt = new Date().toISOString();
        const podMetadata = await K8s.getPodMetadata(allocation.gameServerName, GAME_SERVER_NAMESPACE);
        const sessionAnnotations = {
            "popcorn.dev/session-id": sessionId,
            "popcorn.dev/session-bound-at": boundAt,
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

        if (podMetadata.uid) {
            ClickHouse.createSessionBinding({
                sessionId,
                clusterName: CLUSTER_NAME,
                namespace: podMetadata.namespace,
                podName: allocation.gameServerName,
                podUid: podMetadata.uid,
                boundAt,
            }).catch((error) => {
                console.error("❌ Failed to write session binding to ClickHouse:", error);
            });
        } else {
            console.warn(`⚠️ Pod UID missing for ${allocation.gameServerName}; skipping session binding insert`);
        }

        return { sessionId, podData };
    } catch (e) {
        if (allocatedGameServerName) {
            try {
                await DB.deleteSession(sessionId);
            } catch (cleanupError) {
                console.error(`Failed to clean up session state for ${sessionId}:`, cleanupError);
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

        if (!sessionId || !clientId || !clientName || !publicBaseUrl) {
            return c.json({ error: "Missing sessionId, clientId, clientName, or valid publicGatewayUrl" }, 400);
        }

        if (body?.expiresAt && !expiresAt) {
            return c.json({ error: "Invalid expiresAt" }, 400);
        }

        const allocation = await allocateSessionLocally({ clientId, clientName }, sessionId, expiresAt);
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

        const updatedSession = {
            ...session,
            expiresAt,
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

async function getSessionDetails(c: any, sessionId: string, publicBaseUrl?: string | null): Promise<Response> {
    const session = await DB.getSession(sessionId);

    if (!session) {
        return c.json({ success: false, error: "Session not found" }, 404);
    }

    return c.json(buildSessionDetails(c, sessionId, session, publicBaseUrl));
}

async function deleteLocalSession(sessionId: string) {
    const session = await DB.getSession(sessionId);

    if (!session) {
        return { deleted: false, notFound: true, session: null };
    }

    if (session.name) {
        await Agones.shutdownGameServer(session.name, session.namespace || GAME_SERVER_NAMESPACE);
    }

    await DB.deleteSession(sessionId);
    return { deleted: true, notFound: false, session };
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

app.delete("/internal/session/:id", async (c) => {
    const unauthorized = requireControlPlane(c);
    if (unauthorized) return unauthorized;
    try {
        const result = await deleteLocalSession(c.req.param("id"));
        if (result.notFound) {
            return c.json({ success: false, error: "Session not found" }, 404);
        }
        return c.json({ success: true, deleted: result.deleted }, 200);
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
