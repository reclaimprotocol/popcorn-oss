import { describe, expect, test } from "bun:test";
import { buildSessionUrls, websocketBaseUrl } from "./session-urls";

describe("session LiveView URLs", () => {
    test("returns usable HTTP and WS URLs for the local OSS gateway", () => {
        const urls = buildSessionUrls({
            baseUrl: "http://localhost:8080",
            browserPodId: "browser-fleet-local",
            sessionId: "local-session",
            restrictedToken: "restricted.jwt",
            internalToken: "internal.jwt",
        });
        expect(urls).toMatchObject({
            url: "http://localhost:8080/liveview/local-session/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000",
            vncUrl: "http://localhost:8080/liveview/local-session/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000",
            vncWsUrl: "ws://localhost:8080/liveview-ws/local-session/restricted.jwt",
        });
        expect(urls).not.toHaveProperty("e2eRfbUrl");
        expect(urls).not.toHaveProperty("e2eControlUrl");
    });

    test("returns HTTPS and WSS URLs for a multi-region public gateway", () => {
        expect(buildSessionUrls({
            baseUrl: "https://gateway.us.example/base/",
            browserPodId: "browser-fleet-prod",
            sessionId: "regional-session",
            restrictedToken: "restricted.jwt",
            automationToken: "automation.jwt",
            internalToken: "internal.jwt",
            includeE2e: true,
        })).toMatchObject({
            url: "https://gateway.us.example/base/liveview/regional-session/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000&encryption=e2e",
            vncUrl: "https://gateway.us.example/base/liveview/regional-session/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000&encryption=e2e",
            vncWsUrl: "wss://gateway.us.example/base/liveview-ws/regional-session/restricted.jwt",
            e2eRfbUrl: "wss://gateway.us.example/base/liveview-e2e-rfb/regional-session/restricted.jwt",
            e2eControlUrl: "wss://gateway.us.example/base/liveview-e2e-control/regional-session/restricted.jwt",
            cdpUrl: "wss://gateway.us.example/base/cdp-agent/regional-session/automation.jwt/",
        });
    });

    test("selects E2EE in both unified LiveView URL aliases", () => {
        const urls = buildSessionUrls({
            baseUrl: "https://gateway.example",
            browserPodId: "browser-1",
            sessionId: "session-1",
            restrictedToken: "restricted.jwt",
            internalToken: "internal.jwt",
            includeE2e: true,
        });
        expect(urls.url).toEndWith("?resize=scale&reconnect=1&reconnect_delay=2000&encryption=e2e");
        expect(urls.vncUrl).toBe(urls.url);
        expect(urls.e2eRfbUrl).toStartWith("wss://gateway.example/liveview-e2e-rfb/");
    });

    test("rejects non-HTTP gateway schemes", () => {
        expect(() => websocketBaseUrl("ftp://gateway.example")).toThrow();
    });
});
