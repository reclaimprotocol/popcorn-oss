import { describe, expect, test } from "bun:test";
import { waitForRelaunchedBrowser } from "./relaunched-browser";

/** Answers from a list, then keeps giving the last one. */
function sequence<T>(values: T[]): { next: () => Promise<T>; seen: T[] } {
    const seen: T[] = [];
    return {
        seen,
        next: async () => {
            const value = values.length > 1 ? values.shift()! : values[0];
            seen.push(value);
            return value;
        },
    };
}

describe("waitForRelaunchedBrowser", () => {
    test("ignores every browser until the launcher names the session", async () => {
        // The pool's browser, then a relaunch under way, then this session's browser.
        const record = sequence<string | null>(["pool", "pool", "session-1"]);
        let probes = 0;
        const ok = await waitForRelaunchedBrowser("pod", "session-1", record.next, {
            probe: async () => { probes++; return true; },
            timeoutMs: 5_000,
        });
        expect(ok).toBe(true);
        expect(record.seen).toEqual(["pool", "pool", "session-1"]);
        // A browser answered the whole time; only the named one was accepted.
        expect(probes).toBe(1);
    });

    test("does not accept a browser that started just after the allocation", async () => {
        // The pod was allocated while its first browser was still starting. It
        // answers, and is young, but it is about to be replaced.
        const ok = await waitForRelaunchedBrowser("pod", "session-1", async () => "pool", {
            probe: async () => true,
            timeoutMs: 600,
        });
        expect(ok).toBe(false);
    });

    test("does not accept a browser launched for another session", async () => {
        const ok = await waitForRelaunchedBrowser("pod", "session-1", async () => "session-0", {
            probe: async () => true,
            timeoutMs: 600,
        });
        expect(ok).toBe(false);
    });

    test("waits for the named browser to answer", async () => {
        const probe = sequence([false, false, true]);
        const ok = await waitForRelaunchedBrowser("pod", "session-1", async () => "session-1", {
            probe: probe.next,
            timeoutMs: 5_000,
        });
        expect(ok).toBe(true);
        expect(probe.seen).toEqual([false, false, true]);
    });

    test("asks again when the record cannot be read", async () => {
        let reads = 0;
        const ok = await waitForRelaunchedBrowser("pod", "session-1", async () => {
            reads++;
            if (reads === 1) throw new Error("connection refused");
            return "session-1";
        }, { probe: async () => true, timeoutMs: 5_000 });
        expect(ok).toBe(true);
        expect(reads).toBe(2);
    });

    test("treats a failing probe as not ready yet", async () => {
        let calls = 0;
        const ok = await waitForRelaunchedBrowser("pod", "session-1", async () => "session-1", {
            probe: async () => {
                calls++;
                if (calls === 1) throw new Error("connection refused");
                return true;
            },
            timeoutMs: 5_000,
        });
        expect(ok).toBe(true);
        expect(calls).toBe(2);
    });

    test("gives an image that records nothing time to replace its browser", async () => {
        const started = Date.now();
        let firstProbeAfter = 0;
        const ok = await waitForRelaunchedBrowser("pod", "session-1", async () => null, {
            probe: async () => { firstProbeAfter ||= Date.now() - started; return true; },
            timeoutMs: 5_000,
            unreportedRelaunchMs: 300,
        });
        expect(ok).toBe(true);
        expect(firstProbeAfter).toBeGreaterThanOrEqual(290);
    });

    test("fails when the session is never named", async () => {
        const ok = await waitForRelaunchedBrowser("pod", "session-1", async () => "pool", {
            probe: async () => true,
            timeoutMs: 600,
        });
        expect(ok).toBe(false);
    });
});
