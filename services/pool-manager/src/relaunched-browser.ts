const CDP_PORT = 9226;

// How long a relaunch may take before the allocation fails.
const RELAUNCH_TIMEOUT_MS = 45_000;
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_INTERVAL_MS = 250;

/** Age of the browser's first page in ms, or null when no page answers yet. */
export type PageAgeProbe = () => Promise<number | null>;

/**
 * Wait until the pod's browser is the one relaunched for this allocation.
 *
 * The in-pod launcher replaces Chromium only after it next polls the allocation,
 * so for a while the OLD browser still answers on the CDP port. Work sent to it
 * is lost when it is killed: the proxy preset's first evaluate then times out.
 * A page that started loading after the allocation can only belong to the new
 * browser. Its age is measured by the page itself, so the two clocks never meet.
 *
 * `allocationStartedAt` is taken before the allocation is requested. The
 * launcher can relaunch the browser before the response arrives, and a cutoff
 * taken afterwards would make that new page look like the old one.
 */
export async function waitForRelaunchedBrowser(
    address: string,
    allocationStartedAt: number,
    probe: PageAgeProbe = () => firstPageAge(address),
    timeoutMs = RELAUNCH_TIMEOUT_MS,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const age = await probe().catch(() => null);
        if (age !== null && age < Date.now() - allocationStartedAt) return true;
        await Bun.sleep(PROBE_INTERVAL_MS);
    }
    return false;
}

async function firstPageAge(address: string): Promise<number | null> {
    const targets = await fetch(`http://${address}:${CDP_PORT}/json/list`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    }).then((response) => response.ok ? response.json() as Promise<Array<{ type: string; webSocketDebuggerUrl?: string }>> : []);
    const target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
    if (!target?.webSocketDebuggerUrl) return null;

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    try {
        return await new Promise<number | null>((resolve) => {
            const timeout = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
            socket.addEventListener("open", () => {
                socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "performance.now()", returnByValue: true } }));
            }, { once: true });
            socket.addEventListener("message", (event) => {
                const message = JSON.parse(String(event.data));
                if (message.id !== 1) return;
                clearTimeout(timeout);
                const value = message.result?.result?.value;
                resolve(typeof value === "number" ? value : null);
            });
            socket.addEventListener("error", () => { clearTimeout(timeout); resolve(null); }, { once: true });
        });
    } finally {
        socket.close();
    }
}
