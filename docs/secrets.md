# Secrets

Popcorn reads Kubernetes Secrets. Do not put production secrets in Helm values
or commit generated credentials.

## Secret Map

| Secret | Required | Used by | Purpose |
| --- | --- | --- | --- |
| `gateway-jwt-keys` | yes | pool manager, gateway | Signs and verifies browser/CDP/API path tokens. |
| `pool-manager-service-auth` | yes | control plane, pool manager | Authenticates internal allocation calls. Use one per region in production. |
| `control-plane-secret` | yes when control plane is enabled | control plane, TTL controller | Admin auth and control-plane service token. |
| `analytics-db-secret` | yes when control plane is enabled | control plane, migrate job | Connection settings for the external Postgres database. |
| `browser-runtime-proxy-secret` | optional | browser runtime | Outbound HTTPS proxy URL for browser egress. |
| `otel-exporter-headers` | only when your OTLP backend requires headers | otel agent, pool manager | OTLP exporter header values such as authorization tokens. |
| `otel-clickhouse-secret` | only when `otel.enabled=true` and `otel.clickhouse.enabled=true` | pool manager, observability setup | Legacy ClickHouse credentials for optional session bindings. |

Default Secret names come from `charts/platform/values.yaml` and
`charts/browser-fleet/values.yaml`.

## `gateway-jwt-keys`

Keys:

| Key | Purpose |
| --- | --- |
| `private.pem` | Pool manager signs browser, CDP, and runtime API URLs. |
| `public.pem` | Gateway verifies signed path tokens. |

Local generation:

```bash
make local-keys
```

Production keys must stay stable across rollouts. Rotating them invalidates
active browser URLs.

Generate production key files:

```bash
openssl genrsa -out /tmp/popcorn-jwt-private.pem 2048
openssl rsa -in /tmp/popcorn-jwt-private.pem -pubout -out /tmp/popcorn-jwt-public.pem
```

## `pool-manager-service-auth`

Keys:

| Key | Purpose |
| --- | --- |
| `POOL_MANAGER_SERVICE_AUTH_TOKEN` | Shared secret for control-plane calls to one regional pool manager. |

For multi-region deployments, create one Secret per region and reference it in
`controlPlane.regions[].poolManagerAuth.secretName`.

## `control-plane-secret`

Keys:

| Key | Purpose |
| --- | --- |
| `CONTROL_PLANE_SERVICE_AUTH_TOKEN` | Authenticates trusted control-plane service calls, including TTL callbacks. |
| `ADMIN_USER` | Password-login username. |
| `ADMIN_PASS` | Password-login password. |
| `ADMIN_SESSION_SECRET` | Cookie signing secret for browser admin login. |
| `ADMIN_TOKEN` | Bearer token for trusted operational API access. |
| `ADMIN_GOOGLE_CLIENT_ID` | Optional Google OAuth client ID. |
| `ADMIN_GOOGLE_CLIENT_SECRET` | Optional Google OAuth client secret. |

Admin auth supports password login, bcrypt htpasswd files, and Google OAuth
with allowed emails or domains.

## `analytics-db-secret`

Keys:

| Key | Purpose |
| --- | --- |
| `host` | Postgres host. |
| `port` | Postgres port, usually `5432`. |
| `database` | Database name. |
| `username` | Database user. |
| `password` | Database password. |

The control plane and its database migrate job connect to an external Postgres
database using these values, where the control plane stores client records and
session analytics.

## `browser-runtime-proxy-secret`

Keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `HTTPS_PROXY_URL` | no | Outbound HTTPS proxy URL for browser egress. |

Optional. When present, the browser runtime reads `HTTPS_PROXY_URL` (mapped from
this Secret as an optional key reference) to route outbound HTTPS traffic through
a proxy. Omit the Secret or leave the key empty for direct egress.

## `otel-exporter-headers`

Required only when your external OTLP backend requires exporter headers.

Keys are operator-defined. Map OTLP header names to Secret keys with
`otel.exporter.headers`:

```yaml
otel:
  exporter:
    headersSecretName: otel-exporter-headers
    headers:
      Authorization: authorization
      x-scope-orgid: tenant
```

Create the Secret with the actual header values:

```bash
kubectl -n popcorn create secret generic otel-exporter-headers \
  --from-literal=authorization="$OTEL_EXPORTER_AUTHORIZATION" \
  --from-literal=tenant="$OTEL_EXPORTER_TENANT"
```

The chart renders only Secret references and environment variable references;
header values are not written into the collector ConfigMap or literal Pod env
values.

## `otel-clickhouse-secret`

Required only when `otel.enabled=true` and `otel.clickhouse.enabled=true`.

Keys:

| Key | Purpose |
| --- | --- |
| `CLICKHOUSE_ENDPOINT` | Native or service endpoint kept with the ClickHouse credentials. |
| `CLICKHOUSE_HTTP_ENDPOINT` | HTTP endpoint used by pool manager inserts. |
| `CLICKHOUSE_USERNAME` | ClickHouse username. |
| `CLICKHOUSE_PASSWORD` | ClickHouse password. |

