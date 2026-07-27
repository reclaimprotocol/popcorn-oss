import { Redis } from "ioredis";

const sourceHost = process.env.REDIS_SOURCE_HOST;
const targetHost = process.env.REDIS_TARGET_HOST;
const sourcePort = Number.parseInt(process.env.REDIS_SOURCE_PORT ?? "6379", 10);
const targetPort = Number.parseInt(process.env.REDIS_TARGET_PORT ?? "6379", 10);
const mode = process.argv.includes("--copy") ? "copy" : "compare";
const ttlToleranceMs = Number.parseInt(process.env.REDIS_TTL_TOLERANCE_MS ?? "5000", 10);

if (!sourceHost || !targetHost) {
    throw new Error("REDIS_SOURCE_HOST and REDIS_TARGET_HOST are required");
}

const source = new Redis({ host: sourceHost, port: sourcePort });
const target = new Redis({ host: targetHost, port: targetPort });

async function scanKeys(client: Redis): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
        const [nextCursor, batch] = await client.scan(cursor, "COUNT", 500);
        cursor = nextCursor;
        keys.push(...batch);
    } while (cursor !== "0");
    return keys.sort();
}

async function canonicalValue(client: Redis, key: string): Promise<string> {
    const type = await client.type(key);
    if (type === "string") {
        return JSON.stringify([type, await client.getBuffer(key)?.then((value) => value?.toString("base64"))]);
    }
    if (type === "hash") {
        const values = await client.hgetall(key);
        return JSON.stringify([type, Object.entries(values).sort(([a], [b]) => a.localeCompare(b))]);
    }
    if (type === "list") {
        return JSON.stringify([type, await client.lrange(key, 0, -1)]);
    }
    if (type === "set") {
        return JSON.stringify([type, (await client.smembers(key)).sort()]);
    }
    if (type === "zset") {
        return JSON.stringify([type, await client.zrange(key, 0, -1, "WITHSCORES")]);
    }
    if (type === "stream") {
        return JSON.stringify([type, await client.xrange(key, "-", "+")]);
    }
    return JSON.stringify([type]);
}

async function copySourceToTarget() {
    const sourceKeys = await scanKeys(source);
    const sourceKeySet = new Set(sourceKeys);

    for (const key of sourceKeys) {
        const [dump, ttlMs] = await Promise.all([
            source.callBuffer("DUMP", key) as Promise<Buffer | null>,
            source.pttl(key),
        ]);
        if (!dump || ttlMs === -2) {
            continue;
        }
        await target.restore(key, Math.max(ttlMs, 0), dump, "REPLACE");
    }

    for (const key of await scanKeys(target)) {
        if (!sourceKeySet.has(key) && !(await source.exists(key))) {
            await target.del(key);
        }
    }
}

async function compare(): Promise<string[]> {
    const [sourceKeys, targetKeys] = await Promise.all([scanKeys(source), scanKeys(target)]);
    const allKeys = [...new Set([...sourceKeys, ...targetKeys])].sort();
    const differences: string[] = [];

    for (const key of allKeys) {
        const [sourceExists, targetExists] = await Promise.all([
            source.exists(key),
            target.exists(key),
        ]);
        if (sourceExists !== targetExists) {
            differences.push(`${key}: existence differs`);
            continue;
        }
        if (!sourceExists) {
            continue;
        }

        const [sourceValue, targetValue, sourceTtl, targetTtl] = await Promise.all([
            canonicalValue(source, key),
            canonicalValue(target, key),
            source.pttl(key),
            target.pttl(key),
        ]);
        if (sourceValue !== targetValue) {
            differences.push(`${key}: value differs`);
        }

        const bothPersistent = sourceTtl === -1 && targetTtl === -1;
        if (!bothPersistent && Math.abs(sourceTtl - targetTtl) > ttlToleranceMs) {
            differences.push(`${key}: TTL differs (${sourceTtl}ms vs ${targetTtl}ms)`);
        }
    }

    return differences;
}

try {
    if (mode === "copy") {
        await copySourceToTarget();
    }

    const differences = await compare();
    if (differences.length > 0) {
        console.error(`Redis parity check failed with ${differences.length} difference(s):`);
        for (const difference of differences) {
            console.error(`- ${difference}`);
        }
        process.exitCode = 1;
    } else {
        console.log(`Redis parity check passed (${(await scanKeys(source)).length} keys)`);
    }
} finally {
    await Promise.all([source.quit(), target.quit()]);
}
