import { describe, expect, test } from "bun:test";
import { proxyExitTimezone, proxyPreset, readSessionProxy } from "./session-proxy";

describe("session proxy request", () => {
    test("treats an omitted, null, or false proxy as direct egress", () => {
        expect(readSessionProxy({})).toEqual({ value: null });
        expect(readSessionProxy({ proxy: null })).toEqual({ value: null });
        expect(readSessionProxy({ proxy: false })).toEqual({ value: null });
    });

    test("accepts only an uppercase ISO country selection", () => {
        expect(readSessionProxy({ proxy: { country: "IN" } })).toEqual({ value: { country: "IN" } });
        expect(readSessionProxy({ proxy: { country: "in" } })).toEqual({ error: "proxy.country must be an uppercase ISO 3166-1 alpha-2 country code" });
        expect(readSessionProxy({ proxy: { country: "ZZ" } })).toEqual({ error: "proxy.country must be an uppercase ISO 3166-1 alpha-2 country code" });
        expect(readSessionProxy({ proxy: { country: "IN", host: "untrusted" } })).toEqual({ error: "proxy must be false or an object containing only proxy.country" });
    });

    test("preserves an HTTPS proxy scheme in the __pcn preset", () => {
        expect(proxyPreset(
            "IN",
            "browser-42",
            "https://customer-country-{{country}}:secret@brd.superproxy.io:33335/",
        )).toEqual({
            value: {
                host: "brd.superproxy.io",
                port: 33335,
                scheme: "https",
                username: "customer-country-in-session-6f025d8950fdd146e10c249de68adec9",
                password: "secret",
                bypassList: ["localhost", "127.0.0.1", "[::1]"],
            },
        });
    });

    test("preserves an HTTP proxy scheme and its default port", () => {
        expect(proxyPreset(
            "US",
            "browser-42",
            "http://customer-country-{{country}}:secret@proxy.example/",
        )).toEqual({
            value: {
                host: "proxy.example",
                port: 80,
                scheme: "http",
                username: "customer-country-us-session-6f025d8950fdd146e10c249de68adec9",
                password: "secret",
                bypassList: ["localhost", "127.0.0.1", "[::1]"],
            },
        });
    });

    test("rejects a proxy URL that the sidecar cannot reproduce", () => {
        expect(proxyPreset("IN", "browser", "http://user-{{country}}:pass@proxy.example/path")).toHaveProperty("error");
    });

    test("hashes the complete session ID for collision-resistant stickiness", () => {
        const proxyUrl = "https://user-{{country}}:secret@proxy.example/";
        const punctuated = proxyPreset("IN", "browser-42", proxyUrl);
        const compact = proxyPreset("IN", "browser42", proxyUrl);
        const longAlpha = proxyPreset("IN", "browser-42-with-a-very-long-shared-prefix-alpha", proxyUrl);
        const longBeta = proxyPreset("IN", "browser-42-with-a-very-long-shared-prefix-beta", proxyUrl);

        expect("value" in punctuated && punctuated.value.username).toBe("user-in-session-6f025d8950fdd146e10c249de68adec9");
        expect("value" in compact && compact.value.username).toBe("user-in-session-8640634d321680d079261802d170c57d");
        expect("value" in longAlpha && longAlpha.value.username).toBe("user-in-session-5517d212fa3555e05508661fa18f6709");
        expect("value" in longBeta && longBeta.value.username).toBe("user-in-session-0132d37a8686d1cf85ae5f8425d36a25");
    });
});


test("malformed deployment proxy credentials return a configuration error", () => {
    expect(proxyPreset("IN", "browser", "https://user-{{country}}%GG:secret@proxy.example/")).toHaveProperty("error");
    expect(proxyPreset("IN", "browser", "https://user-{{country}}:secret%GG@proxy.example/")).toHaveProperty("error");
});

test("an uppercase placeholder keeps the ISO country case", () => {
    const preset = proxyPreset("US", "browser", "http://username-acct-country-{{COUNTRY}}:secret@proxy.example:80");
    expect(preset).toHaveProperty("value.username", expect.stringMatching(/^username-acct-country-US-session-[0-9a-f]{32}$/));
});

describe("proxy exit timezone", () => {
    const config = { host: "proxy.example", port: 22225, scheme: "http" as const, username: "user-session-abc", password: "p@ss", bypassList: [] };

    test("asks a geo service through the session's proxy", async () => {
        const calls: Array<{ url: string; proxy?: string }> = [];
        const fetchImpl = (async (url: string, init: any) => {
            calls.push({ url, proxy: init.proxy });
            return Response.json({ timezone: { id: "America/Los_Angeles" } });
        }) as unknown as typeof fetch;
        expect(await proxyExitTimezone("US", config, fetchImpl)).toBe("America/Los_Angeles");
        expect(calls).toEqual([{ url: "https://ipwho.is/", proxy: "http://user-session-abc:p%40ss@proxy.example:22225" }]);
    });

    test("falls back to the next service, then the country's zone, else none", async () => {
        const second = (async (url: string) => {
            let isIpwho = false;
            try {
                isIpwho = new URL(url).origin === "https://ipwho.is";
            } catch {
                isIpwho = false;
            }
            return isIpwho
                ? new Response("busy", { status: 429 })
                : Response.json({ timezone: "America/Chicago" });
        }) as unknown as typeof fetch;
        expect(await proxyExitTimezone("US", config, second)).toBe("America/Chicago");

        const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
        expect(await proxyExitTimezone("DE", config, failing)).toBe("Europe/Berlin");
        expect(await proxyExitTimezone("KE", config, failing)).toBeUndefined();
    });

    test("ignores a malformed answer", async () => {
        const fetchImpl = (async () => Response.json({ timezone: { id: "\"};rm -rf" } })) as unknown as typeof fetch;
        expect(await proxyExitTimezone("JP", config, fetchImpl)).toBe("Asia/Tokyo");
    });
});
