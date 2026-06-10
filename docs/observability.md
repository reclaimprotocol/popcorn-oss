# Observability

Popcorn's observability path is backend-neutral. Popcorn emits OpenTelemetry
logs/events over OTLP; operators choose the collector exporters, storage, query
engine, and UI.

There is no universal OpenTelemetry UI or standard OTEL query API. OTLP is a
delivery protocol between telemetry sources, collectors, and backends. See the
OpenTelemetry [OTLP spec](https://opentelemetry.io/docs/specs/otlp/) and
[collector exporter docs](https://opentelemetry.io/docs/collector/components/exporter/).

## What It Deploys

Set `otel.enabled=true` in the platform chart to deploy:

- an `otel-agent` DaemonSet in the Popcorn namespace;
- an `otel-agent-config` ConfigMap;
- an `otel-agent` ServiceAccount;
- a ClusterRole and ClusterRoleBinding that let the collector read pod,
  namespace, and node metadata.

The collector runs on every scheduled node, reads browser GameServer container
logs from `/var/log/pods`, enriches them with Kubernetes metadata, filters for
Agones GameServer pods in the Popcorn namespace, batches records, and exports
them to the configured external collector.

The pool manager can also send `session.start` and `session.end` OTLP LogRecord
events directly to the configured external OTLP endpoint. Popcorn does not
deploy or require SigNoz, Loki, Grafana, ClickHouse, or any other viewer
backend.

## Enable Or Disable

Disabled is the default:

```yaml
otel:
  enabled: false
```

When enabled, configure exactly one external collector endpoint. OTLP gRPC:

```yaml
otel:
  enabled: true
  exporter:
    grpcEndpoint: otel-grpc.example.com:4317
```

OTLP HTTP:

```bash
kubectl -n popcorn create secret generic otel-exporter-headers \
  --from-literal=authorization="Bearer replace-me"
```

```yaml
otel:
  enabled: true
  exporter:
    httpEndpoint: https://otel-http.example.com
    headersSecretName: otel-exporter-headers
    headers:
      Authorization: authorization
    tls:
      insecure: false
```

`otel.exporter.headers` maps OTLP header names to keys in
`otel.exporter.headersSecretName`. Header values are loaded from the Secret by
the collector and pool manager; they are not rendered into the collector
ConfigMap or literal Pod env values.

Browser container logs and pool-manager lifecycle events can use either
`grpcEndpoint` or `httpEndpoint`. Lifecycle events are emitted directly by the
pool-manager process over the selected OTLP protocol; Popcorn does not expose
the `otel-agent` as an in-cluster OTLP receiver.

If `otel.enabled=true` and no endpoint is configured, Helm fails the render. If
both endpoints are configured, Helm also fails the render so Popcorn does not
silently fan out telemetry.

## Session Correlation

After Agones allocation, the pool manager patches the allocated browser Pod with
session annotations:

- `popcorn.dev/session-id`;
- `popcorn.dev/session-bound-at`;
- `popcorn.dev/session-bound-at-unix-nano`.

The collector reads those annotations with `k8sattributes`, uses the binding
timestamp to gate session attribution, and exports standard `session.id` only on
browser logs emitted at or after the bind time.

Browser logs emitted before the Pod was assigned remain unsessioned. They are
still correlated through standard Kubernetes attributes such as `k8s.pod.uid`.

## What It Emits

Browser GameServer log records include:

- `service.name=browser-runtime`;
- `service.namespace=popcorn`;
- `k8s.cluster.name`;
- `k8s.namespace.name`;
- `k8s.pod.name`;
- `k8s.pod.uid`;
- `k8s.container.name`;
- `k8s.node.name`;
- `agones.dev.role`;
- `agones.dev.fleet`;
- `session.id`, only for post-bind browser logs.

Pool-manager lifecycle LogRecord events use `service.name=pool-manager` and:

- LogRecord `eventName=session.start` or `eventName=session.end`;
- `session.id`;
- `k8s.pod.uid`;
- `k8s.pod.name`;
- `k8s.namespace.name`;
- `k8s.cluster.name`;
- `popcorn.region`.

The agent exports browser GameServer logs. The pool manager exports lifecycle
events directly when OTEL is enabled and either OTLP endpoint is set. Popcorn
does not export gateway, control-plane, Redis, Postgres, or Kubernetes event
logs by default.

## Query Semantics

For session-scoped logs, filter on:

```text
session.id = "<session-id>"
```

This shows only logs emitted after the browser Pod was bound to the session.

For full Pod lifecycle logs:

1. Find the `session.start` event by `session.id`.
2. Copy `k8s.pod.uid`.
3. Filter logs by `k8s.pod.uid`.

This shows startup and pre-session logs plus the session logs. The distinction is
intentional: pre-session logs are Pod lifecycle telemetry, not session telemetry.

## Optional Legacy ClickHouse Binding

The old `session_bindings` side table is now an optional legacy fallback. It is
not the primary OTEL correlation path.

Enable it explicitly:

```yaml
otel:
  enabled: true
  clickhouse:
    enabled: true
    database: otel
    secretName: otel-clickhouse-secret
```

Create the Secret only when `otel.clickhouse.enabled=true`:

```bash
kubectl -n popcorn create secret generic otel-clickhouse-secret \
  --from-literal=CLICKHOUSE_ENDPOINT="$CLICKHOUSE_ENDPOINT" \
  --from-literal=CLICKHOUSE_HTTP_ENDPOINT="$CLICKHOUSE_HTTP_ENDPOINT" \
  --from-literal=CLICKHOUSE_USERNAME="$CLICKHOUSE_USERNAME" \
  --from-literal=CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD"
```

Legacy table shape:

```sql
CREATE DATABASE IF NOT EXISTS otel;

CREATE TABLE IF NOT EXISTS otel.session_bindings
(
  session_id String,
  cluster_name String,
  namespace String,
  pod_name String,
  pod_uid String,
  bound_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
ORDER BY (session_id, bound_at);
```

## Recipes

Generic OTLP backend:

- Set exactly one of `otel.exporter.grpcEndpoint` or
  `otel.exporter.httpEndpoint`.
- Put sensitive OTLP headers in a Kubernetes Secret, set
  `otel.exporter.headersSecretName`, and map header names to Secret keys in
  `otel.exporter.headers`.
- Add TLS settings required by your backend.
- Query `session.id` for post-bind logs and `k8s.pod.uid` for full Pod
  lifecycle logs.

Grafana plus ClickHouse:

- Point Popcorn at an external collector that exports OTLP logs to ClickHouse.
- Point Grafana at ClickHouse with the ClickHouse datasource's OpenTelemetry
  table mapping mode. Grafana documents ClickHouse datasource
  [configuration](https://grafana.com/docs/plugins/grafana-clickhouse-datasource/latest/configure/)
  and [OpenTelemetry support](https://grafana.com/docs/plugins/grafana-clickhouse-datasource/latest/).
- Keep this as an operator recipe; Popcorn core does not require Grafana or
  ClickHouse.

Local verification:

- Point `otel.exporter.grpcEndpoint` or `otel.exporter.httpEndpoint` at a
  throwaway external collector with a debug/file exporter.
- Create a session.
- Check `kubectl -n popcorn logs daemonset/otel-agent --tail=200`.

## Verify

```bash
kubectl -n popcorn get daemonset otel-agent
kubectl -n popcorn logs daemonset/otel-agent --tail=100
```

Then create a session and verify:

- `session.start` has `session.id` and `k8s.pod.uid`;
- post-bind browser logs have `session.id`;
- pre-bind browser logs do not have `session.id`;
- all browser Pod logs can be found by `k8s.pod.uid`;
- collector logs do not show exporter connection errors.

## Current Limits

- Metrics and traces are not wired by the bundled collector config.
- The bundled collector config intentionally supports one outbound OTLP
  exporter. Use your external collector for fanout, storage-specific exporters,
  and backend-specific processors.
- The collector reads host log paths, so it needs node-level log access through
  `hostPath` mounts.
- Viewer behavior is backend-specific. Popcorn only controls emitted OTLP and
  collector export configuration.
