import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { Redis } from "ioredis";
import { KubeConfig, CoreV1Api } from '@kubernetes/client-node';

// 🔧 FIX: Disable TLS verification globally for local dev (nuclear option)
// 🔧 FIX: Disable TLS verification globally for local dev (nuclear option)
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const app = new Hono();
const PORT = 3000;
const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = 6379;

console.log(`🔌 Connecting to Redis at ${REDIS_HOST}:${REDIS_PORT}...`);
const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
});

redis.on("connect", () => console.log("✅ Redis connected!"));
redis.on("error", (err) => console.error("❌ Redis error:", err));

// K8s Client
const kc = new KubeConfig();
try {
    kc.loadFromDefault();
} catch (e) {
    console.warn("⚠️ Failed to load KubeConfig (running outside cluster without config?)");
}
// 🔧 FIX: Disable TLS verification for local development (fixes SELF_SIGNED_CERT_IN_CHAIN)
// @ts-ignore: Readonly property workaround
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    kc.clusters.forEach(c => c.skipTLSVerify = true);
}

const k8s = kc.makeApiClient(CoreV1Api);

// Serve Admin UI Static File
app.get("/admin", async (c) => {
    return c.html(await Bun.file("./public/admin.html").text());
});

// GET /admin/api
app.get("/admin/api", async (c) => {
    const idlePods = await redis.lrange("idle_pods", 0, -1);
    const activeSessions = await redis.hgetall("sessions");

    return c.json({
        idleCount: idlePods.length,
        activeCount: Object.keys(activeSessions).length,
        idlePods: idlePods.map(p => {
            try { return JSON.parse(p) } catch { return p }
        }),
        activeSessions: Object.entries(activeSessions).reduce((acc, [id, data]) => {
            try {
                const pod = JSON.parse(data);
                // Construct Gateway URL for Admin UI
                const host = c.req.header("Host") || "localhost";
                const protocol = c.req.header("X-Forwarded-Proto") || "http";
                pod.url = `${protocol}://${host}/browser/${id}/`;
                acc[id] = pod;
            } catch (e) {
                acc[id] = data;
            }
            return acc;
        }, {} as Record<string, any>)
    });
});

// GET /health
app.get("/health", (c) => c.text("OK"));

// POST /session
app.post("/session", async (c) => {
    let sessionId = `anon-${crypto.randomUUID().slice(0, 6)}`;

    try {
        const body = await c.req.json();
        if (body.sessionId) sessionId = body.sessionId;
    } catch (e) {
        // Body parsing failed or empty, ignore
    }

    // Atomic pop
    const podRaw = await redis.lpop("idle_pods");

    if (!podRaw) {
        return c.json({ error: "No idle pods available" }, 503);
    }

    // Parse Pod Data (Expecting: { name: "...", url: "..." })
    let podData: { name: string, url: string };
    try {
        podData = JSON.parse(podRaw);
    } catch (e) {
        console.error("❌ Invalid pod data in Redis:", podRaw);
        return c.json({ error: "Internal Pool Error: Invalid Pod Data" }, 500);
    }

    console.log(`🚀 Assigned pod: ${podData.name} (${podData.url}) to session: ${sessionId}`);

    // 🔥 HOT POOL LOGIC: Orphan the pod so Deployment creates a replacement
    // We patch the label 'app' to 'browser-node-taken'
    // This removes it from the Deployment's selector (which looks for 'browser-node')
    try {
        console.log(`🏷️  Orphaning pod ${podData.name} from Deployment...`);
        // @ts-ignore
        await k8s.patchNamespacedPod({
            name: podData.name,
            namespace: "default",
            body: [
                {
                    op: "replace",
                    path: "/metadata/labels/app",
                    value: "browser-node-taken"
                }
            ]
        });
    } catch (e) {
        console.error("❌ Failed to patch pod labels:", e);
        // Continue anyway, but pool won't auto-scale
    }

    // Store session
    await redis.hset("sessions", sessionId, JSON.stringify(podData));

    // 🔥 ROUTING LOGIC: Map session ID to Pod IP for OpenResty Gateway
    // Key: route:<id> -> Value: <internal_ip> (e.g. 10.12.0.5)
    // Extract IP from URL (assuming url is http://10.x.x.x:8080)
    const podIp = new URL(podData.url).hostname;
    await redis.set(`route:${sessionId}`, podIp, "EX", 3600); // Expire in 1 hour

    // Construct Gateway URL
    // Default to a placeholder if env var not set, or infer from somewhere.
    // For now, let's assume the client knows the gateway IP or we return a relative path.
    // If we return absolute, we need GATEWAY_PUBLIC_URL.
    // Let's return a relative path that the client can use against the Gateway.
    // Or if `pool-manager` is behind the gateway (it's not, it's parallel or behind?), 
    // actually, the user hits Gateway -> Pool Manager (for API).
    // So `c.req.url` would be the Gateway URL?
    // If Gateway proxies /api/* to Pool Manager, then `c.req.header("Host")` is the Gateway.
    // Let's try to use the Host header.

    const host = c.req.header("Host") || "localhost";
    const protocol = c.req.header("X-Forwarded-Proto") || "http";
    const gatewayUrl = `${protocol}://${host}/browser/${sessionId}/`;

    return c.json({ url: gatewayUrl, sessionId });
});

// POST /debug/seed
app.post("/debug/seed", async (c) => {
    const pod = c.req.query("pod");
    if (pod) {
        // Mock data for debug
        const data = JSON.stringify({ name: "mock-pod", url: pod });
        await redis.rpush("idle_pods", data);
        return c.text(`Added ${data} to pool`);
    }
    return c.text("Missing 'pod' query param", 400);
});

// GET /debug/pool
app.get("/debug/pool", async (c) => {
    const length = await redis.llen("idle_pods");
    const pods = await redis.lrange("idle_pods", 0, -1);
    return c.json({ count: length, pods });
});

// DELETE /session/:id
app.delete("/session/:id", async (c) => {
    const id = c.req.param("id");
    const sessionRaw = await redis.hget("sessions", id);

    if (sessionRaw) {
        await redis.hdel("sessions", id);

        try {
            const podData = JSON.parse(sessionRaw);
            console.log(`💀 Deleting used pod: ${podData.name}`);

            // Hard kill the pod since it's now orphaned
            // ObjectParamAPI: (params)
            // @ts-ignore
            await k8s.deleteNamespacedPod({
                name: podData.name,
                namespace: "default"
            });

            return c.json({ success: true, killed: podData.name });
        } catch (e) {
            console.error("❌ Error cleaning up session pod:", e);
            return c.json({ error: "Failed to cleanup pod" }, 500);
        }
    }
    return c.json({ error: "Session not found" }, 404);
});

// PROXY: Reverse proxy requests to browser pods
// Handle WebSocket upgrades
// We need to access the underlying server for this in Hono/Bun, typically done separately or via adapter.
// For Hono+Bun, it's simpler to implement a custom handler for the specific path.

// DELETED: Legacy Proxy Logic (Handled by OpenResty Gateway)

console.log(`🧢 Pool Manager (Hono) running on port ${PORT}`);

export default {
    port: PORT,
    fetch: app.fetch,
};
