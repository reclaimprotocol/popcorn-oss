# Observability

The bundled observability path exports browser container logs and pool-manager
session lifecycle events through OTLP. It does not currently provide a complete
metrics or tracing stack.

## Signals

| Signal | Source | Delivery |
| --- | --- | --- |
| Browser/container logs | node log files for Agones GameServers | OTEL agent DaemonSet to OTLP |
| `session.start` and `session.end` events | pool manager | direct OTLP log export |
| Platform application logs | stdout/stderr | Kubernetes logging unless collected externally |
| Kubernetes events and workload status | Kubernetes API | operator tooling |
| Metrics | infrastructure/provider tooling | not supplied as a complete Popcorn metrics stack |

## Enable OTLP export

Choose exactly one endpoint:

```yaml
otel:
  enabled: true
  exporter:
    grpcEndpoint: otel-collector.example.com:4317
    httpEndpoint: null
    tls: {}
```

Or:

```yaml
otel:
  enabled: true
  exporter:
    grpcEndpoint: null
    httpEndpoint: https://otel-collector.example.com
```

Chart rendering fails when both or neither endpoint is set while OTEL is
enabled.

## Exporter headers

Map outgoing header names to keys in one Kubernetes Secret:

```yaml
otel:
  exporter:
    headersSecretName: otel-exporter-headers
    headers:
      Authorization: authorization
      X-Tenant-ID: tenant-id
```

Create those keys without printing their values. Header names are converted to
environment-variable-safe names in the rendered workloads.

## Browser log collection

The OTEL agent runs as a DaemonSet, mounts node container log directories
read-only, and reads logs for `browser-fleet-*` GameServer pods in the release
namespace. File-storage state under `/var/lib/popcorn/otel-agent/file-storage`
tracks read offsets across collector restarts on the same node.

It enriches records with Kubernetes pod/node metadata, Agones Fleet/role
labels, cluster identity, and—after session binding—the `session.id` attribute.
Pre-allocation startup logs intentionally lack a session ID.

Schedule the agent on every node that may run browser GameServers. With a
dedicated browser pool, mirror its node selector and toleration:

```yaml
otel:
  agent:
    nodeSelector:
      cloud.google.com/gke-nodepool: browser
    tolerations:
      - key: browser
        operator: Equal
        value: "true"
        effect: NoSchedule
```

## Lifecycle events

The pool manager emits structured `session.start` and `session.end` OTLP log
records when direct OTLP export is configured. Useful attributes include
session ID, cluster, region, namespace, pod identity, and event time.

Lifecycle export failure must not be treated as proof that allocation or
deletion failed. Correlate control-plane records, Redis state, Agones objects,
and application logs.

## Useful operational views

Build dashboards or queries for:

- session creation success/failure by region;
- allocation latency and no-capacity failures;
- Ready, Allocated, Pending, and unhealthy GameServers;
- browser pod startup and image-pull duration;
- gateway 4xx/5xx and WebSocket upgrade failures;
- pool-manager Redis and Agones errors;
- control-plane Postgres and regional dependency errors;
- TTL deletion failures;
- session duration and abnormal termination rate.

The exact metrics must come from your Kubernetes, load balancer, database,
Redis, and log backends; the chart does not install Prometheus.

## Verify export

```bash
kubectl -n popcorn rollout status daemonset/otel-agent
kubectl -n popcorn logs daemonset/otel-agent --tail=200
kubectl -n popcorn get pods -l app=otel-agent -o wide
```

Create and delete one canary session, then confirm:

- browser log records arrive;
- post-allocation records include `session.id`;
- one `session.start` and one `session.end` lifecycle record are present;
- cluster and region attributes match the deployment.

## Log hygiene

Do not export full session URLs, path tokens, client secrets, admin tokens, or
decoded Kubernetes Secrets. Configure redaction at application, ingress, agent,
and destination layers. Review diagnostic exports before sharing them.

## Legacy ClickHouse option

`otel.clickhouse.enabled=true` enables legacy direct session-binding writes
from the pool manager using `otel-clickhouse-secret`. It is not required for
OTLP logs and should remain disabled unless an existing deployment depends on
it.
