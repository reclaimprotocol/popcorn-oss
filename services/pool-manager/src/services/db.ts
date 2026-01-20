import { Redis } from "ioredis";
import { Pod, Session } from "../types";

const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = 6379;

console.log(`🔌 Connecting to Redis at ${REDIS_HOST}:${REDIS_PORT}...`);
export const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
});

redis.on("connect", () => console.log("✅ Redis connected!"));
redis.on("error", (err) => console.error("❌ Redis error:", err));

export const DB = {
    async registerPod(pod: Pod) {
        await redis.lpush("idle_pods", JSON.stringify(pod));
    },

    async popIdlePod(): Promise<Pod | null> {
        const raw = await redis.lpop("idle_pods");
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    },

    async createSession(id: string, pod: Pod) {
        await redis.hset("sessions", id, JSON.stringify(pod));
        // Route map for Gateway (Lua)
        const podIp = new URL(pod.url).hostname;
        await redis.set(`route:${id}`, podIp, "EX", 3600 * 24); // 24h
    },

    async getSession(id: string): Promise<Pod | null> {
        const raw = await redis.hget("sessions", id);
        return raw ? JSON.parse(raw) : null;
    },

    async deleteSession(id: string) {
        const session = await DB.getSession(id);
        if (session) {
            await redis.hdel("sessions", id);
            await redis.del(`route:${id}`);
        }
        return session;
    },

    async getStats() {
        const idleCount = await redis.llen("idle_pods");
        const activeSessions = await redis.hgetall("sessions");
        const heartbeats = await redis.hgetall("pod_heartbeats");
        return {
            idleCount,
            activeCount: Object.keys(activeSessions).length,
            idlePods: (await redis.lrange("idle_pods", 0, -1)).map(p => JSON.parse(p)),
            activeSessions,
            heartbeats
        };
    },

    async updateHeartbeat(podName: string) {
        await redis.hset("pod_heartbeats", podName, Date.now().toString());
    },

    async cleanupStalePods(timeoutMs: number): Promise<string[]> {
        const now = Date.now();
        const heartbeats = await redis.hgetall("pod_heartbeats");
        const stalePods: string[] = [];

        for (const [podName, timestamp] of Object.entries(heartbeats)) {
            if (now - parseInt(timestamp) > timeoutMs) {
                // Remove from heartbeats
                await redis.hdel("pod_heartbeats", podName);
                stalePods.push(podName);
            }
        }
        return stalePods;
    },

    async removePodFromIdle(podName: string) {
        // This is tricky linearly, but necessary if a pod dies while idle.
        // LREM requires value match.
        // We might need to fetch all, and remove the one matching name.
        // This is O(N) but N is small (pool size).
        const allPods = await redis.lrange("idle_pods", 0, -1);
        for (const raw of allPods) {
            try {
                const p = JSON.parse(raw);
                if (p.name === podName) {
                    await redis.lrem("idle_pods", 1, raw);
                    console.log(`🧹 Removed stale pod ${podName} from idle_pods`);
                }
            } catch { }
        }
    }
};
