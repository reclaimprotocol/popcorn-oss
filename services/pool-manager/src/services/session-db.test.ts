import { describe, expect, test } from "bun:test";
import type { Redis } from "ioredis";
import { createSessionDatabase } from "./session-db";

class FakeRedis {
    readonly hashes = new Map<string, Map<string, string>>();
    readonly strings = new Map<string, { value: string, ttlSeconds: number }>();
    failWrites = false;

    private assertWritable() {
        if (this.failWrites) {
            throw new Error("write failed");
        }
    }

    async hsetnx(key: string, field: string, value: string) {
        this.assertWritable();
        const hash = this.hashes.get(key) ?? new Map<string, string>();
        if (hash.has(field)) {
            return 0;
        }
        hash.set(field, value);
        this.hashes.set(key, hash);
        return 1;
    }

    async hset(key: string, field: string, value: string) {
        this.assertWritable();
        const hash = this.hashes.get(key) ?? new Map<string, string>();
        hash.set(field, value);
        this.hashes.set(key, hash);
        return 1;
    }

    async hget(key: string, field: string) {
        return this.hashes.get(key)?.get(field) ?? null;
    }

    async hgetall(key: string) {
        return Object.fromEntries(this.hashes.get(key) ?? []);
    }

    async hexists(key: string, field: string) {
        return this.hashes.get(key)?.has(field) ? 1 : 0;
    }

    async hdel(key: string, field: string) {
        this.assertWritable();
        return this.hashes.get(key)?.delete(field) ? 1 : 0;
    }

    async set(key: string, value: string, _expiryMode: string, ttlSeconds: number) {
        this.assertWritable();
        this.strings.set(key, { value, ttlSeconds });
        return "OK";
    }

    async del(...keys: string[]) {
        this.assertWritable();
        return keys.reduce((count, key) => count + (this.strings.delete(key) ? 1 : 0), 0);
    }
}

function asRedis(client: FakeRedis): Redis {
    return client as unknown as Redis;
}

const pod = {
    name: "browser-1",
    namespace: "default",
    url: "http://10.0.0.8:9222",
    status: "ready",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    restrictedTokenExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    ports: [
        { name: "cdp", port: 9223 },
        { name: "kernel-api", port: 3000 },
    ],
} as any;

describe("session database dual writes", () => {
    test("mirrors session data and routes to the secondary", async () => {
        const primary = new FakeRedis();
        const secondary = new FakeRedis();
        const database = createSessionDatabase(asRedis(primary), asRedis(secondary));

        expect(await database.createSession("session-1", pod)).toBe(true);
        expect(secondary.hashes).toEqual(primary.hashes);
        expect(secondary.strings).toEqual(primary.strings);
        expect(primary.strings.get("route:session-1")?.value).toBe("10.0.0.8:9222");
        expect(primary.strings.get("route:cdp-internal:session-1")?.value).toBe("10.0.0.8:9226");
        expect(primary.strings.get("route:session-1")?.ttlSeconds).toBeLessThanOrEqual(300);
        expect((await database.getSession("session-1"))?.restrictedTokenExpiresAt)
            .toBe(pod.restrictedTokenExpiresAt);
    });

    test("persists the refreshed restricted-token deadline with a TTL extension", async () => {
        const primary = new FakeRedis();
        const database = createSessionDatabase(asRedis(primary));
        expect(await database.createSession("session-refresh", pod)).toBe(true);

        const refreshedExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        await database.updateSession("session-refresh", {
            ...pod,
            expiresAt: refreshedExpiry,
            restrictedTokenExpiresAt: refreshedExpiry,
        });

        const refreshed = await database.getSession("session-refresh");
        expect(refreshed?.expiresAt).toBe(refreshedExpiry);
        expect(refreshed?.restrictedTokenExpiresAt).toBe(refreshedExpiry);
        expect(primary.strings.get("route:session-refresh")?.ttlSeconds).toBeGreaterThan(300);
        expect(primary.strings.get("route:session-refresh")?.ttlSeconds).toBeLessThanOrEqual(900);
    });

    test("keeps x402 paid access at the old deadline until it is activated", async () => {
        const primary = new FakeRedis();
        const database = createSessionDatabase(asRedis(primary));
        const initialExpiry = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        const extendedExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        const x402Pod = {
            ...pod,
            automationProfile: "x402-agent",
            expiresAt: initialExpiry,
            publicAccessExpiresAt: initialExpiry,
        } as any;

        expect(await database.createSession("x402-stable", x402Pod)).toBe(true);
        expect(primary.strings.get("auth:route-bound:x402-stable")?.value)
            .toBe(String(Date.parse(initialExpiry)));

        await database.updateSession("x402-stable", {
            ...x402Pod,
            expiresAt: extendedExpiry,
            publicAccessExpiresAt: initialExpiry,
        });
        expect(primary.strings.get("route:x402-stable")?.ttlSeconds).toBeGreaterThan(300);
        expect(primary.strings.get("auth:route-bound:x402-stable")?.value)
            .toBe(String(Date.parse(initialExpiry)));

        await database.updateSession("x402-stable", {
            ...x402Pod,
            expiresAt: extendedExpiry,
            publicAccessExpiresAt: extendedExpiry,
        });
        expect(primary.strings.get("auth:route-bound:x402-stable")?.value)
            .toBe(String(Date.parse(extendedExpiry)));

        await database.deleteSession("x402-stable");
        expect(primary.strings.has("auth:route-bound:x402-stable")).toBe(false);
    });

    test("keeps the primary available when the secondary write fails", async () => {
        const primary = new FakeRedis();
        const secondary = new FakeRedis();
        secondary.failWrites = true;
        const database = createSessionDatabase(asRedis(primary), asRedis(secondary));

        expect(await database.createSession("session-2", pod)).toBe(true);
        expect(primary.hashes.get("sessions")?.has("session-2")).toBe(true);
        expect(primary.strings.get("route:session-2")?.value).toBe("10.0.0.8:9222");
    });

    test("deletes stale secondary data even when the primary session is absent", async () => {
        const primary = new FakeRedis();
        const secondary = new FakeRedis();
        await secondary.hset("sessions", "session-3", JSON.stringify(pod));
        await secondary.set("route:session-3", "10.0.0.8:9222", "EX", 60);
        const database = createSessionDatabase(asRedis(primary), asRedis(secondary));

        expect(await database.deleteSession("session-3")).toBeNull();
        expect(secondary.hashes.get("sessions")?.has("session-3")).toBe(false);
        expect(secondary.strings.has("route:session-3")).toBe(false);
    });
});
