import { describe, expect, test } from "bun:test";
import {
    readSessionAccessRequest,
    sessionAccessFields,
    storedSessionAccess,
    storedSessionTokenExpiresAt,
} from "./session-access";

describe("generic session access contract", () => {
    test("normalizes a route-bound automation policy", () => {
        const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
        const result = readSessionAccessRequest({
            tokenExpiresAt: expiresAt,
            accessPolicy: {
                tokenMode: "route-bound",
                cdpScope: "automation",
                accessExpiresAt: expiresAt,
            },
        }, expiresAt);

        expect(result).toEqual({
            value: {
                tokenExpiresAt: expiresAt,
                accessPolicy: {
                    tokenMode: "route-bound",
                    cdpScope: "automation",
                    accessExpiresAt: expiresAt,
                },
            },
        });
    });

    test("rejects retired x402-specific aliases", () => {
        const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
        expect(readSessionAccessRequest({ restrictedTokenExpiresAt: expiresAt }, expiresAt).error)
            .toContain("Unsupported session access fields");
        expect(readSessionAccessRequest({ automationProfile: "x402-agent" }, expiresAt).error)
            .toContain("Unsupported session access fields");
        expect(readSessionAccessRequest({ publicAccessExpiresAt: expiresAt }, expiresAt).error)
            .toContain("Unsupported session access fields");
    });

    test("validates policy and deadline combinations", () => {
        const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
        expect(readSessionAccessRequest({
            accessPolicy: {
                tokenMode: "route-bound",
                cdpScope: "automation",
            },
        }, expiresAt).error).toContain("requires accessExpiresAt");
        expect(readSessionAccessRequest({
            accessPolicy: {
                tokenMode: "expiring",
                cdpScope: "restricted",
                accessExpiresAt: expiresAt,
            },
        }, expiresAt).error).toContain("cannot set accessExpiresAt");
    });

    test("stores only generic access fields", () => {
        const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
        const policy = {
            tokenMode: "route-bound" as const,
            cdpScope: "automation" as const,
            accessExpiresAt: expiresAt,
        };
        const fields = sessionAccessFields(expiresAt, policy);
        expect(fields).toEqual({
            tokenExpiresAt: expiresAt,
            accessExpiresAt: expiresAt,
            accessPolicy: policy,
        });
        expect(storedSessionAccess(fields)).toEqual(policy);
        expect(storedSessionTokenExpiresAt(fields)).toBe(expiresAt);
    });

    test("keeps ordinary sessions on expiring restricted access", () => {
        expect(readSessionAccessRequest({}, undefined)).toEqual({
            value: {
                tokenExpiresAt: undefined,
                accessPolicy: { tokenMode: "expiring", cdpScope: "restricted" },
            },
        });
    });
});
