import { describe, expect, test } from "bun:test";
import { buildMetadataAnnotationsPatch, gameServerAnnotation } from "./k8s";

describe("game server annotations", () => {
    test("reads one annotation and reports a missing one as null", () => {
        const gameServer = { metadata: { annotations: { "agones.dev/sdk-browser-launch": "session-123" } } };
        expect(gameServerAnnotation(gameServer, "agones.dev/sdk-browser-launch")).toBe("session-123");
        expect(gameServerAnnotation(gameServer, "agones.dev/sdk-other")).toBeNull();
        expect(gameServerAnnotation({ metadata: {} }, "agones.dev/sdk-browser-launch")).toBeNull();
        expect(gameServerAnnotation({}, "agones.dev/sdk-browser-launch")).toBeNull();
    });
});

describe("Kubernetes patch helpers", () => {
    test("builds a merge patch for metadata annotations", () => {
        expect(buildMetadataAnnotationsPatch({
            "popcorn.dev/session-id": "session-123",
            "popcorn.dev/session-bound-at": "2026-06-04T12:34:56.789Z",
        })).toEqual({
            metadata: {
                annotations: {
                    "popcorn.dev/session-id": "session-123",
                    "popcorn.dev/session-bound-at": "2026-06-04T12:34:56.789Z",
                },
            },
        });
    });
});
