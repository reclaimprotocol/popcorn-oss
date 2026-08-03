import { describe, expect, test } from "bun:test";
import jwt from "jsonwebtoken";
import { Auth } from "./auth";

describe("gateway session tokens", () => {
    test("keeps x402 route-bound URLs stable without changing ordinary client tokens", () => {
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        const first = Auth.signToken("x402_session", "restricted", expiresAt, true);
        const second = Auth.signToken("x402_session", "restricted", new Date(Date.now() + 15 * 60 * 1000).toISOString(), true);
        expect(second).toBe(first);

        const routeBound = jwt.decode(first) as Record<string, unknown>;
        expect(routeBound).toMatchObject({ sub: "x402_session", scope: "restricted", routeBound: true });
        expect(routeBound.exp).toBeUndefined();
        expect(routeBound.iat).toBeUndefined();

        const ordinary = jwt.decode(Auth.signToken("client_session", "restricted", expiresAt)) as Record<string, unknown>;
        expect(typeof ordinary.exp).toBe("number");
        expect(ordinary.routeBound).toBeUndefined();
    });
});
