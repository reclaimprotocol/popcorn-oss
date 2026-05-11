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
    async sessionExists(id: string): Promise<boolean> {
        return (await redis.hexists("sessions", id)) === 1;
    },

    async createSession(id: string, pod: Pod & { ports?: { name: string, port: number }[] }): Promise<boolean> {
        const created = await redis.hsetnx("sessions", id, JSON.stringify(pod));
        if (!created) {
            return false;
        }

        try {
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
                    } else if (p.name === "cdp-internal") {
                        await redis.set(`route:cdp-internal:${id}`, `${host}:${p.port}`, "EX", 3600 * 24);
                    } else if (p.name === "kernel-api") {
                        await redis.set(`route:api:${id}`, `${host}:${p.port}`, "EX", 3600 * 24);
                    } else if (p.name === "ai-http") {
                        await redis.set(`route:ai:${id}`, `${host}:${p.port}`, "EX", 3600 * 24);
                    }
                }
            }

            // 3. Static cdp-internal port (not returned by Agones allocation because portPolicy: None)
            // The cdp-internal port is always 9226 (static port defined in fleet.yaml)
            await redis.set(`route:cdp-internal:${id}`, `${host}:9226`, "EX", 3600 * 24);
            return true;
        } catch (error) {
            await redis.hdel("sessions", id);
            throw error;
        }
    },

    async getSession(id: string): Promise<Pod | null> {
        const raw = await redis.hget("sessions", id);
        return raw ? JSON.parse(raw) : null;
    },

    async getAllSessions(): Promise<Array<Pod & { sessionId: string }>> {
        const sessions = await redis.hgetall("sessions");
        return Object.entries(sessions).flatMap(([sessionId, raw]) => {
            try {
                const parsed = JSON.parse(raw) as Pod;
                return [{ sessionId, ...parsed }];
            } catch {
                return [];
            }
        });
    },

    async deleteSession(id: string) {
        const session = await DB.getSession(id);
        if (session) {
            await redis.hdel("sessions", id);
            await redis.del(
                `route:${id}`,
                `route:cdp:${id}`,
                `route:api:${id}`,
                `route:ai:${id}`,
                `route:cdp-internal:${id}`,
            );
        }
        return session;
    },

    async getStats() {
        const activeSessions = await redis.hgetall("sessions");
        return {
            activeCount: Object.keys(activeSessions).length,
            activeSessions
        };
    }
};
