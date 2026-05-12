import { existsSync, readFileSync } from "fs";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const BASIC_PREFIX = /^Basic\s+(.+)$/i;
const BEARER_PREFIX = /^Bearer\s+/i;
const BCRYPT_PREFIX = /^\$2[aby]\$/;

export const ADMIN_SESSION_COOKIE = "popcorn_admin_session";
export const ADMIN_OAUTH_STATE_COOKIE = "popcorn_admin_oauth_state";

export interface AdminIdentity {
    id: string;
    displayName: string;
    strategy: "password" | "google";
}

export interface AdminAuthConfig {
    strategies: Set<string>;
    passwordFile?: string;
    legacyUser?: string;
    legacyPass?: string;
    sessionSecret?: string;
    sessionTtlSeconds: number;
    googleClientId?: string;
    googleClientSecret?: string;
    googleRedirectUri?: string;
    googleAllowedEmails: Set<string>;
    googleAllowedDomains: Set<string>;
}

interface AdminSessionPayload extends AdminIdentity {
    exp: number;
}

export interface GoogleUserInfo {
    email?: string;
    email_verified?: boolean | string;
    name?: string;
    sub?: string;
    hd?: string;
}

export function readAdminAuthConfig(env: Record<string, string | undefined> = process.env): AdminAuthConfig {
    const strategies = new Set(
        (env.ADMIN_AUTH_STRATEGIES || "password")
            .split(",")
            .map((strategy) => strategy.trim().toLowerCase())
            .filter(Boolean)
    );

    return {
        strategies,
        passwordFile: env.ADMIN_PASSWORD_FILE?.trim() || undefined,
        legacyUser: env.ADMIN_USER?.trim() || undefined,
        legacyPass: env.ADMIN_PASS?.trim() || undefined,
        sessionSecret: env.ADMIN_SESSION_SECRET?.trim() || env.ADMIN_PASS?.trim() || undefined,
        sessionTtlSeconds: readPositiveInteger(env.ADMIN_SESSION_TTL_SECONDS, 12 * 60 * 60),
        googleClientId: env.ADMIN_GOOGLE_CLIENT_ID?.trim() || undefined,
        googleClientSecret: env.ADMIN_GOOGLE_CLIENT_SECRET?.trim() || undefined,
        googleRedirectUri: env.ADMIN_GOOGLE_REDIRECT_URI?.trim() || undefined,
        googleAllowedEmails: readCsvSet(env.ADMIN_GOOGLE_ALLOWED_EMAILS, (value) => value.toLowerCase()),
        googleAllowedDomains: readCsvSet(env.ADMIN_GOOGLE_ALLOWED_DOMAINS, normalizeDomain),
    };
}

export function isAdminAuthPath(path: string): boolean {
    return path === "/admin/login"
        || path === "/admin/auth/config"
        || path === "/admin/auth/password"
        || path === "/admin/auth/google"
        || path === "/admin/auth/google/callback"
        || path === "/admin/logout";
}

export function wantsHtml(headers: Headers): boolean {
    return headers.get("Accept")?.includes("text/html") || false;
}

export function isSameOriginAdminRequest(request: Request): boolean {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
        return true;
    }

    const origin = request.headers.get("Origin");
    const referer = request.headers.get("Referer");
    const url = new URL(request.url);
    const forwardedProto = request.headers.get("X-Forwarded-Proto")?.split(",")[0]?.trim();
    const forwardedHost = request.headers.get("X-Forwarded-Host")?.split(",")[0]?.trim();
    const protocol = forwardedProto ? `${forwardedProto}:` : url.protocol;
    const host = forwardedHost || url.host;
    const expectedOrigin = `${protocol}//${host}`;

    if (origin) {
        return origin === expectedOrigin;
    }
    if (referer) {
        try {
            return new URL(referer).origin === expectedOrigin;
        } catch {
            return false;
        }
    }

    return false;
}

export function parseBasicAuth(header?: string | null): { username: string; password: string } | null {
    if (!header || BEARER_PREFIX.test(header)) return null;

    const match = header.match(BASIC_PREFIX);
    if (!match) return null;

    try {
        const decoded = Buffer.from(match[1], "base64").toString("utf8");
        const separator = decoded.indexOf(":");
        if (separator <= 0) return null;
        return {
            username: decoded.slice(0, separator),
            password: decoded.slice(separator + 1),
        };
    } catch {
        return null;
    }
}

export function parseHtpasswd(content: string): Map<string, string> {
    const users = new Map<string, string>();

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;

        const separator = line.indexOf(":");
        if (separator <= 0) continue;

        const username = line.slice(0, separator).trim();
        const hash = line.slice(separator + 1).trim();
        if (username && BCRYPT_PREFIX.test(hash)) {
            users.set(username, hash);
        }
    }

    return users;
}

export async function verifyAdminPassword(username: string, password: string, config: AdminAuthConfig): Promise<boolean> {
    if (!config.strategies.has("password")) {
        return false;
    }

    const passwordUsers = readPasswordUsers(config.passwordFile);
    const hash = passwordUsers.get(username);
    if (hash && await Bun.password.verify(password, hash)) {
        return true;
    }

    return constantTimeEqual(username, config.legacyUser) && constantTimeEqual(password, config.legacyPass);
}

export async function authenticateBasicAdmin(header: string | undefined, config: AdminAuthConfig): Promise<AdminIdentity | null> {
    const credentials = parseBasicAuth(header);
    if (!credentials) return null;

    const valid = await verifyAdminPassword(credentials.username, credentials.password, config);
    if (!valid) return null;

    return {
        id: credentials.username,
        displayName: credentials.username,
        strategy: "password",
    };
}

