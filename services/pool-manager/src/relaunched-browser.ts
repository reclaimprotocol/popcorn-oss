const CDP_PORT = 9226;

// How long a relaunch may take before the allocation fails.
const RELAUNCH_TIMEOUT_MS = 45_000;
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_INTERVAL_MS = 250;
// How long an image that does not report its launches is given to replace its browser.
const UNREPORTED_RELAUNCH_MS = 750;

/** Where the in-pod launcher records who the running browser was launched for. */
export const BROWSER_LAUNCH_ANNOTATION = "agones.dev/sdk-browser-launch";

/** The launcher's record: a session id, "pool" before an allocation, or null when the image keeps none. */
export type LaunchRecord = () => Promise<string | null>;

/** Whether the browser's first page answers. */
export type PageProbe = () => Promise<boolean>;

export interface RelaunchWaitOptions {
    probe?: PageProbe;
    timeoutMs?: number;
    unreportedRelaunchMs?: number;
}

/**
 * Wait until the pod's browser is the one launched for this session.
 *
 * The in-pod launcher replaces Chromium only after it next polls the allocation,
 * so for a while another browser still answers on the CDP port: the pool's, or
 * one still starting when the pod was allocated. Work sent to it is lost when it
 * is killed. Nothing about a browser that answers says which one it is, so the
 * launcher records the session once that session's browser is running, and the
 * wait is for that record.
 *
 * An image from before launches were recorded keeps none. Its browser is
 * accepted once the launcher has had time to replace it, as it was before.
 */
export async function waitForRelaunchedBrowser(
    address: string,
    sessionId: string,
    launchRecord: LaunchRecord,
    options: RelaunchWaitOptions = {},
): Promise<boolean> {
    const probe = options.probe ?? (() => firstPageAnswers(address));
    const deadline = Date.now() + (options.timeoutMs ?? RELAUNCH_TIMEOUT_MS);
    let launched = false;
    while (Date.now() < deadline) {
        if (!launched) {
            // A failed read says nothing about the image: ask again.
            const record = await launchRecord().catch(() => undefined);
            if (record === null) {
                await Bun.sleep(options.unreportedRelaunchMs ?? UNREPORTED_RELAUNCH_MS);
                launched = true;
            } else if (record === sessionId) {
                launched = true;
            }
        }
        if (launched && await probe().catch(() => false)) return true;
        await Bun.sleep(PROBE_INTERVAL_MS);
    }
    return false;
}

async function firstPageAnswers(address: string): Promise<boolean> {
    const targets = await fetch(`http://${address}:${CDP_PORT}/json/list`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    }).then((response) => response.ok ? response.json() as Promise<Array<{ type: string; webSocketDebuggerUrl?: string }>> : []);
    const target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
    if (!target?.webSocketDebuggerUrl) return false;

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    try {
        return await new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
            socket.addEventListener("open", () => {
                socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "1", returnByValue: true } }));
            }, { once: true });
            socket.addEventListener("message", (event) => {
                const message = JSON.parse(String(event.data));
                if (message.id !== 1) return;
                clearTimeout(timeout);
                resolve(message.result?.result?.value === 1);
            });
            socket.addEventListener("error", () => { clearTimeout(timeout); resolve(false); }, { once: true });
        });
    } finally {
        socket.close();
    }
}
