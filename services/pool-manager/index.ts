import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { DB } from "./src/services/db";
import { Agones } from "./src/services/agones";
import { RegisterRequest, TurnServerConfig } from "./src/types";
import { Auth } from "./src/services/auth";

const app = new Hono();
const PORT = 3000;
const TURN_SECRET = process.env.TURN_SECRET || "popcorn_secret";
const TURN_HOST = process.env.TURN_HOST || "192.168.139.2";
const TURN_HOST_INTERNAL = process.env.TURN_HOST_INTERNAL || TURN_HOST; // Default to same if not set
const TURN_PORT = 3478;

// Helper to generate TURN creds
function generateTurnCreds(usernameId: string, useInternal = false): TurnServerConfig | TurnServerConfig[] {
    // 🌍 Check for static external config (e.g. Metered.ca) - ONLY for external clients
    if (!useInternal && process.env.EXTERNAL_ICE_SERVERS_JSON) {
        try {
            const externalConfig = JSON.parse(process.env.EXTERNAL_ICE_SERVERS_JSON);
            return externalConfig;
        } catch (e) {
            console.error("❌ Failed to parse EXTERNAL_ICE_SERVERS_JSON:", e);
        }
    }

    const ttl = 24 * 3600; // 24 Hours
    const timestamp = Math.floor(Date.now() / 1000) + ttl;
    const username = `${timestamp}:${usernameId}`;
    const password = createHmac("sha1", TURN_SECRET).update(username).digest("base64");

    const host = useInternal ? TURN_HOST_INTERNAL : TURN_HOST;

    return {
        urls: [`turn:${host}:${TURN_PORT}`],
        username,
        credential: password
    };
}

// Serve Admin UI Static File
app.get("/admin", async (c) => {
    return c.html(await Bun.file("./public/admin.html").text());
});

// GET /admin/servers
app.get("/admin/servers", async (c) => {
    // Return minimal info
    const gameServers = await Agones.listGameServers();
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

// GET /session/:id
app.get("/session/:id", async (c) => {
    const id = c.req.param("id");
    const session = await DB.getSession(id);

    if (!session) {
        return c.json({ success: false, error: "Session not found" }, 404);
    }

    const host = c.req.header("Host") || "localhost";
    const protocol = c.req.header("X-Forwarded-Proto") || "http";
    const token = Auth.signToken(id);

    // Construct URLs
    const gatewayUrl = `${protocol}://${host}/browser/${id}/${token}/`;
    const cdpUrl = `${protocol}://${host}/cdp/${id}/${token}/`;
    const apiUrl = `${protocol}://${host}/api/${id}/${token}/`;

    return c.json({
        success: true,
        sessionId: id,
        url: gatewayUrl,
        cdpUrl,
        apiUrl
    });
});

// GET /health
app.get("/health", (c) => c.text("OK"));

// POST /register
// Used by browser-nodes to fetch ICE/TURN config on startup
app.post("/register", async (c) => {
    let body: RegisterRequest;
    try {
        body = await c.req.json();
    } catch (e) {
        return c.json({ error: "Invalid JSON" }, 400);
    }

    if (!body.name) {
        return c.json({ error: "Missing name" }, 400);
    }

    console.log(`🔌 Registering pod (config fetch): ${body.name}`);

    // Generate TURN creds for the pod
    const iceConfigs = generateTurnCreds(body.name);

    return c.json({
        iceServers: Array.isArray(iceConfigs) ? iceConfigs : [iceConfigs]
    });
});

// POST /session
app.post("/session", async (c) => {
    let sessionId = `anon-${crypto.randomUUID().slice(0, 6)}`;

    try {
        const body = await c.req.json();
        if (body.sessionId) sessionId = body.sessionId;
    } catch (e) {
        // Body parsing failed or empty, ignore
    }

    console.log(`🚀 Allocation request for session: ${sessionId}`);

    try {
        // 1. Allocate a pod from Agones
        const allocation = await Agones.allocate();

        // 2. Map the pod
        const port = allocation.ports?.[0]?.port || 8080;
        const podUrl = `http://${allocation.address}:${port}`;

        const podData = {
            name: allocation.gameServerName,
            url: podUrl,
            ports: allocation.ports
        };

        // 3. Store session & Route in Redis (For Gateway lookup)
        await DB.createSession(sessionId, podData);

        // 4. Construct Gateway URLs
        const host = c.req.header("Host") || "localhost";
        const protocol = c.req.header("X-Forwarded-Proto") || "http";
        const token = Auth.signToken(sessionId);
        const gatewayUrl = `${protocol}://${host}/browser/${sessionId}/${token}/`;
        const cdpUrl = `${protocol}://${host}/cdp/${sessionId}/${token}/`;
        const apiUrl = `${protocol}://${host}/api/${sessionId}/${token}/`;

        return c.json({
            success: true,
            sessionId,
            url: gatewayUrl,
            cdpUrl,
            apiUrl
        });

    } catch (e) {
        console.error("Failed to allocate session:", e);
        return c.json({ error: "Failed to allocate browser instance" }, 503);
    }
});


// POST /heartbeat
app.post("/heartbeat", async (c) => {
    try {
        const body = await c.req.json();
        if (body.name) await DB.updateHeartbeat(body.name);
    } catch (e) { }
    return c.json({ ok: true });
});

// DELETE /session/:id
app.delete("/session/:id", async (c) => {
    const id = c.req.param("id");

    // 1. Get session info to find pod name
    const session = await DB.getSession(id);
    if (session && session.name) {
        // 2. Kill Agones GameServer (Terminates session)
        await Agones.shutdownGameServer(session.name);
    }

    // 3. Cleanup Redis mapping
    await DB.deleteSession(id);

    return c.json({ success: true });
});

// Admin: Force Shutdown GameServer
app.delete("/admin/gameserver/:name", async (c) => {
    const name = c.req.param("name");
    console.log(`🛠️ Admin Force Shutdown: ${name}`);
    await Agones.shutdownGameServer(name);
    return c.json({ success: true });
});

export default {
    port: PORT,
    fetch: app.fetch,
};
