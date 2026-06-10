import type { Context } from "@opentelemetry/api";
import type { LogAttributes, LogRecord } from "@opentelemetry/api-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPLogExporter as OTLPGrpcLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPLogExporter as OTLPHttpLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { LogRecordExporter, LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import type { Metadata as GrpcMetadata } from "@grpc/grpc-js";

const OTEL_LOGS_ENABLED = (process.env.OTEL_LOGS_ENABLED || "false").toLowerCase() === "true";
const OTEL_LOGS_PROTOCOL = resolveLogsProtocol();
const OTEL_LOGS_ENDPOINT = resolveLogsEndpoint(OTEL_LOGS_PROTOCOL);
const OTEL_HEADERS = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
const POPCORN_REGION = process.env.POPCORN_REGION || "unknown";
const DEFAULT_EXPORT_TIMEOUT_MILLIS = 10000;

type AttributeValue = string | number | boolean | undefined | null;
type LogsProtocol = "grpc" | "http";
type SessionLifecycleEventName = "session.start" | "session.end";

interface SessionLifecycleInput {
    sessionId: string;
    clusterName: string;
    namespace: string;
    podName?: string | null;
    podUid?: string | null;
    at: string;
    region?: string | null;
}

interface SessionLifecycleLogRecord {
    resourceAttributes: LogAttributes;
    logRecord: LogRecord;
}

interface LoggerState {
    provider: LoggerProvider;
    logger: ReturnType<LoggerProvider["getLogger"]>;
}

const loggerStates = new Map<string, Promise<LoggerState>>();

class AwaitableLogRecordProcessor implements LogRecordProcessor {
    private pendingExports = new Set<Promise<void>>();
    private shutdownStarted = false;

    constructor(private readonly exporter: LogRecordExporter) {}

    onEmit(logRecord: SdkLogRecord, _context?: Context): void {
        if (this.shutdownStarted) {
            return;
        }

        const exportPromise = new Promise<void>((resolve, reject) => {
            try {
                this.exporter.export([logRecord], (result) => {
                    if (result.code === ExportResultCode.SUCCESS) {
                        resolve();
                        return;
                    }

                    reject(result.error || new Error("OTLP log export failed"));
                });
            } catch (error) {
                reject(error);
            }
        });

        this.pendingExports.add(exportPromise);
        void exportPromise.finally(() => this.pendingExports.delete(exportPromise)).catch(() => {});
    }

    async forceFlush(): Promise<void> {
        await Promise.all(Array.from(this.pendingExports));
        await this.exporter.forceFlush();
    }

    async shutdown(): Promise<void> {
        this.shutdownStarted = true;
        await this.forceFlush();
        await this.exporter.shutdown();
    }
}

function resolveLogsProtocol(raw = process.env.OTEL_EXPORTER_OTLP_PROTOCOL): LogsProtocol {
    const protocol = raw?.trim().toLowerCase();
    if (protocol === "grpc") {
        return "grpc";
    }
    if (protocol === "http" || protocol === "http/json" || protocol === "http/protobuf") {
        return "http";
    }

    return "http";
}

function resolveLogsEndpoint(protocol: LogsProtocol): string {
    const logsEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim();
    if (logsEndpoint) {
        return logsEndpoint;
    }

    const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
    if (!baseEndpoint) {
        return "";
    }

    if (protocol === "grpc") {
        return baseEndpoint;
    }

    return `${baseEndpoint.replace(/\/$/, "")}/v1/logs`;
}

export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
    if (!raw?.trim()) {
        return {};
    }

    const decodeHeaderPart = (part: string) => decodeURIComponent(part.replace(/\+/g, "%20"));

    return Object.fromEntries(
        raw.split(",").flatMap((entry) => {
            const [rawKey, ...rawValue] = entry.split("=");
            const key = rawKey?.trim();
            const value = rawValue.join("=").trim();
            if (!key || !value) {
                return [];
            }

            try {
                return [[decodeHeaderPart(key), decodeHeaderPart(value)]];
            } catch {
                return [[key, value]];
            }
        })
    );
}

function compactAttributes(attributes: Record<string, AttributeValue>): LogAttributes {
    return Object.fromEntries(
        Object.entries(attributes).filter(([, value]) => value !== undefined && value !== null && value !== "")
    );
}

