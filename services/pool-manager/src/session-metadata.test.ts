import { describe, expect, test } from "bun:test";
import {
    SESSION_BOUND_AT_ANNOTATION,
    SESSION_BOUND_AT_UNIX_NANO_ANNOTATION,
    SESSION_ID_ANNOTATION,
    buildSessionMetadata,
    unixNanoFromDate,
} from "./session-metadata";

describe("session metadata", () => {
    test("builds pod annotations for OTEL session correlation", () => {
        const boundAt = new Date("2026-06-04T12:34:56.789Z");
        const metadata = buildSessionMetadata("session-123", boundAt);

        expect(metadata.boundAt).toBe("2026-06-04T12:34:56.789Z");
        expect(metadata.boundAtUnixNano).toBe("1780576496789000000");
        expect(metadata.annotations).toEqual({
            [SESSION_ID_ANNOTATION]: "session-123",
            [SESSION_BOUND_AT_ANNOTATION]: "2026-06-04T12:34:56.789Z",
            [SESSION_BOUND_AT_UNIX_NANO_ANNOTATION]: "1780576496789000000",
        });
    });

    test("converts Date millisecond precision to unix nanoseconds", () => {
        expect(unixNanoFromDate(new Date("1970-01-01T00:00:01.234Z"))).toBe("1234000000");
    });

    test("binds only the client's public E2EE identity to GameServer metadata", () => {
        const clientPublicKey = Buffer.alloc(32, 5).toString("base64url");
        expect(buildSessionMetadata("session-123", new Date("2026-06-04T12:34:56.789Z"), clientPublicKey).annotations)
            .toMatchObject({
                "popcorn.dev/session-id": "session-123",
                "popcorn.dev/e2e-client-public-key": clientPublicKey,
                "popcorn.dev/e2e-version": "1",
            });
    });
});
