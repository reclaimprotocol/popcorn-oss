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
    // {{country}} is lowercase; {{COUNTRY}} keeps the ISO case for providers
    // that ignore a lowercase code.
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
// Primary IANA zone for every country readSessionProxy accepts (IANA zone.tab;
// multi-zone countries use their most populous zone).
const COUNTRY_TIMEZONES: Record<string, string> = {
    AD: "Europe/Andorra", AE: "Asia/Dubai", AF: "Asia/Kabul", AG: "America/Antigua", AI: "America/Anguilla",
    AL: "Europe/Tirane", AM: "Asia/Yerevan", AO: "Africa/Luanda", AQ: "Antarctica/McMurdo",
    AR: "America/Argentina/Buenos_Aires", AS: "Pacific/Pago_Pago", AT: "Europe/Vienna", AU: "Australia/Sydney",
    AW: "America/Aruba", AX: "Europe/Mariehamn", AZ: "Asia/Baku", BA: "Europe/Sarajevo", BB: "America/Barbados",
    BD: "Asia/Dhaka", BE: "Europe/Brussels", BF: "Africa/Ouagadougou", BG: "Europe/Sofia", BH: "Asia/Bahrain",
    BI: "Africa/Bujumbura", BJ: "Africa/Porto-Novo", BL: "America/St_Barthelemy", BM: "Atlantic/Bermuda",
    BN: "Asia/Brunei", BO: "America/La_Paz", BQ: "America/Kralendijk", BR: "America/Sao_Paulo", BS: "America/Nassau",
    BT: "Asia/Thimphu", BV: "Europe/Oslo", BW: "Africa/Gaborone", BY: "Europe/Minsk", BZ: "America/Belize",
    CA: "America/Toronto", CC: "Indian/Cocos", CD: "Africa/Kinshasa", CF: "Africa/Bangui", CG: "Africa/Brazzaville",
    CH: "Europe/Zurich", CI: "Africa/Abidjan", CK: "Pacific/Rarotonga", CL: "America/Santiago", CM: "Africa/Douala",
    CN: "Asia/Shanghai", CO: "America/Bogota", CR: "America/Costa_Rica", CU: "America/Havana",
    CV: "Atlantic/Cape_Verde", CW: "America/Curacao", CX: "Indian/Christmas", CY: "Asia/Nicosia", CZ: "Europe/Prague",
    DE: "Europe/Berlin", DJ: "Africa/Djibouti", DK: "Europe/Copenhagen", DM: "America/Dominica",
    DO: "America/Santo_Domingo", DZ: "Africa/Algiers", EC: "America/Guayaquil", EE: "Europe/Tallinn",
    EG: "Africa/Cairo", EH: "Africa/El_Aaiun", ER: "Africa/Asmara", ES: "Europe/Madrid", ET: "Africa/Addis_Ababa",
    FI: "Europe/Helsinki", FJ: "Pacific/Fiji", FK: "Atlantic/Stanley", FM: "Pacific/Pohnpei", FO: "Atlantic/Faroe",
    FR: "Europe/Paris", GA: "Africa/Libreville", GB: "Europe/London", GD: "America/Grenada", GE: "Asia/Tbilisi",
    GF: "America/Cayenne", GG: "Europe/Guernsey", GH: "Africa/Accra", GI: "Europe/Gibraltar", GL: "America/Nuuk",
    GM: "Africa/Banjul", GN: "Africa/Conakry", GP: "America/Guadeloupe", GQ: "Africa/Malabo", GR: "Europe/Athens",
    GS: "Atlantic/South_Georgia", GT: "America/Guatemala", GU: "Pacific/Guam", GW: "Africa/Bissau",
    GY: "America/Guyana", HK: "Asia/Hong_Kong", HM: "Indian/Kerguelen", HN: "America/Tegucigalpa",
    HR: "Europe/Zagreb", HT: "America/Port-au-Prince", HU: "Europe/Budapest", ID: "Asia/Jakarta", IE: "Europe/Dublin",
    IL: "Asia/Jerusalem", IM: "Europe/Isle_of_Man", IN: "Asia/Kolkata", IO: "Indian/Chagos", IQ: "Asia/Baghdad",
    IR: "Asia/Tehran", IS: "Atlantic/Reykjavik", IT: "Europe/Rome", JE: "Europe/Jersey", JM: "America/Jamaica",
    JO: "Asia/Amman", JP: "Asia/Tokyo", KE: "Africa/Nairobi", KG: "Asia/Bishkek", KH: "Asia/Phnom_Penh",
    KI: "Pacific/Tarawa", KM: "Indian/Comoro", KN: "America/St_Kitts", KP: "Asia/Pyongyang", KR: "Asia/Seoul",
    KW: "Asia/Kuwait", KY: "America/Cayman", KZ: "Asia/Almaty", LA: "Asia/Vientiane", LB: "Asia/Beirut",
    LC: "America/St_Lucia", LI: "Europe/Vaduz", LK: "Asia/Colombo", LR: "Africa/Monrovia", LS: "Africa/Maseru",
    LT: "Europe/Vilnius", LU: "Europe/Luxembourg", LV: "Europe/Riga", LY: "Africa/Tripoli", MA: "Africa/Casablanca",
    MC: "Europe/Monaco", MD: "Europe/Chisinau", ME: "Europe/Podgorica", MF: "America/Marigot",
    MG: "Indian/Antananarivo", MH: "Pacific/Majuro", MK: "Europe/Skopje", ML: "Africa/Bamako", MM: "Asia/Yangon",
    MN: "Asia/Ulaanbaatar", MO: "Asia/Macau", MP: "Pacific/Saipan", MQ: "America/Martinique", MR: "Africa/Nouakchott",
    MS: "America/Montserrat", MT: "Europe/Malta", MU: "Indian/Mauritius", MV: "Indian/Maldives",
    MW: "Africa/Blantyre", MX: "America/Mexico_City", MY: "Asia/Kuala_Lumpur", MZ: "Africa/Maputo",
    NA: "Africa/Windhoek", NC: "Pacific/Noumea", NE: "Africa/Niamey", NF: "Pacific/Norfolk", NG: "Africa/Lagos",
    NI: "America/Managua", NL: "Europe/Amsterdam", NO: "Europe/Oslo", NP: "Asia/Kathmandu", NR: "Pacific/Nauru",
    NU: "Pacific/Niue", NZ: "Pacific/Auckland", OM: "Asia/Muscat", PA: "America/Panama", PE: "America/Lima",
    PF: "Pacific/Tahiti", PG: "Pacific/Port_Moresby", PH: "Asia/Manila", PK: "Asia/Karachi", PL: "Europe/Warsaw",
    PM: "America/Miquelon", PN: "Pacific/Pitcairn", PR: "America/Puerto_Rico", PS: "Asia/Hebron", PT: "Europe/Lisbon",
    PW: "Pacific/Palau", PY: "America/Asuncion", QA: "Asia/Qatar", RE: "Indian/Reunion", RO: "Europe/Bucharest",
    RS: "Europe/Belgrade", RU: "Europe/Moscow", RW: "Africa/Kigali", SA: "Asia/Riyadh", SB: "Pacific/Guadalcanal",
    SC: "Indian/Mahe", SD: "Africa/Khartoum", SE: "Europe/Stockholm", SG: "Asia/Singapore", SH: "Atlantic/St_Helena",
    SI: "Europe/Ljubljana", SJ: "Arctic/Longyearbyen", SK: "Europe/Bratislava", SL: "Africa/Freetown",
    SM: "Europe/San_Marino", SN: "Africa/Dakar", SO: "Africa/Mogadishu", SR: "America/Paramaribo", SS: "Africa/Juba",
    ST: "Africa/Sao_Tome", SV: "America/El_Salvador", SX: "America/Lower_Princes", SY: "Asia/Damascus",
    SZ: "Africa/Mbabane", TC: "America/Grand_Turk", TD: "Africa/Ndjamena", TF: "Indian/Kerguelen", TG: "Africa/Lome",
    TH: "Asia/Bangkok", TJ: "Asia/Dushanbe", TK: "Pacific/Fakaofo", TL: "Asia/Dili", TM: "Asia/Ashgabat",
    TN: "Africa/Tunis", TO: "Pacific/Tongatapu", TR: "Europe/Istanbul", TT: "America/Port_of_Spain",
    TV: "Pacific/Funafuti", TW: "Asia/Taipei", TZ: "Africa/Dar_es_Salaam", UA: "Europe/Kyiv", UG: "Africa/Kampala",
    UM: "Pacific/Midway", US: "America/New_York", UY: "America/Montevideo", UZ: "Asia/Tashkent", VA: "Europe/Vatican",
    VC: "America/St_Vincent", VE: "America/Caracas", VG: "America/Tortola", VI: "America/St_Thomas",
    VN: "Asia/Ho_Chi_Minh", VU: "Pacific/Efate", WF: "Pacific/Wallis", WS: "Pacific/Apia", YE: "Asia/Aden",
    YT: "Indian/Mayotte", ZA: "Africa/Johannesburg", ZM: "Africa/Lusaka", ZW: "Africa/Harare",
};

const TIMEZONE = /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/;

/**
 * The timezone of the proxy's exit for this session. The session's sticky
 * username keeps the browser on the same exit, so a site comparing the
 * browser clock with its IP sees the zone it expects. When both geo services
 * fail, the country's primary zone is used.
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
