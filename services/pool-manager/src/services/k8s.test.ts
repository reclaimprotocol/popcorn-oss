import { describe, expect, test } from "bun:test";
import { buildMetadataAnnotationsPatch } from "./k8s";

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
