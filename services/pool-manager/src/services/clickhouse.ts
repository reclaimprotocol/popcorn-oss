const CLICKHOUSE_ENABLED = (process.env.OTEL_CLICKHOUSE_ENABLED || "false").toLowerCase() === "true";
const CLICKHOUSE_HTTP_ENDPOINT = CLICKHOUSE_ENABLED ? requireEnv("OTEL_CLICKHOUSE_HTTP_ENDPOINT") : "";
const CLICKHOUSE_USERNAME = CLICKHOUSE_ENABLED ? requireEnv("OTEL_CLICKHOUSE_USERNAME") : "";
const CLICKHOUSE_PASSWORD = CLICKHOUSE_ENABLED ? requireEnv("OTEL_CLICKHOUSE_PASSWORD") : "";
const CLICKHOUSE_DATABASE = process.env.OTEL_CLICKHOUSE_DATABASE || "otel";

function requireEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

interface SessionBindingInput {
    sessionId: string;
    clusterName: string;
    namespace: string;
    podName: string;
    podUid: string;
    boundAt: string;
}

function formatClickHouseDateTime64(value: string): string {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid boundAt timestamp: ${value}`);
    }

    const pad = (num: number, size = 2) => num.toString().padStart(size, "0");

    return [
        `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
        `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`,
    ].join(" ");
}

function buildAuthHeader() {
    const token = Buffer.from(`${CLICKHOUSE_USERNAME}:${CLICKHOUSE_PASSWORD}`).toString("base64");
    return `Basic ${token}`;
}

export const ClickHouse = {
    isConfigured() {
        return CLICKHOUSE_ENABLED;
    },

    async createSessionBinding(input: SessionBindingInput): Promise<void> {
        if (!CLICKHOUSE_ENABLED) {
            return;
        }

        const boundAt = formatClickHouseDateTime64(input.boundAt);

        const sql = `INSERT INTO ${CLICKHOUSE_DATABASE}.session_bindings FORMAT JSONEachRow`;
        const endpoint = `${CLICKHOUSE_HTTP_ENDPOINT.replace(/\/$/, "")}/?database=${encodeURIComponent(CLICKHOUSE_DATABASE)}&query=${encodeURIComponent(sql)}`;

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Authorization": buildAuthHeader(),
                "Content-Type": "application/json",
            },
            body: `${JSON.stringify({
                session_id: input.sessionId,
                cluster_name: input.clusterName,
                namespace: input.namespace,
                pod_name: input.podName,
                pod_uid: input.podUid,
                bound_at: boundAt,
            })}\n`,
        });

        if (!response.ok) {
            const body = await response.text();
            throw new Error(`ClickHouse insert failed ${response.status}: ${body}`);
        }
    },
};
