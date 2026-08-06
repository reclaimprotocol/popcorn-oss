import { describe, expect, test } from "bun:test";
import { browserRoutePort } from "./allocation-port";

describe("browser allocation route port", () => {
    test("selects the named noVNC port instead of relying on allocation order", () => {
        expect(browserRoutePort([
            { name: "cdp", port: 9222 },
            { name: "novnc", port: 6080 },
        ])).toBe(6080);
    });

    test("uses the fixed VNC port when the allocation omits the named port", () => {
        expect(browserRoutePort([{ name: "unknown", port: 1234 }])).toBe(6080);
        expect(browserRoutePort(undefined)).toBe(6080);
    });
});