export function createAdminSession(identity: AdminIdentity, config: AdminAuthConfig, now = Date.now()): string {
    if (!config.sessionSecret) {
        throw new Error("ADMIN_SESSION_SECRET is required for browser admin login");
    }

    const payload: AdminSessionPayload = {
        ...identity,
        exp: now + config.sessionTtlSeconds * 1000,
    };
    const encoded = base64UrlEncode(JSON.stringify(payload));
    return `${encoded}.${sign(encoded, config.sessionSecret)}`;
}

export function verifyAdminSession(cookie: string | undefined, config: AdminAuthConfig, now = Date.now()): AdminIdentity | null {
    if (!cookie || !config.sessionSecret) return null;

    const [encoded, signature] = cookie.split(".");
    if (!encoded || !signature || !constantTimeEqual(signature, sign(encoded, config.sessionSecret))) {
        return null;
    }

    try {
        const payload = JSON.parse(base64UrlDecode(encoded)) as AdminSessionPayload;
        if (!payload.id || !payload.displayName || !payload.strategy || !payload.exp || payload.exp < now) {
            return null;
        }
        return {
            id: payload.id,
            displayName: payload.displayName,
            strategy: payload.strategy,
        };
    } catch {
        return null;
    }
}

export function createOauthState(config: AdminAuthConfig): string {
    if (!config.sessionSecret) {
        throw new Error("ADMIN_SESSION_SECRET is required for browser admin login");
    }
    const nonce = randomBytes(24).toString("base64url");
    return `${nonce}.${sign(nonce, config.sessionSecret)}`;
}

export function verifyOauthState(state: string | undefined, cookie: string | undefined, config: AdminAuthConfig): boolean {
    if (!state || !cookie || !config.sessionSecret || state !== cookie) return false;
    const [nonce, signature] = state.split(".");
    return Boolean(nonce && signature && constantTimeEqual(signature, sign(nonce, config.sessionSecret)));
}

export function isGoogleOAuthConfigured(config: AdminAuthConfig): boolean {
    return config.strategies.has("google")
        && Boolean(config.sessionSecret)
        && Boolean(config.googleClientId)
        && Boolean(config.googleClientSecret)
        && Boolean(config.googleRedirectUri)
        && (config.googleAllowedEmails.size > 0 || config.googleAllowedDomains.size > 0);
}

export function isPasswordLoginConfigured(config: AdminAuthConfig): boolean {
    return config.strategies.has("password") && Boolean(config.sessionSecret);
}

export function buildGoogleAuthorizationUrl(config: AdminAuthConfig, state: string): string {
    if (!config.googleClientId || !config.googleRedirectUri) {
        throw new Error("Google OAuth is not configured");
    }

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", config.googleClientId);
    url.searchParams.set("redirect_uri", config.googleRedirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "select_account");
    return url.toString();
}

export async function fetchGoogleUserInfo(code: string, config: AdminAuthConfig): Promise<GoogleUserInfo> {
    if (!config.googleClientId || !config.googleClientSecret || !config.googleRedirectUri) {
        throw new Error("Google OAuth is not configured");
    }

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: config.googleClientId,
            client_secret: config.googleClientSecret,
            redirect_uri: config.googleRedirectUri,
            grant_type: "authorization_code",
            code,
        }),
    });

    if (!tokenResponse.ok) {
        throw new Error(`Google token exchange failed with ${tokenResponse.status}`);
    }

    const tokenBody = await tokenResponse.json() as { access_token?: string };
    if (!tokenBody.access_token) {
        throw new Error("Google token exchange did not return an access token");
    }

    const userInfoResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    });

    if (!userInfoResponse.ok) {
        throw new Error(`Google userinfo failed with ${userInfoResponse.status}`);
    }

    return await userInfoResponse.json() as GoogleUserInfo;
}

export function authorizeGoogleUser(userInfo: GoogleUserInfo, config: AdminAuthConfig): AdminIdentity | null {
    const email = userInfo.email?.trim().toLowerCase();
    const emailVerified = userInfo.email_verified === true || userInfo.email_verified === "true";
    if (!email || !emailVerified) {
        return null;
    }

    const domain = normalizeDomain(email.split("@")[1] || userInfo.hd || "");
    const allowed = config.googleAllowedEmails.has(email) || (domain ? config.googleAllowedDomains.has(domain) : false);
    if (!allowed) {
        return null;
    }

    return {
        id: email,
        displayName: userInfo.name || email,
        strategy: "google",
    };
}

function readPasswordUsers(passwordFile?: string): Map<string, string> {
    if (!passwordFile || !existsSync(passwordFile)) {
        return new Map();
    }

    try {
        return parseHtpasswd(readFileSync(passwordFile, "utf8"));
    } catch (error) {
        console.error("Failed to read admin password file:", error);
        return new Map();
    }
}

function readCsvSet(value: string | undefined, normalize: (value: string) => string): Set<string> {
    return new Set(
        (value || "")
            .split(",")
            .map((item) => normalize(item.trim()))
            .filter(Boolean)
    );
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeDomain(value: string): string {
    return value.trim().toLowerCase().replace(/^@/, "");
}

function sign(value: string, secret: string): string {
    return createHmac("sha256", secret).update(value).digest("base64url");
}

function base64UrlEncode(value: string): string {
    return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
    return Buffer.from(value, "base64url").toString("utf8");
}

function constantTimeEqual(a: string | undefined, b: string | undefined): boolean {
    if (a === undefined || b === undefined) return false;
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}
