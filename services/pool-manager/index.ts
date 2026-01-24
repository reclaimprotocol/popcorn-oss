import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { DB } from "./src/services/db";
import { K8s } from "./src/services/k8s";
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

// GET /admin/api
app.get("/admin/api", async (c) => {
    const stats = await DB.getStats();
    const k8sPods = await K8s.listBrowserPods();

    // Enrich stats for UI
    const enrichedSessions = Object.entries(stats.activeSessions).reduce((acc, [id, dataStr]) => {
        try {
            const pod = JSON.parse(dataStr);
            // Construct Gateway URL for Admin UI
            const host = c.req.header("Host") || "localhost";
            const protocol = c.req.header("X-Forwarded-Proto") || "http";
            const token = Auth.signToken(id);
            pod.url = `${protocol}://${host}/browser/${id}/${token}/`;
            acc[id] = pod;
        } catch (e) {
            acc[id] = dataStr;
        }
        return acc;
    }, {} as Record<string, any>);

    return c.json({
        ...stats,
        idlePods: stats.idlePods.map(p => ({ name: p.name })),
        activeSessions: enrichedSessions,
        k8sPods
    });
});

// GET /health
app.get("/health", (c) => c.text("OK"));

// POST /register
app.post("/register", async (c) => {
    let body: RegisterRequest;
    try {
        body = await c.req.json();
    } catch (e) {
        return c.json({ error: "Invalid JSON" }, 400);
    }

    if (!body.name || !body.url) {
        return c.json({ error: "Missing name or url" }, 400);
    }

    console.log(`🔌 Registering pod: ${body.name} (${body.url})`);

    await DB.registerPod({
        name: body.name,
        url: body.url
    });

    // Generate TURN creds for the pod to use (technically pod uses them to connect to TURN? 
    // Or just to have them available? The plan says "returns TURN creds" implies the pod needs them.
    // Usually the *client* needs them, but if the browser node acts as a peer, it might need them too.
    // We'll generate a set for the pod itself using its name as ID.
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

    const pod = await DB.popIdlePod();

    if (!pod) {
        return c.json({ error: "No idle pods available" }, 503);
    }

    console.log(`🚀 Assigned pod: ${pod.name} (${pod.url}) to session: ${sessionId}`);

    // 🔥 HOT POOL LOGIC: Orphan the pod
    await K8s.orphanPod(pod.name);

    // Store session & Route
    await DB.createSession(sessionId, pod);

    // Construct Gateway URL
    const host = c.req.header("Host") || "localhost";
    const protocol = c.req.header("X-Forwarded-Proto") || "http";
    const token = Auth.signToken(sessionId);
    const gatewayUrl = `${protocol}://${host}/browser/${sessionId}/${token}/`;

    // 🔑 Generate Time-Limited TURN Credentials for the Client
    // 🔑 Generate Time-Limited TURN Credentials for the Client
    const iceConfigs = generateTurnCreds(sessionId);

    return c.json({ url: gatewayUrl, sessionId, iceServers: Array.isArray(iceConfigs) ? iceConfigs : [iceConfigs] });
});


// POST /heartbeat
app.post("/heartbeat", async (c) => {
    let body: { name: string };
    try {
        body = await c.req.json();
    } catch { return c.json({}, 400); }

    if (body.name) {
        await DB.updateHeartbeat(body.name);
    }
    return c.json({ ok: true });
});

// GET /debug/pool
app.get("/debug/pool", async (c) => {
    const stats = await DB.getStats();
    return c.json({ count: stats.idleCount, pods: stats.idlePods });
});

// DELETE /session/:id
app.delete("/session/:id", async (c) => {
    const id = c.req.param("id");
    const sessionPod = await DB.deleteSession(id);

    if (sessionPod) {
        // Hard kill the pod since it's now orphaned
        await K8s.deletePod(sessionPod.name);
        return c.json({ success: true, killed: sessionPod.name });
    }
    return c.json({ error: "Session not found" }, 404);
});

// 🧹 Stale Pod Cleanup Job
setInterval(async () => {
    // 30 Seconds timeout
    const stalePods = await DB.cleanupStalePods(30 * 1000);

    for (const podName of stalePods) {
        console.warn(`🧟 Stale heartbeat from ${podName}. Cleaning up...`);
        // 1. Remove from idle list (if present)
        await DB.removePodFromIdle(podName);

        // 2. Kill the pod (forces restart by Deployment)
        await K8s.deletePod(podName);
    }
}, 10000); // Run every 10s

// ⚖️ Dynamic Pool Scaling Job
const POOL_SIZE_LIMIT = parseInt(process.env.POOL_SIZE_LIMIT || "5");
const DEPLOYMENT_NAME = "browser-pool";

setInterval(async () => {
    const stats = await DB.getStats();
    const activeCount = Object.keys(stats.activeSessions).length;

    // Calculate how many idle pods strictly needed to maintain total limit
    // Total = Active + Idle (Replicas)
    // Replicas = TotalLimit - Active
    const targetReplicas = Math.max(0, POOL_SIZE_LIMIT - activeCount);

    const currentReplicas = await K8s.getDeploymentReplicas(DEPLOYMENT_NAME);

    if (currentReplicas !== targetReplicas) {
        console.log(`⚖️  Syncing Pool Size: Active=${activeCount}, TargetReplicas=${targetReplicas} (Current=${currentReplicas})`);
        await K8s.scaleDeployment(DEPLOYMENT_NAME, targetReplicas);
    }
}, 5000); // Run every 5s

export default {
    port: PORT,
    fetch: app.fetch,
};
