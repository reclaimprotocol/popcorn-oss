import { describe, expect, test } from "bun:test";
import { waitForRelaunchedBrowser } from "./relaunched-browser";

describe("waitForRelaunchedBrowser", () => {
    test("ignores the old browser until a page newer than the allocation answers", async () => {
        const allocatedAt = Date.now() - 1_000;
        // The old browser's page has been up for a minute; then the relaunch
        // is mid-start (no page), then its first page is 200ms old.
        const ages: Array<number | null> = [60_000, 60_000, null, 200];
        const seen: Array<number | null> = [];
        const ok = await waitForRelaunchedBrowser("pod", allocatedAt, async () => {
            const age = ages.length ? ages.shift()! : 200;
            seen.push(age);
            return age;
        }, 5_000);
        expect(ok).toBe(true);
        expect(seen).toEqual([60_000, 60_000, null, 200]);
    });

    test("treats a failing probe as not ready yet", async () => {
        let calls = 0;
        const ok = await waitForRelaunchedBrowser("pod", Date.now() - 1_000, async () => {
            calls++;
            if (calls === 1) throw new Error("connection refused");
            return 50;
        }, 5_000);
        expect(ok).toBe(true);
        expect(calls).toBe(2);
    });

    test("fails when only the old browser answers", async () => {
        const ok = await waitForRelaunchedBrowser("pod", Date.now(), async () => 60_000, 600);
        expect(ok).toBe(false);
    });
});
