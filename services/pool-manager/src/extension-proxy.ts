import type { ExtensionProxyConfig } from "./session-proxy";

const CDP_PORT = 9226;
const activeProxyCdpSessions = new Map<string, WebSocket>();
// This local page bypasses the proxy and is always served by the browser
// container. It gives the extension a normal HTTP document to inject into.
const LOCAL_PCN_URL = process.env.POPCORN_LOCAL_NOVNC_URL || "http://127.0.0.1:6080/liveview.html";

/** Release the internal CDP connection held while proxy auth is pending. */
export function closeProxyCdpSession(sessionId: string): void {
    const socket = activeProxyCdpSessions.get(sessionId);
    activeProxyCdpSessions.delete(sessionId);
    socket?.close();
}

function cdpCommand(socket: WebSocket, id: number, method: string, params: Record<string, unknown> = {}) {
    return new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 10_000);
        const listener = (event: MessageEvent) => {
            const message = JSON.parse(String(event.data));
            if (message.id !== id) return;
            socket.removeEventListener("message", listener);
            clearTimeout(timeout);
            message.error ? reject(new Error(message.error.message || `CDP ${method} failed`)) : resolve(message.result);
        };
        socket.addEventListener("message", listener);
        socket.send(JSON.stringify({ id, method, params }));
    });
}

/** Configure the bundled extension before returning a proxied session to callers. */
export async function presetExtensionProxy(sessionId: string, address: string, config: ExtensionProxyConfig): Promise<void> {
    const targets = await fetch(`http://${address}:${CDP_PORT}/json/list`).then((response) => {
        if (!response.ok) throw new Error(`full CDP returned ${response.status}`);
        return response.json() as Promise<Array<{ type: string; webSocketDebuggerUrl?: string }>>;
    });
    const target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
    if (!target?.webSocketDebuggerUrl) throw new Error("full CDP did not expose a page target");

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("CDP WebSocket connection timed out")), 10_000);
        socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("CDP WebSocket connection failed")); }, { once: true });
    });
    try {
        let id = 1;
        let authHandled = false;
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data));
            if (message.method === "Fetch.requestPaused") {
                socket.send(JSON.stringify({ id: id++, method: "Fetch.continueRequest", params: { requestId: message.params.requestId } }));
                return;
            }
            if (message.method === "Fetch.authRequired") {
                if (authHandled) return;
                authHandled = true;
                void (async () => {
                    await cdpCommand(socket, id++, "Fetch.continueWithAuth", {
                        requestId: message.params.requestId,
                        authChallengeResponse: { response: "ProvideCredentials", username: config.username, password: config.password },
                    });
                    // Wait until Chrome acknowledges the credentials. Disabling
                    // Fetch earlier can race the auth response.
                    await cdpCommand(socket, id++, "Fetch.disable");
                    closeProxyCdpSession(sessionId);
                })().catch((error) => {
                    console.error(`Failed to establish proxy auth for ${sessionId}:`, error);
                    closeProxyCdpSession(sessionId);
                });
            }
        });
        // The browser has not yet been returned to a user, so use its local
        // noVNC document to reliably trigger the extension content script.
        // Localhost is in the proxy bypass list, including after configuration.
        await cdpCommand(socket, id++, "Page.navigate", { url: LOCAL_PCN_URL });
        if (config.username && config.password) {
            await cdpCommand(socket, id++, "Fetch.enable", { handleAuthRequests: true });
        }
        const expression = `(() => new Promise((resolve, reject) => {
          const started = Date.now();
          const apply = () => window.__pcn?.ready
            ? window.__pcn.set(${JSON.stringify(config)}).then(resolve, reject)
            : Date.now() - started > 5000 ? reject(new Error('__pcn unavailable')) : setTimeout(apply, 50);
          apply();
        }))()`;
        const result = await cdpCommand(socket, id++, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "__pcn.set failed");
        // Fetch interception must survive this call: Chrome raises the proxy auth
        // challenge on the caller's first real navigation, not on __pcn.set().
        if (config.username && config.password) {
            closeProxyCdpSession(sessionId);
            activeProxyCdpSessions.set(sessionId, socket);
        } else {
            socket.close();
        }
    } catch (error) {
        socket.close();
        throw error;
    }
}
