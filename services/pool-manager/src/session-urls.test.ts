import { describe, expect, test } from "bun:test";
import { buildSessionUrls, websocketBaseUrl } from "./session-urls";

describe("session LiveView URLs", () => {
    test("returns usable HTTP and WS URLs for the local OSS gateway", () => {
        expect(buildSessionUrls({
            baseUrl: "http://localhost:8080",
            browserPodId: "browser-fleet-local",
            sessionId: "local-session",
            restrictedToken: "restricted.jwt",
            internalToken: "internal.jwt",
        })).toMatchObject({
            url: "http://localhost:8080/liveview/local-session/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000",
            vncUrl: "http://localhost:8080/liveview/local-session/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000",
            vncWsUrl: "ws://localhost:8080/liveview-ws/local-session/restricted.jwt",
        });
    });

    test("returns HTTPS and WSS URLs for a multi-region public gateway", () => {
        expect(buildSessionUrls({
            baseUrl: "https://gateway.us.example/base/",
            browserPodId: "browser-fleet-prod",
            sessionId: "regional-session",
            restrictedToken: "restricted.jwt",
            automationToken: "automation.jwt",
            internalToken: "internal.jwt",
        })).toMatchObject({
            url: "https://gateway.us.example/base/liveview/regional-session/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000",
            vncUrl: "https://gateway.us.example/base/liveview/regional-session/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000",
            vncWsUrl: "wss://gateway.us.example/base/liveview-ws/regional-session/restricted.jwt",
            cdpUrl: "wss://gateway.us.example/base/cdp-agent/regional-session/automation.jwt/",
        });
    });

    test("rejects non-HTTP gateway schemes", () => {
        expect(() => websocketBaseUrl("ftp://gateway.example")).toThrow();
    });
});
