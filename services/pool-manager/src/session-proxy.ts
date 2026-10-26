import { createHash } from "node:crypto";

export type SessionProxy = { country: string } | null;

const ISO_COUNTRY_CODES = new Set((
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
    "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
    "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
    "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" "));

function isIsoCountry(value: unknown): value is string {
    return typeof value === "string" && ISO_COUNTRY_CODES.has(value.trim());
}

/** The public API can choose an exit country, never an arbitrary proxy URL. */
export function readSessionProxy(body: unknown): { value: SessionProxy } | { error: string } {
    const proxy = (body as any)?.proxy;
    if (proxy === undefined || proxy === null || proxy === false) return { value: null };
    if (!proxy || typeof proxy !== "object" || Array.isArray(proxy)
        || Object.keys(proxy).length !== 1 || !("country" in proxy)) {
        return { error: "proxy must be false or an object containing only proxy.country" };
    }
    const country = proxy.country;
    if (!isIsoCountry(country)) {
        return { error: "proxy.country must be an uppercase ISO 3166-1 alpha-2 country code" };
    }
    return { value: { country: country.trim() } };
}

export type ExtensionProxyConfig = {
    host: string;
    port: number;
    scheme: "http" | "https";
    username?: string;
    password?: string;
    bypassList: string[];
};

/** Expands the deployment-owned provider URL into the existing __pcn.set shape. */
export function proxyPreset(country: string, sessionId: string, raw = process.env.HTTPS_PROXY_URL || ""):
    { value: ExtensionProxyConfig } | { error: string } {
    if (!raw) return { error: "proxy is not configured for this deployment" };
    if (!raw.includes("{{country}}") && !raw.includes("{{COUNTRY}}") && !raw.includes("{{geoLocation}}")) {
        return { error: "HTTPS_PROXY_URL must include {{country}}, {{COUNTRY}} or {{geoLocation}}" };
    }
    // {{country}} is lowercase (Bright Data); {{COUNTRY}} keeps the ISO case
    // for providers such as Grass that ignore a lowercase code.
    const expanded = raw.trim()
        .replaceAll("{{COUNTRY}}", country.toUpperCase())
        .replaceAll("{{country}}", country.toLowerCase())
        .replaceAll("{{geoLocation}}", country.toLowerCase());
    if (/\{\{[^}]+\}\}/.test(expanded)) return { error: "HTTPS_PROXY_URL contains an unsupported template" };
    let url: URL;
    try { url = new URL(expanded); } catch { return { error: "HTTPS_PROXY_URL is invalid" }; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "HTTPS_PROXY_URL must use http or https" };
    if (!url.hostname) return { error: "HTTPS_PROXY_URL must include a host" };
    if (url.pathname !== "/" || url.search || url.hash) return { error: "HTTPS_PROXY_URL must not include a path, query or fragment" };
    let username: string;
    let password: string;
    try {
        username = decodeURIComponent(url.username);
        password = decodeURIComponent(url.password);
    } catch {
        return { error: "HTTPS_PROXY_URL credentials contain invalid percent encoding" };
    }
    if ((username && !password) || (!username && password)) return { error: "HTTPS_PROXY_URL must include both username and password" };
    // Keep the selected upstream exit sticky for this browser session.
    const stickyId = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "HTTPS_PROXY_URL has an invalid port" };
    return {
        value: {
            host: url.hostname,
            port,
            scheme: url.protocol === "https:" ? "https" : "http",
            ...(username ? { username: `${username}-session-${stickyId}`, password } : {}),
            bypassList: ["localhost", "127.0.0.1", "[::1]"],
        },
    };
}

// Used when no geo service answers. A country spanning several zones gets its
// most populous one. A country missing here gets no timezone rather than a
// guessed one.
const COUNTRY_TIMEZONES: Record<string, string> = {
    US: "America/New_York", CA: "America/Toronto", MX: "America/Mexico_City",
    BR: "America/Sao_Paulo", AR: "America/Argentina/Buenos_Aires", CL: "America/Santiago", CO: "America/Bogota",
    GB: "Europe/London", IE: "Europe/Dublin", DE: "Europe/Berlin", FR: "Europe/Paris", ES: "Europe/Madrid",
    IT: "Europe/Rome", NL: "Europe/Amsterdam", BE: "Europe/Brussels", PL: "Europe/Warsaw", PT: "Europe/Lisbon",
    RO: "Europe/Bucharest", RU: "Europe/Moscow", UA: "Europe/Kyiv", TR: "Europe/Istanbul", GR: "Europe/Athens",
    CZ: "Europe/Prague", HU: "Europe/Budapest", SE: "Europe/Stockholm", FI: "Europe/Helsinki",
    NO: "Europe/Oslo", DK: "Europe/Copenhagen", CH: "Europe/Zurich", AT: "Europe/Vienna",
    AU: "Australia/Sydney", NZ: "Pacific/Auckland", ZA: "Africa/Johannesburg", NG: "Africa/Lagos", EG: "Africa/Cairo",
    IN: "Asia/Kolkata", PK: "Asia/Karachi", BD: "Asia/Dhaka", ID: "Asia/Jakarta", MY: "Asia/Kuala_Lumpur",
    SG: "Asia/Singapore", TH: "Asia/Bangkok", VN: "Asia/Ho_Chi_Minh", PH: "Asia/Manila",
    CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", TW: "Asia/Taipei", JP: "Asia/Tokyo", KR: "Asia/Seoul",
    IL: "Asia/Jerusalem", SA: "Asia/Riyadh", AE: "Asia/Dubai",
};

const TIMEZONE = /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/;

/**
 * The timezone of the proxy's exit for this session. The session's sticky
 * username keeps the browser on the same exit, so a site comparing the
 * browser clock with its IP sees the zone it expects. Undefined when neither
 * a geo service nor the country table knows it; the browser then keeps its
 * own zone.
 */
export async function proxyExitTimezone(country: string, config: ExtensionProxyConfig, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
    const auth = config.username ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password ?? "")}@` : "";
    const proxy = `${config.scheme}://${auth}${config.host}:${config.port}`;
    const services: Array<[string, (body: any) => unknown]> = [
        ["https://ipwho.is/", (body) => body?.timezone?.id],
        ["http://ip-api.com/json/?fields=timezone", (body) => body?.timezone],
    ];
    for (const [url, read] of services) {
        try {
            const response = await fetchImpl(url, { proxy, signal: AbortSignal.timeout(4_000) } as RequestInit);
            if (!response.ok) continue;
            const timezone = read(await response.json());
            if (typeof timezone === "string" && TIMEZONE.test(timezone)) return timezone;
        } catch {
            // Try the next service, then the country's zone.
        }
    }
    return COUNTRY_TIMEZONES[country];
}
