import { describe, expect, test } from "bun:test";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { buildSessionLifecycleLogRecord, parseOtlpHeaders } from "./otel";

describe("OTLP lifecycle events", () => {
    test("uses event time for session.start timestamp and emit time for observed timestamp", () => {
        const event = buildSessionLifecycleLogRecord("session.start", {
            sessionId: "session-123",
            clusterName: "cluster-a",
            namespace: "popcorn",
            podName: "browser-fleet-abcde",
            podUid: "pod-uid-123",
            at: "2026-06-04T12:34:56.789Z",
            region: "us-central1",
        }, new Date("2026-06-04T12:35:00.000Z"));

        expect(event.resourceAttributes).toMatchObject({
            "service.name": "pool-manager",
            "service.namespace": "popcorn",
            "k8s.cluster.name": "cluster-a",
            "cluster.name": "cluster-a",
            "popcorn.region": "us-central1",
        });
        expect(event.logRecord).toMatchObject({
            timestamp: new Date("2026-06-04T12:34:56.789Z"),
            observedTimestamp: new Date("2026-06-04T12:35:00.000Z"),
            severityNumber: SeverityNumber.INFO,
            severityText: "INFO",
            eventName: "session.start",
            body: "session.start",
        });
        expect(event.logRecord.attributes).toMatchObject({
            "session.id": "session-123",
            "k8s.cluster.name": "cluster-a",
            "k8s.namespace.name": "popcorn",
            "k8s.pod.name": "browser-fleet-abcde",
            "k8s.pod.uid": "pod-uid-123",
            "popcorn.region": "us-central1",
            "popcorn.session.event_at": "2026-06-04T12:34:56.789Z",
        });
    });

    test("builds a session.end LogRecord without empty pod attributes", () => {
        const event = buildSessionLifecycleLogRecord("session.end", {
            sessionId: "session-123",
            clusterName: "cluster-a",
            namespace: "popcorn",
            podName: null,
            podUid: null,
            at: "2026-06-04T12:40:00.000Z",
        }, new Date("2026-06-04T12:40:00.000Z"));

        expect(event.logRecord.eventName).toBe("session.end");
        expect(event.logRecord.attributes?.["session.id"]).toBe("session-123");
        expect(event.logRecord.attributes?.["k8s.pod.name"]).toBeUndefined();
        expect(event.logRecord.attributes?.["k8s.pod.uid"]).toBeUndefined();
    });

    test("parses OTLP header values", () => {
        expect(parseOtlpHeaders("Authorization=Bearer%20abc, x-scope-orgid = popcorn, X-Plus=Bearer+test ")).toEqual({
            Authorization: "Bearer abc",
            "x-scope-orgid": "popcorn",
            "X-Plus": "Bearer test",
        });
    });
});
