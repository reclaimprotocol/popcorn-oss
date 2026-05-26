import { Redis } from "ioredis";
import { Pod } from "../types";
import { routeTtlSeconds } from "../session-ttl";

const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_PORT = 6379;
const EXTRA_ROUTE_PORTS = readExtraRoutePorts(process.env.POOL_MANAGER_EXTRA_ROUTE_PORTS);

function readExtraRoutePorts(raw: string | undefined): Record<string, string> {
    if (!raw?.trim()) {
        return {};
    }

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            console.warn("Ignoring POOL_MANAGER_EXTRA_ROUTE_PORTS because it is not a JSON object");
            return {};
        }

        return Object.fromEntries(
            Object.entries(parsed).flatMap(([portName, value]) => {
                const routeKey = typeof value === "string"
                    ? value
                    : value && typeof value === "object" && !Array.isArray(value) && typeof (value as any).routeKey === "string"
                        ? (value as any).routeKey
                        : "";

                if (/^[A-Za-z0-9_-]+$/.test(portName) && /^[A-Za-z0-9_-]+$/.test(routeKey)) {
                    return [[portName, routeKey]];
                }
                return [];
            })
        );
    } catch (e) {
        console.warn("Ignoring POOL_MANAGER_EXTRA_ROUTE_PORTS because it is invalid JSON:", e);
        return {};
    }
}

console.log(`🔌 Connecting to Redis at ${REDIS_HOST}:${REDIS_PORT}...`);
export const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
});

redis.on("connect", () => console.log("✅ Redis connected!"));
redis.on("error", (err) => console.error("❌ Redis error:", err));

function sessionRouteKeys(id: string): string[] {
    return [
        `route:${id}`,
        `route:cdp:${id}`,
        `route:api:${id}`,
        `route:cdp-internal:${id}`,
        ...Object.values(EXTRA_ROUTE_PORTS).map((routeKey) => `route:${routeKey}:${id}`),
    ];
}

async function writeSessionRoutes(id: string, pod: Pod & { ports?: { name: string, port: number }[] }): Promise<void> {
    const u = new URL(pod.url);
    const host = u.hostname;
    const mainPort = u.port;
    const ttlSeconds = routeTtlSeconds(pod.expiresAt);

    await redis.set(`route:${id}`, `${host}:${mainPort}`, "EX", ttlSeconds);

    if (pod.ports) {
        for (const p of pod.ports) {
            if (p.name === "cdp") {
                await redis.set(`route:cdp:${id}`, `${host}:${p.port}`, "EX", ttlSeconds);
            } else if (p.name === "cdp-internal") {
                await redis.set(`route:cdp-internal:${id}`, `${host}:${p.port}`, "EX", ttlSeconds);
            } else if (p.name === "kernel-api") {
                await redis.set(`route:api:${id}`, `${host}:${p.port}`, "EX", ttlSeconds);
            } else if (EXTRA_ROUTE_PORTS[p.name]) {
                await redis.set(`route:${EXTRA_ROUTE_PORTS[p.name]}:${id}`, `${host}:${p.port}`, "EX", ttlSeconds);
            }
        }
    }

    // The cdp-internal port is static because it uses portPolicy: None in the fleet.
    await redis.set(`route:cdp-internal:${id}`, `${host}:9226`, "EX", ttlSeconds);
}

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
            await writeSessionRoutes(id, pod);
            return true;
        } catch (error) {
            await redis.hdel("sessions", id);
            throw error;
        }
    },

    async updateSession(id: string, pod: Pod & { ports?: { name: string, port: number }[] }): Promise<void> {
        await redis.hset("sessions", id, JSON.stringify(pod));
        await writeSessionRoutes(id, pod);
    },

    async getSession(id: string): Promise<Pod | null> {
        const raw = await redis.hget("sessions", id);
        return raw ? JSON.parse(raw) : null;
    },

    async deleteSession(id: string) {
        const session = await DB.getSession(id);
        if (session) {
            await redis.hdel("sessions", id);
            await redis.del(...sessionRouteKeys(id));
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
