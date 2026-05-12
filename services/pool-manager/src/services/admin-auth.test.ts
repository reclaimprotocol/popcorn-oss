import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
    authorizeGoogleUser,
    createAdminSession,
    isAdminAuthPath,
    isGoogleOAuthConfigured,
    isPasswordLoginConfigured,
    isSameOriginAdminRequest,
    parseBasicAuth,
    parseHtpasswd,
    readAdminAuthConfig,
    verifyAdminPassword,
    verifyAdminSession,
} from "./admin-auth";

describe("admin auth", () => {
    test("parses Basic credentials", () => {
        const encoded = Buffer.from("admin:s3cret").toString("base64");
        expect(parseBasicAuth(`Basic ${encoded}`)).toEqual({
            username: "admin",
            password: "s3cret",
        });
        expect(parseBasicAuth("Bearer client:secret")).toBeNull();
    });

    test("treats login support routes as public admin auth paths", () => {
        expect(isAdminAuthPath("/admin/login")).toBe(true);
        expect(isAdminAuthPath("/admin/auth/config")).toBe(true);
        expect(isAdminAuthPath("/admin/auth/google/callback")).toBe(true);
        expect(isAdminAuthPath("/admin/servers")).toBe(false);
    });

    test("checks same-origin admin requests through forwarded gateway headers", () => {
        const request = new Request("http://pool-manager.default.svc/admin/session", {
            method: "POST",
            headers: {
                Origin: "https://gateway.example.com",
                "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": "gateway.example.com",
            },
        });

        expect(isSameOriginAdminRequest(request)).toBe(true);
        expect(isSameOriginAdminRequest(new Request("http://pool-manager/admin/session", {
            method: "POST",
            headers: { Origin: "https://evil.example.com" },
        }))).toBe(false);
    });

    test("allows port-variant forwarded hosts as same-site for admin requests", () => {
        expect(isSameOriginAdminRequest(new Request("http://pool-manager.default.svc:3000/admin/session", {
            method: "POST",
            headers: {
                Origin: "https://gateway.example.com",
                "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": "gateway.example.com:8443",
            },
        }))).toBe(true);
    });

    test("allows secure-origin requests when proxy terminates TLS and forwards internal HTTP", () => {
        expect(isSameOriginAdminRequest(new Request("http://pool-manager.default.svc/admin/session", {
            method: "POST",
            headers: {
                Origin: "https://pool-manager-gateway.example.com",
                Referer: "https://pool-manager-gateway.example.com/admin/session",
                "X-Forwarded-Proto": "http",
                Host: "pool-manager-gateway.example.com",
            },
        }))).toBe(true);
    });

    test("parses htpasswd bcrypt users and ignores unsupported hashes", () => {
        const users = parseHtpasswd(`
# comment
admin:$2b$10$abcdefghijklmnopqrstuuuqLDBa9UzvFjJx4S5K1VKvLtN0ftae
legacy:{SHA}unsupported
        `);

        expect(users.get("admin")).toStartWith("$2b$");
        expect(users.has("legacy")).toBe(false);
    });

    test("verifies legacy env credentials", async () => {
        const config = readAdminAuthConfig({
            ADMIN_USER: "admin",
            ADMIN_PASS: "admin-pass",
            ADMIN_SESSION_SECRET: "test-secret",
        });

        expect(await verifyAdminPassword("admin", "admin-pass", config)).toBe(true);
        expect(await verifyAdminPassword("admin", "wrong", config)).toBe(false);
    });

    test("does not invent a random admin session secret", () => {
        const passwordFileOnly = readAdminAuthConfig({
            ADMIN_AUTH_STRATEGIES: "password,google",
            ADMIN_PASSWORD_FILE: "/tmp/admin.htpasswd",
            ADMIN_GOOGLE_CLIENT_ID: "client",
            ADMIN_GOOGLE_CLIENT_SECRET: "secret",
            ADMIN_GOOGLE_REDIRECT_URI: "https://example.com/admin/auth/google/callback",
            ADMIN_GOOGLE_ALLOWED_DOMAINS: "example.com",
        });

        expect(passwordFileOnly.sessionSecret).toBeUndefined();
        expect(isPasswordLoginConfigured(passwordFileOnly)).toBe(false);
        expect(isGoogleOAuthConfigured(passwordFileOnly)).toBe(false);
    });

    test("verifies htpasswd bcrypt credentials", async () => {
        const dir = mkdtempSync(join(tmpdir(), "popcorn-admin-auth-"));
        const passwordFile = join(dir, "admin.htpasswd");
        const hash = await Bun.password.hash("file-pass", {
            algorithm: "bcrypt",
            cost: 4,
        });
        writeFileSync(passwordFile, `file-admin:${hash}\n`);

        const config = readAdminAuthConfig({
            ADMIN_PASSWORD_FILE: passwordFile,
            ADMIN_SESSION_SECRET: "test-secret",
        });

        expect(await verifyAdminPassword("file-admin", "file-pass", config)).toBe(true);
        expect(await verifyAdminPassword("file-admin", "wrong", config)).toBe(false);
    });

    test("signs and verifies admin sessions", () => {
        const config = readAdminAuthConfig({
            ADMIN_SESSION_SECRET: "test-secret",
            ADMIN_SESSION_TTL_SECONDS: "60",
        });

        const session = createAdminSession({
            id: "admin",
            displayName: "Admin",
            strategy: "password",
        }, config, 1000);

        expect(verifyAdminSession(session, config, 2000)).toEqual({
            id: "admin",
            displayName: "Admin",
            strategy: "password",
        });
        expect(verifyAdminSession(`${session}tampered`, config, 2000)).toBeNull();
        expect(verifyAdminSession(session, config, 62000)).toBeNull();
    });

    test("authorizes Google users by email or domain", () => {
        const config = readAdminAuthConfig({
            ADMIN_AUTH_STRATEGIES: "google",
            ADMIN_SESSION_SECRET: "test-secret",
            ADMIN_GOOGLE_ALLOWED_EMAILS: "person@example.com",
            ADMIN_GOOGLE_ALLOWED_DOMAINS: "example.com",
        });

        expect(authorizeGoogleUser({
            email: "person@example.com",
            email_verified: true,
        }, config)?.id).toBe("person@example.com");

        expect(authorizeGoogleUser({
            email: "admin@example.com",
            email_verified: "true",
        }, config)?.id).toBe("admin@example.com");

        expect(authorizeGoogleUser({
            email: "outsider@example.net",
            email_verified: true,
        }, config)).toBeNull();

        expect(authorizeGoogleUser({
            email: "admin@example.com",
            email_verified: false,
        }, config)).toBeNull();
    });
});
