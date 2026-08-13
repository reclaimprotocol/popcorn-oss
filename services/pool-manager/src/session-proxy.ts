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
    username?: string;
    password?: string;
    bypassList: string[];
};

/** Expands the deployment-owned provider URL into the existing __pcn.set shape. */
export function proxyPreset(country: string, sessionId: string, raw = process.env.HTTPS_PROXY_URL || ""):
    { value: ExtensionProxyConfig } | { error: string } {
    if (!raw) return { error: "proxy is not configured for this deployment" };
    if (!raw.includes("{{country}}") && !raw.includes("{{geoLocation}}")) {
        return { error: "HTTPS_PROXY_URL must include {{country}} or {{geoLocation}}" };
    }
    const expanded = raw.trim()
        .replaceAll("{{country}}", country.toLowerCase())
        .replaceAll("{{geoLocation}}", country.toLowerCase());
    if (/\{\{[^}]+\}\}/.test(expanded)) return { error: "HTTPS_PROXY_URL contains an unsupported template" };
    let url: URL;
    try { url = new URL(expanded); } catch { return { error: "HTTPS_PROXY_URL is invalid" }; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "HTTPS_PROXY_URL must use http or https" };
    if (!url.hostname) return { error: "HTTPS_PROXY_URL must include a host" };
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if ((username && !password) || (!username && password)) return { error: "HTTPS_PROXY_URL must include both username and password" };
    // Keep the selected upstream exit sticky for this browser session.
    const stickyId = sessionId.replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 32);
    if (!stickyId) return { error: "session ID cannot be used for proxy stickiness" };
    return {
        value: {
            host: url.hostname,
            port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
            ...(username ? { username: `${username}-session-${stickyId}`, password } : {}),
            bypassList: ["localhost", "127.0.0.1", "[::1]"],
        },
    };
}
