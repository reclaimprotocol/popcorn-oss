import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { DB } from "./src/services/db";
import { Agones } from "./src/services/agones";
import { Auth } from "./src/services/auth";
import { AnalyticsClient } from "./src/services/analytics-client";
import { ClickHouse } from "./src/services/clickhouse";
import { K8s } from "./src/services/k8s";
import { RuntimeConfig } from "./src/config";
import {
    ADMIN_OAUTH_STATE_COOKIE,
    ADMIN_SESSION_COOKIE,
    authenticateBasicAdmin,
    authorizeGoogleUser,
    buildGoogleAuthorizationUrl,
    createAdminSession,
    createOauthState,
    fetchGoogleUserInfo,
    isAdminAuthPath,
    isGoogleOAuthConfigured,
    isPasswordLoginConfigured,
    isSameOriginAdminRequest,
    readAdminAuthConfig,
    verifyAdminPassword,
    verifyAdminSession,
    verifyOauthState,
    wantsHtml,
} from "./src/services/admin-auth";

const app = new Hono();
const PORT = 3000;

// Read from environment variables populated by pool-manager-env-secrets.
const ADMIN_AUTH_CONFIG = readAdminAuthConfig();
const CLUSTER_NAME = process.env.CLUSTER_NAME || "unknown";
const GAME_SERVER_NAMESPACE = RuntimeConfig.gameServerNamespace;
const GAME_SERVER_FLEET = RuntimeConfig.gameServerFleet;
const ADMIN_CLIENT_ID = "admin";
const ADMIN_CLIENT_NAME = "Admin UI";
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

app.use('/admin/*', async (c, next) => {
    if (isAdminAuthPath(new URL(c.req.url).pathname)) {
        return next();
    }

    const basicIdentity = await authenticateBasicAdmin(c.req.header("Authorization"), ADMIN_AUTH_CONFIG);
    if (basicIdentity) {
        return next();
    }

    const sessionIdentity = verifyAdminSession(getCookie(c, ADMIN_SESSION_COOKIE), ADMIN_AUTH_CONFIG);
    if (sessionIdentity) {
        if (!isSameOriginAdminRequest(c.req.raw)) {
            return c.json({ error: "Cross-origin admin request rejected" }, 403);
        }
        return next();
    }

    if (wantsHtml(c.req.raw.headers)) {
        return c.redirect("/admin/login", 302);
    }

    c.header("WWW-Authenticate", 'Basic realm="Popcorn Admin"');
    return c.json({ error: "Unauthorized" }, 401);
});

app.use('/admin', async (c, next) => {
    const basicIdentity = await authenticateBasicAdmin(c.req.header("Authorization"), ADMIN_AUTH_CONFIG);
    if (basicIdentity || verifyAdminSession(getCookie(c, ADMIN_SESSION_COOKIE), ADMIN_AUTH_CONFIG)) {
        return next();
    }

    if (wantsHtml(c.req.raw.headers)) {
        return c.redirect("/admin/login", 302);
    }

    c.header("WWW-Authenticate", 'Basic realm="Popcorn Admin"');
    return c.json({ error: "Unauthorized" }, 401);
});

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

async function authenticateClient(c: any): Promise<{ identity?: ClientIdentity; response?: Response }> {
    const credential = getBearerCredential(c);

    if (!credential) {
        return {
            response: c.json({ error: "Missing credentials. Use: Bearer clientId:clientSecret" }, 401)
        };
    }

    const separatorIndex = credential.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === credential.length - 1) {
        return {
            response: c.json({ error: "Invalid credentials format. Use: Bearer clientId:clientSecret" }, 401)
        };
    }

    const clientId = credential.slice(0, separatorIndex);
    const clientSecret = credential.slice(separatorIndex + 1);
    const validation = await AnalyticsClient.validateCredentials(clientId, clientSecret);

    if (!validation.valid) {
        return {
            response: c.json({ error: "Invalid credentials" }, 401)
        };
    }

    return {
        identity: {
            clientId,
            clientName: validation.clientName || "Unknown",
        }
    };
}

async function readRequestedSessionId(c: any): Promise<string | null | undefined> {
    try {
        const body = await c.req.json();
        if (!body || typeof body !== "object" || !("sessionId" in body)) {
            return undefined;
        }
        const sessionId = body?.sessionId;
        if (typeof sessionId !== "string") return null;
        const trimmed = sessionId.trim();
        return trimmed.length ? trimmed : null;
    } catch (e) {
        return undefined;
    }
}

function isValidSessionId(sessionId: string): boolean {
    return SESSION_ID_PATTERN.test(sessionId);
}

