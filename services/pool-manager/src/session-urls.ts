export const LIVEVIEW_QUERY = "resize=scale&reconnect=1&reconnect_delay=2000";

export interface SessionUrlInput {
    baseUrl: string;
    browserPodId: string;
    sessionId: string;
    restrictedToken: string;
    automationToken?: string | null;
    internalToken: string;
    includeE2e?: boolean;
}

function normalizedBaseUrl(baseUrl: string): URL {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Session gateway URL must use HTTP or HTTPS");
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed;
}

export function websocketBaseUrl(baseUrl: string): string {
    const parsed = normalizedBaseUrl(baseUrl);
    if (parsed.protocol === "https:") {
        parsed.protocol = "wss:";
    } else {
        parsed.protocol = "ws:";
    }
    return parsed.href.replace(/\/+$/, "");
}

export function buildSessionUrls(input: SessionUrlInput): Record<string, string> {
    const baseUrl = normalizedBaseUrl(input.baseUrl).href.replace(/\/+$/, "");
    const wsBase = websocketBaseUrl(baseUrl);
    const liveViewQuery = input.includeE2e ? `${LIVEVIEW_QUERY}&encryption=e2e` : LIVEVIEW_QUERY;
    return {
        url: `${baseUrl}/liveview/${input.sessionId}/${input.restrictedToken}/liveview.html?${liveViewQuery}`,
        cdpUrl: input.automationToken
            ? `${wsBase}/cdp-agent/${input.sessionId}/${input.automationToken}/`
            : `${wsBase}/cdp/${input.sessionId}/${input.restrictedToken}/`,
        cdpInternalUrl: `${wsBase}/cdp-internal/${input.sessionId}/${input.internalToken}/`,
        apiUrl: `${baseUrl}/api/${input.sessionId}/${input.internalToken}/`,
        vncUrl: `${baseUrl}/liveview/${input.sessionId}/${input.restrictedToken}/liveview.html?${liveViewQuery}`,
        // Compatibility-only noVNC aliases. They are not part of the E2EE
        // protocol and a trusted viewer must use the explicit E2EE endpoints.
        vncWsUrl: `${wsBase}/liveview-ws/${input.sessionId}/${input.restrictedToken}`,
        ...(input.includeE2e ? {
            e2eRfbUrl: `${wsBase}/liveview-e2e-rfb/${input.sessionId}/${input.restrictedToken}`,
            e2eControlUrl: `${wsBase}/liveview-e2e-control/${input.sessionId}/${input.restrictedToken}`,
        } : {}),
    };
}
