import { describe, expect, test } from "bun:test";
import { normalizeExpiresAt, routeTtlSeconds } from "./session-ttl";

describe("pool manager session ttl helpers", () => {
    test("normalizes valid expiresAt values", () => {
        expect(normalizeExpiresAt("2026-05-26T12:30:00.000Z")).toBe("2026-05-26T12:30:00.000Z");
        expect(normalizeExpiresAt("invalid")).toBeUndefined();
        expect(normalizeExpiresAt(123)).toBeUndefined();
    });

    test("calculates route ttl seconds from expiresAt", () => {
        const now = Date.parse("2026-05-26T12:00:00.000Z");
        expect(routeTtlSeconds(undefined, now)).toBe(86400);
        expect(routeTtlSeconds("2026-05-26T12:01:00.000Z", now)).toBe(60);
        expect(routeTtlSeconds("2026-05-26T11:59:00.000Z", now)).toBe(1);
    });
});