function buildSessionDetails(c: any, sessionId: string, session: any) {
    const host = c.req.header("Host") || "localhost";
    const protocol = c.req.header("X-Forwarded-Proto") || "http";
    const token = Auth.signToken(sessionId, 'restricted');
    const internalToken = Auth.signToken(sessionId, 'internal');
    const wsProtocol = protocol === "https" ? "wss" : "ws";

    return {
        success: true,
        sessionId,
        url: `${protocol}://${host}/${session.name}/${sessionId}/${token}/`,
        cdpUrl: `${wsProtocol}://${host}/cdp/${sessionId}/${token}/`,
        cdpInternalUrl: `${wsProtocol}://${host}/cdp-internal/${sessionId}/${internalToken}/`,
        apiUrl: `${protocol}://${host}/api/${sessionId}/${internalToken}/`,
        aiUrl: `${protocol}://${host}/ai/${sessionId}/${token}/`,
        browserPodId: session.name
    };
}

async function createSession(c: any, identity: ClientIdentity, requestedSessionId?: string): Promise<Response> {
    if (requestedSessionId && !isValidSessionId(requestedSessionId)) {
        return c.json({ error: "Invalid session ID. Use 1-64 chars in [A-Za-z0-9_-]." }, 400);
    }

    const sessionId = requestedSessionId || crypto.randomUUID().slice(0, 8);
    let allocatedGameServerName: string | null = null;

    if (requestedSessionId) {
        const duplicate = await DB.sessionExists(sessionId);
        if (duplicate) {
            return c.json({ error: "Session ID already exists" }, 409);
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
        };

        try {
            await K8s.patchGameServer(GAME_SERVER_NAMESPACE, allocation.gameServerName, {
                metadata: {
                    annotations: sessionAnnotations,
                }
            });
        } catch (e) {
            console.error(`❌ Failed to annotate GameServer with session metadata:`, e);
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

        AnalyticsClient.createSession(sessionId, identity.clientId, identity.clientName, CLUSTER_NAME);

        return c.json(buildSessionDetails(c, sessionId, podData));
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
        if (e instanceof DuplicateSessionIdError) {
            return c.json({ error: e.message }, 409);
        }

        console.error("Failed to allocate session:", e);
        return c.json({ error: "Failed to allocate browser instance" }, 503);
    }
}

async function getSessionDetails(c: any, sessionId: string, identity?: ClientIdentity): Promise<Response> {
    const session = await DB.getSession(sessionId);

    if (!session) {
        return c.json({ success: false, error: "Session not found" }, 404);
    }

    if (identity && session.clientId !== identity.clientId) {
        return c.json({ success: false, error: "Session not found" }, 404);
    }

    return c.json(buildSessionDetails(c, sessionId, session));
}

async function deleteSession(c: any, sessionId: string, identity?: ClientIdentity): Promise<Response> {
    const session = await DB.getSession(sessionId);

    if (!session) {
        return c.json({ success: true }, 200);
    }

    if (identity && session.clientId !== identity.clientId) {
        return c.json({ success: false, error: "Session not found" }, 404);
    }

    if (session) {
        AnalyticsClient.endSession(sessionId, 'deleted');

        if (session.name) {
            await Agones.shutdownGameServer(session.name, session.namespace || GAME_SERVER_NAMESPACE);
        }
    }

    await DB.deleteSession(sessionId);

    return c.json({ success: true }, 200);
}

function isSecureRequest(c: any): boolean {
    return new URL(c.req.url).protocol === "https:" || c.req.header("X-Forwarded-Proto") === "https";
}

function setAdminSessionCookie(c: any, session: string) {
    setCookie(c, ADMIN_SESSION_COOKIE, session, {
        httpOnly: true,
        sameSite: "Lax",
        secure: isSecureRequest(c),
        path: "/admin",
        maxAge: ADMIN_AUTH_CONFIG.sessionTtlSeconds,
    });
}

function clearAdminCookies(c: any) {
    deleteCookie(c, ADMIN_SESSION_COOKIE, { path: "/admin" });
    deleteCookie(c, ADMIN_OAUTH_STATE_COOKIE, { path: "/admin/auth/google" });
}

app.get("/admin/login", async (c) => {
    return c.html(await Bun.file("./public/admin-login.html").text());
});

app.get("/admin/auth/config", (c) => {
    return c.json({
        password: isPasswordLoginConfigured(ADMIN_AUTH_CONFIG),
        google: isGoogleOAuthConfigured(ADMIN_AUTH_CONFIG),
    });
});

app.post("/admin/auth/password", async (c) => {
    const form = await c.req.formData();
    const username = String(form.get("username") || "");
    const password = String(form.get("password") || "");

    if (!await verifyAdminPassword(username, password, ADMIN_AUTH_CONFIG)) {
        return c.redirect("/admin/login?error=Invalid%20credentials", 302);
    }

    if (!isPasswordLoginConfigured(ADMIN_AUTH_CONFIG)) {
        return c.redirect("/admin/login?error=Admin%20session%20secret%20is%20not%20configured", 302);
    }

    setAdminSessionCookie(c, createAdminSession({
        id: username,
        displayName: username,
        strategy: "password",
    }, ADMIN_AUTH_CONFIG));
    return c.redirect("/admin", 302);
});

app.get("/admin/auth/google", (c) => {
    if (!isGoogleOAuthConfigured(ADMIN_AUTH_CONFIG)) {
        return c.redirect("/admin/login?error=Google%20OAuth%20is%20not%20configured", 302);
    }

    const state = createOauthState(ADMIN_AUTH_CONFIG);
    setCookie(c, ADMIN_OAUTH_STATE_COOKIE, state, {
        httpOnly: true,
        sameSite: "Lax",
        secure: isSecureRequest(c),
        path: "/admin/auth/google",
        maxAge: 5 * 60,
    });

    return c.redirect(buildGoogleAuthorizationUrl(ADMIN_AUTH_CONFIG, state), 302);
});

app.get("/admin/auth/google/callback", async (c) => {
    if (!verifyOauthState(c.req.query("state"), getCookie(c, ADMIN_OAUTH_STATE_COOKIE), ADMIN_AUTH_CONFIG)) {
        return c.redirect("/admin/login?error=Invalid%20OAuth%20state", 302);
    }

    const code = c.req.query("code");
    if (!code) {
        return c.redirect("/admin/login?error=Missing%20OAuth%20code", 302);
    }

    try {
        const userInfo = await fetchGoogleUserInfo(code, ADMIN_AUTH_CONFIG);
        const identity = authorizeGoogleUser(userInfo, ADMIN_AUTH_CONFIG);
        if (!identity) {
            return c.redirect("/admin/login?error=Google%20account%20is%20not%20allowed", 302);
        }

        setAdminSessionCookie(c, createAdminSession(identity, ADMIN_AUTH_CONFIG));
        deleteCookie(c, ADMIN_OAUTH_STATE_COOKIE, { path: "/admin/auth/google" });
        return c.redirect("/admin", 302);
    } catch (error) {
        console.error("Google admin login failed:", error);
        return c.redirect("/admin/login?error=Google%20login%20failed", 302);
    }
});

app.post("/admin/logout", (c) => {
    clearAdminCookies(c);
    return c.redirect("/admin/login", 302);
});

// Serve Admin UI Static File
app.get("/admin", async (c) => {
    return c.html(await Bun.file("./public/admin.html").text());
});

// GET /admin/servers
app.get("/admin/servers", async (c) => {
    // Return minimal info
    const gameServers = await Agones.listGameServers(GAME_SERVER_NAMESPACE);
    const stats = await DB.getStats();

    // Map pod names to session IDs
    const podToSession = new Map<string, string>();
    for (const [sid, raw] of Object.entries(stats.activeSessions)) {
        try {
            const data = JSON.parse(raw);
            if (data.name) {
                podToSession.set(data.name, sid);
            }
        } catch (e) { }
    }

    return c.json(gameServers.map((gs: any) => ({
        name: gs.name,
        status: gs.state || gs.status, // Agones returns 'state' in status block, but 'status' is requested
        sessionId: podToSession.get(gs.name) || null
    })));
});

// POST /admin/session
app.post("/admin/session", async (c) => {
    const sessionId = await readRequestedSessionId(c);
    if (sessionId === null) {
        return c.json({ error: "Invalid session ID. Use 1-64 chars in [A-Za-z0-9_-]." }, 400);
    }
    return createSession(c, {
        clientId: ADMIN_CLIENT_ID,
        clientName: ADMIN_CLIENT_NAME,
    }, sessionId);
});

// GET /admin/session/:id
app.get("/admin/session/:id", async (c) => {
    return getSessionDetails(c, c.req.param("id"));
});

// DELETE /admin/session/:id
app.delete("/admin/session/:id", async (c) => {
    return deleteSession(c, c.req.param("id"));
});

// GET /session/:id
app.get("/session/:id", async (c) => {
    const auth = await authenticateClient(c);
    if (auth.response) {
        return auth.response;
    }
    return getSessionDetails(c, c.req.param("id"), auth.identity);
});

// GET /health
app.get("/health", (c) => c.text("OK"));

// POST /session
app.post("/session", async (c) => {
    const auth = await authenticateClient(c);
    if (auth.response) {
        return auth.response;
    }

    const sessionId = await readRequestedSessionId(c);
    if (sessionId === null) {
        return c.json({ error: "Invalid session ID. Use 1-64 chars in [A-Za-z0-9_-]." }, 400);
    }
    return createSession(c, auth.identity!, sessionId);
});

// DELETE /session/:id
app.delete("/session/:id", async (c) => {
    const auth = await authenticateClient(c);
    if (auth.response) {
        return auth.response;
    }

    return deleteSession(c, c.req.param("id"), auth.identity);
});

// Admin: Force Shutdown GameServer
app.delete("/admin/gameserver/:name", async (c) => {
    const name = c.req.param("name");
    console.log(`🛠️ Admin Force Shutdown: ${name}`);

    // Look up session ID from GameServer name to report analytics
    const sessions = await DB.getAllSessions();
    const session = sessions.find(s => s.name === name);
    if (session) {
        AnalyticsClient.endSession(session.sessionId, 'deleted');
        await DB.deleteSession(session.sessionId);
    }

    await Agones.shutdownGameServer(name, session?.namespace || GAME_SERVER_NAMESPACE);
    return c.json({ success: true });
});

export default {
    port: PORT,
    fetch: app.fetch,
};
