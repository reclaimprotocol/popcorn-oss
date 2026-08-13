import { describe, expect, test } from "bun:test";
import { proxyPreset, readSessionProxy } from "./session-proxy";

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
