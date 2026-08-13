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

    test("turns the deployment-owned URL into the __pcn preset", () => {
        expect(proxyPreset(
            "IN",
            "browser-42",
            "https://customer-country-{{country}}:secret@brd.superproxy.io:33335/",
        )).toEqual({
            value: {
                host: "brd.superproxy.io",
                port: 33335,
                username: "customer-country-in-session-browser42",
                password: "secret",
                bypassList: ["localhost", "127.0.0.1", "[::1]"],
            },
        });
    });
});
