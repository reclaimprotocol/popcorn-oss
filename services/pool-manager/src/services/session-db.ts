import type { Redis } from "ioredis";
import type { Pod } from "../types";
import { routeTtlSeconds } from "../session-ttl";

type SessionPod = Pod & { ports?: { name: string, port: number }[] };

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
    } catch (error) {
        console.warn("Ignoring POOL_MANAGER_EXTRA_ROUTE_PORTS because it is invalid JSON:", error);
        return {};
    }
}

function sessionRouteKeys(id: string, extraRoutePorts: Record<string, string>): string[] {
    return [
        `auth:route-bound:${id}`,
        `route:${id}`,
        `route:cdp:${id}`,
        `route:api:${id}`,
        `route:cdp-internal:${id}`,
        ...Object.values(extraRoutePorts).map((routeKey) => `route:${routeKey}:${id}`),
    ];
}

function buildSessionRoutes(
    id: string,
    pod: SessionPod,
    extraRoutePorts: Record<string, string>,
): Array<{ key: string, value: string, ttlSeconds: number }> {
    const url = new URL(pod.url);
    const host = url.hostname;
    const ttlSeconds = routeTtlSeconds(pod.expiresAt);
    const routes = [{
        key: `route:${id}`,
        value: `${host}:${url.port}`,
        ttlSeconds,
    }];

    if (pod.automationProfile === "x402-agent" && pod.publicAccessExpiresAt) {
        routes.push({
            key: `auth:route-bound:${id}`,
            value: String(Date.parse(pod.publicAccessExpiresAt)),
            ttlSeconds: routeTtlSeconds(pod.publicAccessExpiresAt),
        });
    }

    for (const port of pod.ports ?? []) {
        if (port.name === "cdp") {
            routes.push({ key: `route:cdp:${id}`, value: `${host}:${port.port}`, ttlSeconds });
        } else if (port.name === "cdp-internal") {
            routes.push({ key: `route:cdp-internal:${id}`, value: `${host}:${port.port}`, ttlSeconds });
        } else if (port.name === "kernel-api") {
            routes.push({ key: `route:api:${id}`, value: `${host}:${port.port}`, ttlSeconds });
        } else if (extraRoutePorts[port.name]) {
            routes.push({
                key: `route:${extraRoutePorts[port.name]}:${id}`,
                value: `${host}:${port.port}`,
                ttlSeconds,
            });
        }
    }

    // The cdp-internal port is static because it uses portPolicy: None in the fleet.
    routes.push({ key: `route:cdp-internal:${id}`, value: `${host}:9226`, ttlSeconds });
    return routes;
}

async function writeSessionRoutes(
    client: Redis,
    routes: Array<{ key: string, value: string, ttlSeconds: number }>,
): Promise<void> {
    for (const route of routes) {
        await client.set(route.key, route.value, "EX", route.ttlSeconds);
    }
}

async function mirrorWrite(
    secondary: Redis | null,
    operation: string,
    write: (client: Redis) => Promise<unknown>,
): Promise<void> {
    if (!secondary) {
        return;
    }

    try {
        await write(secondary);
    } catch (error) {
        // The original Redis remains authoritative until cutover. A secondary
        // outage must not interrupt allocations; parity checks repair any gap.
        console.error(`❌ Secondary Redis mirror failed during ${operation}:`, error);
    }
}

export function createSessionDatabase(
    primary: Redis,
    secondary: Redis | null = null,
    extraRoutePortsRaw?: string,
) {
    const extraRoutePorts = readExtraRoutePorts(extraRoutePortsRaw);

    const database = {
        async sessionExists(id: string): Promise<boolean> {
            return (await primary.hexists("sessions", id)) === 1;
        },

        async createSession(id: string, pod: SessionPod): Promise<boolean> {
            const serializedPod = JSON.stringify(pod);
            const created = await primary.hsetnx("sessions", id, serializedPod);
            if (!created) {
                return false;
            }

            const routes = buildSessionRoutes(id, pod, extraRoutePorts);
            await mirrorWrite(secondary, `create session ${id}`, async (client) => {
                await client.hset("sessions", id, serializedPod);
            });

            try {
                await writeSessionRoutes(primary, routes);
                await mirrorWrite(secondary, `write routes for ${id}`, (client) => {
                    return writeSessionRoutes(client, routes);
                });
                return true;
            } catch (error) {
                await primary.hdel("sessions", id);
                await mirrorWrite(secondary, `roll back session ${id}`, async (client) => {
                    await client.hdel("sessions", id);
                    await client.del(...sessionRouteKeys(id, extraRoutePorts));
                });
                throw error;
            }
        },

        async updateSession(id: string, pod: SessionPod): Promise<void> {
            const serializedPod = JSON.stringify(pod);
            const routes = buildSessionRoutes(id, pod, extraRoutePorts);

            await primary.hset("sessions", id, serializedPod);
            await writeSessionRoutes(primary, routes);
            await mirrorWrite(secondary, `update session ${id}`, async (client) => {
                await client.hset("sessions", id, serializedPod);
                await writeSessionRoutes(client, routes);
            });
        },

        async getSession(id: string): Promise<Pod | null> {
            const raw = await primary.hget("sessions", id);
            return raw ? JSON.parse(raw) : null;
        },

        async deleteSession(id: string) {
            const session = await database.getSession(id);
            const routeKeys = sessionRouteKeys(id, extraRoutePorts);

            if (session) {
                await primary.hdel("sessions", id);
                await primary.del(...routeKeys);
            }

            await mirrorWrite(secondary, `delete session ${id}`, async (client) => {
                await client.hdel("sessions", id);
                await client.del(...routeKeys);
            });
            return session;
        },

        async getStats() {
            const activeSessions = await primary.hgetall("sessions");
            return {
                activeCount: Object.keys(activeSessions).length,
                activeSessions,
            };
        },
    };

    return database;
}