The bundled collector exports browser GameServer logs and session lifecycle
events through `otel.exporter.*`. The ClickHouse Secret is used only by the
optional legacy pool-manager `session_bindings` writer.

See [Observability](observability.md) for backend-neutral OTLP configuration,
the legacy table schema, and exported fields.

## Direct Kubernetes Secret Bootstrap

Generate values first. Point the Postgres values at the external database that
will back the control plane and optional Metabase:

```bash
export POOL_MANAGER_SERVICE_AUTH_TOKEN=$(openssl rand -hex 32)
export CONTROL_PLANE_SERVICE_AUTH_TOKEN=$(openssl rand -hex 32)
export CONTROL_PLANE_ADMIN_USER=admin
export CONTROL_PLANE_ADMIN_PASS=$(openssl rand -base64 32)
export CONTROL_PLANE_ADMIN_SESSION_SECRET=$(openssl rand -hex 32)
export CONTROL_PLANE_ADMIN_TOKEN=$(openssl rand -hex 32)
export POSTGRES_HOST="replace-with-postgres-host"
export POSTGRES_PORT=5432
export POSTGRES_DATABASE=analytics
export POSTGRES_USER=analytics_admin
export POSTGRES_PASSWORD=$(openssl rand -base64 32)

# Optional: outbound HTTPS proxy for browser egress.
export HTTPS_PROXY_URL="replace-with-https-proxy-url"

# Only needed when otel.enabled=true and otel.clickhouse.enabled=true.
export CLICKHOUSE_ENDPOINT="replace-with-clickhouse-native-or-service-endpoint"
export CLICKHOUSE_HTTP_ENDPOINT="replace-with-clickhouse-http-endpoint"
export CLICKHOUSE_USERNAME="replace-with-clickhouse-username"
export CLICKHOUSE_PASSWORD="replace-with-clickhouse-password"
```

Then create the Kubernetes Secrets:

```bash
kubectl create namespace popcorn --dry-run=client -o yaml | kubectl apply -f -

kubectl -n popcorn create secret generic gateway-jwt-keys \
  --from-file=private.pem=/tmp/popcorn-jwt-private.pem \
  --from-file=public.pem=/tmp/popcorn-jwt-public.pem

kubectl -n popcorn create secret generic pool-manager-service-auth \
  --from-literal=POOL_MANAGER_SERVICE_AUTH_TOKEN="$POOL_MANAGER_SERVICE_AUTH_TOKEN"

kubectl -n popcorn create secret generic control-plane-secret \
  --from-literal=CONTROL_PLANE_SERVICE_AUTH_TOKEN="$CONTROL_PLANE_SERVICE_AUTH_TOKEN" \
  --from-literal=ADMIN_USER="$CONTROL_PLANE_ADMIN_USER" \
  --from-literal=ADMIN_PASS="$CONTROL_PLANE_ADMIN_PASS" \
  --from-literal=ADMIN_SESSION_SECRET="$CONTROL_PLANE_ADMIN_SESSION_SECRET" \
  --from-literal=ADMIN_TOKEN="$CONTROL_PLANE_ADMIN_TOKEN"

kubectl -n popcorn create secret generic analytics-db-secret \
  --from-literal=host="$POSTGRES_HOST" \
  --from-literal=port="${POSTGRES_PORT:-5432}" \
  --from-literal=database="${POSTGRES_DATABASE:-analytics}" \
  --from-literal=username="$POSTGRES_USER" \
  --from-literal=password="$POSTGRES_PASSWORD"

# Optional: only needed to route browser egress through an HTTPS proxy.
kubectl -n popcorn create secret generic browser-runtime-proxy-secret \
  --from-literal=HTTPS_PROXY_URL="$HTTPS_PROXY_URL"

# Only needed when otel.enabled=true and otel.clickhouse.enabled=true.
kubectl -n popcorn create secret generic otel-clickhouse-secret \
  --from-literal=CLICKHOUSE_ENDPOINT="$CLICKHOUSE_ENDPOINT" \
  --from-literal=CLICKHOUSE_HTTP_ENDPOINT="$CLICKHOUSE_HTTP_ENDPOINT" \
  --from-literal=CLICKHOUSE_USERNAME="$CLICKHOUSE_USERNAME" \
  --from-literal=CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD"
```

See `examples/kubernetes/existing-secrets.example.yaml` for a complete
placeholder manifest.

## GCP Secret Manager

For GKE, the recommended flow is:

1. Install External Secrets Operator.
2. Configure `ClusterSecretStore/gcpsm` with Workload Identity.
3. Store secret values in GCP Secret Manager.
4. Sync them into the Kubernetes Secret names listed above.

See `examples/kubernetes/external-secrets.example.yaml` for placeholder
mappings.

## Rotation

After changing Secrets, restart affected workloads:

```bash
kubectl -n popcorn rollout restart deployment/pool-manager deployment/popcorn-gateway
kubectl -n popcorn rollout restart deployment/control-plane deployment/ttl-controller
```

After rotating browser runtime Secrets such as `browser-runtime-proxy-secret`,
recycle browser GameServers so new pods read fresh values:

```bash
kubectl -n popcorn delete gameserver --all
```
