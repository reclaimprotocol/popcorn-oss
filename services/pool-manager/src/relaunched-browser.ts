const CDP_PORT = 9226;

// How long a relaunch may take before the allocation fails.
const RELAUNCH_TIMEOUT_MS = 45_000;
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_INTERVAL_MS = 250;
// How long an image that does not record its launches is given to replace its browser.
const UNRECORDED_RELAUNCH_MS = 750;

/** Where the in-pod launcher records who the running browser was launched for. */
export const BROWSER_LAUNCH_ANNOTATION = "agones.dev/sdk-browser-launch";

/** The launcher's record: a session id, "pool" before an allocation, or null when the image keeps none. */
export type LaunchRecord = () => Promise<string | null>;

/** Whether the pod's browser answers. */
export type BrowserProbe = () => Promise<boolean>;

export interface RelaunchWaitOptions {
    probe?: BrowserProbe;
    timeoutMs?: number;
    unrecordedRelaunchMs?: number;
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
 * A game server with no record belongs to an image from before records
 * existed, and its browser is accepted once the launcher has had time to
 * replace it, as it was before. That reading is safe because an image that
 * keeps records cannot be allocated without one:
 *
 *   1. its launcher (run-chromium-managed) writes "pool", and waits until the
 *      game server shows it, before it starts the first browser;
 *   2. its entrypoint reports the pod ready only once that browser's window
 *      exists;
 *   3. Agones allocates only ready pods.
 *
 * So on such an image the record is on the game server before any allocation,
 * and a later write that fails or is slow leaves the earlier record in place:
 * the wait then continues until the session is named.
 */
export async function waitForRelaunchedBrowser(
    address: string,
    sessionId: string,
    launchRecord: LaunchRecord,
    options: RelaunchWaitOptions = {},
): Promise<boolean> {
    const probe = options.probe ?? (() => browserAnswers(address));
    const deadline = Date.now() + (options.timeoutMs ?? RELAUNCH_TIMEOUT_MS);
    let launched = false;
    while (Date.now() < deadline) {
        if (!launched) {
            // A failed read says nothing about the image: ask again.
            const record = await launchRecord().catch(() => undefined);
            if (record === null) {
                await Bun.sleep(options.unrecordedRelaunchMs ?? UNRECORDED_RELAUNCH_MS);
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

async function browserAnswers(address: string): Promise<boolean> {
    const response = await fetch(`http://${address}:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return response.ok;
}
