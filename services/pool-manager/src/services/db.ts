import { Redis } from "ioredis";
import { Pod } from "../types";

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
    async createSession(id: string, pod: Pod & { ports?: { name: string, port: number }[] }) {
        await redis.hset("sessions", id, JSON.stringify(pod));

        // 1. Primary Route (http/neko)
        const u = new URL(pod.url);
        const host = u.hostname;
        const mainPort = u.port;
        await redis.set(`route:${id}`, `${host}:${mainPort}`, "EX", 3600 * 24);

        // 2. Additional routes from Agones ports
        if (pod.ports) {
            for (const p of pod.ports) {
                if (p.name === "cdp") {
                    await redis.set(`route:cdp:${id}`, `${host}:${p.port}`, "EX", 3600 * 24);
                } else if (p.name === "kernel-api") {
                    await redis.set(`route:api:${id}`, `${host}:${p.port}`, "EX", 3600 * 24);
                }
            }
        }
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
        const activeSessions = await redis.hgetall("sessions");
        const heartbeats = await redis.hgetall("pod_heartbeats");
        return {
            activeCount: Object.keys(activeSessions).length,
            activeSessions,
            heartbeats
        };
    },

    async updateHeartbeat(podName: string) {
        await redis.hset("pod_heartbeats", podName, Date.now().toString());
    }
};
