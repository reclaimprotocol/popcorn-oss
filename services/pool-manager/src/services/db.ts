import { Redis } from "ioredis";
import { createSessionDatabase } from "./session-db";

const REDIS_HOST = process.env.REDIS_HOST || "localhost";
const REDIS_SECONDARY_HOST = process.env.REDIS_SECONDARY_HOST?.trim();
const REDIS_PORT = 6379;

function reconnectOnFailover(error: Error): 2 | false {
    if (error.message.includes("READONLY") || error.message.includes("MASTERDOWN")) {
        return 2;
    }
    return false;
}

console.log(`🔌 Connecting to Redis at ${REDIS_HOST}:${REDIS_PORT}...`);
export const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    reconnectOnError: reconnectOnFailover,
});

redis.on("connect", () => console.log("✅ Redis connected!"));
redis.on("error", (err) => console.error("❌ Redis error:", err));

const secondaryRedis = REDIS_SECONDARY_HOST
    ? new Redis({
        host: REDIS_SECONDARY_HOST,
        port: REDIS_PORT,
        connectTimeout: 1000,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        reconnectOnError: reconnectOnFailover,
    })
    : null;

if (secondaryRedis) {
    console.log(`🔁 Mirroring Redis writes to ${REDIS_SECONDARY_HOST}:${REDIS_PORT}...`);
    secondaryRedis.on("connect", () => console.log("✅ Secondary Redis connected!"));
    secondaryRedis.on("error", (err) => console.error("❌ Secondary Redis error:", err));
}

export const DB = createSessionDatabase(
    redis,
    secondaryRedis,
    process.env.POOL_MANAGER_SESSION_EXTENSION_ROUTE_PORTS,
);
