# Observability

Popcorn's bundled observability path is optional. Keep it disabled until the
base session lifecycle is healthy.

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
them to the configured OTLP gRPC endpoint.

The same flag also enables a pool-manager ClickHouse write that records the
session-to-GameServer binding in `session_bindings`.

## Enable Or Disable

Disabled is the default:

```yaml
otel:
  enabled: false
```

Enable it only after your OTLP backend and ClickHouse table are ready:

```yaml
otel:
  enabled: true
  exporter:
    grpcEndpoint: otel-grpc.example.com:4317
  clickhouse:
    database: otel
    secretName: otel-clickhouse-secret
```

To turn it off again, set `otel.enabled=false` and upgrade the platform release.
Helm removes the collector DaemonSet, ConfigMap, and RBAC resources. The pool
manager stops requiring ClickHouse credentials and stops writing session
bindings.

## Required Secret

When `otel.enabled=true`, create `otel-clickhouse-secret` in the Popcorn
namespace:

```bash
kubectl -n popcorn create secret generic otel-clickhouse-secret \
  --from-literal=CLICKHOUSE_ENDPOINT="$CLICKHOUSE_ENDPOINT" \
  --from-literal=CLICKHOUSE_HTTP_ENDPOINT="$CLICKHOUSE_HTTP_ENDPOINT" \
  --from-literal=CLICKHOUSE_USERNAME="$CLICKHOUSE_USERNAME" \
  --from-literal=CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD"
```

`CLICKHOUSE_HTTP_ENDPOINT` is used by the pool manager for inserts. The chart
also expects `CLICKHOUSE_ENDPOINT` so deployments can keep both native and HTTP
endpoint values in the same Secret.

## ClickHouse Table

Create the session binding table before enabling the feature:

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

## What It Captures

The collector exports logs from browser GameServer pods only. It does not export
gateway, pool-manager, control-plane, Redis, Postgres, or Kubernetes event logs.

Each exported log record includes the parsed container log body plus metadata
such as:

- `service.name=popcorn`;
- `cluster.name`;
- `k8s.namespace.name`;
- `k8s.pod.name`;
- `k8s.pod.uid`;
- `k8s.container.name`;
- `k8s.node.name`;
- `agones.dev.role`;
- `agones.dev.fleet`;
- `Source`, copied from the container name.

The pool-manager ClickHouse row is not a log. It records:

- `session_id`;
- `cluster_name`;
- `namespace`;
- `pod_name`;
- `pod_uid`;
- `bound_at`.

Use `session_bindings.pod_uid` to join a session to browser logs that carry the
same Kubernetes pod UID.

## Verify

```bash
kubectl -n popcorn get daemonset otel-agent
kubectl -n popcorn logs daemonset/otel-agent --tail=100
kubectl -n popcorn get secret otel-clickhouse-secret
```

Then create a session and check that:

- your OTLP backend receives browser GameServer logs;
- `otel.session_bindings` receives one row for the new session;
- collector logs do not show exporter connection errors.

## Current Limits

- There is no separate "logs only" switch. `otel.enabled=true` currently enables
  both the collector and the pool-manager ClickHouse binding writer.
- Metrics and traces are not wired by the bundled collector config.
- The collector reads host log paths, so it needs node-level log access through
  `hostPath` mounts.
- The OTLP endpoint must accept the collector's gRPC export. Use the endpoint
  format required by your backend and configure TLS, authentication, or network
  policy at your backend or ingress layer.