function parseEventTime(value: string, fallback: Date): Date {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return fallback;
    }
    return parsed;
}

function exportTimeoutMillis(): number {
    const raw = process.env.OTEL_EXPORTER_OTLP_TIMEOUT?.trim();
    if (!raw) {
        return DEFAULT_EXPORT_TIMEOUT_MILLIS;
    }

    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EXPORT_TIMEOUT_MILLIS;
}

async function createGrpcMetadata(headers: Record<string, string>): Promise<GrpcMetadata | undefined> {
    if (Object.keys(headers).length === 0) {
        return undefined;
    }

    const { Metadata } = await import("@grpc/grpc-js");
    const metadata = new Metadata();
    for (const [key, value] of Object.entries(headers)) {
        metadata.set(key.toLowerCase(), value);
    }
    return metadata;
}

async function createLogExporter(): Promise<LogRecordExporter> {
    const timeoutMillis = exportTimeoutMillis();

    if (OTEL_LOGS_PROTOCOL === "grpc") {
        return new OTLPGrpcLogExporter({
            url: OTEL_LOGS_ENDPOINT,
            metadata: await createGrpcMetadata(OTEL_HEADERS),
            timeoutMillis,
        });
    }

    return new OTLPHttpLogExporter({
        url: OTEL_LOGS_ENDPOINT,
        headers: OTEL_HEADERS,
        timeoutMillis,
    });
}

function loggerStateKey(resourceAttributes: LogAttributes): string {
    return JSON.stringify(resourceAttributes);
}

async function getLoggerState(resourceAttributes: LogAttributes): Promise<LoggerState> {
    const key = loggerStateKey(resourceAttributes);
    let state = loggerStates.get(key);
    if (!state) {
        state = createLogExporter().then((exporter) => {
            const provider = new LoggerProvider({
                resource: resourceFromAttributes(resourceAttributes),
                processors: [new AwaitableLogRecordProcessor(exporter)],
                forceFlushTimeoutMillis: exportTimeoutMillis() + 1000,
            });

            return {
                provider,
                logger: provider.getLogger("popcorn.pool-manager.sessions"),
            };
        });
        loggerStates.set(key, state);
    }

    return state;
}

export function buildSessionLifecycleLogRecord(
    eventName: SessionLifecycleEventName,
    input: SessionLifecycleInput,
    observedAt = new Date()
): SessionLifecycleLogRecord {
    const region = input.region || POPCORN_REGION;

    return {
        resourceAttributes: compactAttributes({
            "service.name": "pool-manager",
            "service.namespace": "popcorn",
            "k8s.cluster.name": input.clusterName,
            "cluster.name": input.clusterName,
            "popcorn.region": region,
        }),
        logRecord: {
            timestamp: parseEventTime(input.at, observedAt),
            observedTimestamp: observedAt,
            severityNumber: SeverityNumber.INFO,
            severityText: "INFO",
            eventName,
            body: eventName,
            attributes: compactAttributes({
                "session.id": input.sessionId,
                "k8s.cluster.name": input.clusterName,
                "k8s.namespace.name": input.namespace,
                "k8s.pod.name": input.podName,
                "k8s.pod.uid": input.podUid,
                "popcorn.region": region,
                "popcorn.session.event_at": input.at,
            }),
        },
    };
}

async function emitLifecycleEvent(eventName: SessionLifecycleEventName, input: SessionLifecycleInput): Promise<void> {
    if (!OTEL_LOGS_ENABLED) {
        return;
    }

    if (!OTEL_LOGS_ENDPOINT) {
        console.warn("OTEL_LOGS_ENABLED is true but no OTEL_EXPORTER_OTLP_LOGS_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT is configured");
        return;
    }

    const { resourceAttributes, logRecord } = buildSessionLifecycleLogRecord(eventName, input);
    const { provider, logger } = await getLoggerState(resourceAttributes);
    logger.emit(logRecord);
    await provider.forceFlush();
}

export const OtelEvents = {
    async sessionStart(input: SessionLifecycleInput): Promise<void> {
        await emitLifecycleEvent("session.start", input);
    },

    async sessionEnd(input: SessionLifecycleInput): Promise<void> {
        await emitLifecycleEvent("session.end", input);
    },
};
