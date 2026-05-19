# Configuration

Popcorn is configured through Helm values and Kubernetes Secrets. Keep the base
deployment small, then enable optional pieces one at a time.

## Required Configuration

| Area | Values | Why it matters |
| --- | --- | --- |
| Deployment identity | `clusterName`, `provider`, `region` | Labels sessions and chooses provider-specific behavior. |
| Images | `registry`, `imageTag`, `browserRuntimeImage`, `imagePullSecrets` | Controls what runs in the cluster. Pin digests for production. |
| Gateway | `gateway.enabled`, `gateway.domainName`, `gateway.staticIpName`, `gateway.serviceType` | Public entry point for browser, CDP, API, and proof routes. |
| Pool manager | `poolManager.enabled`, `poolManager.serviceAuth`, `poolManager.gameServerFleet` | Allocates Agones browser GameServers. |
| Browser fleet | `gatewayDomain`, `fleet.replicas`, `autoscaler.*` | Controls browser capacity and returned URLs. |
| Agones | `agones.install`, `agonesInstaller.*` | Optionally installs Agones from the browser-fleet chart for fresh clusters. |
| Control plane | `controlPlane.enabled`, `controlPlane.regions` | Client credential API and regional session routing. |
| Secrets | `secrets.*`, `browser-fleet.secrets.browserTurnName` | Names of required Kubernetes Secrets. |

## Optional Configuration

| Option | Values | Use when |
| --- | --- | --- |
| Bundled Redis | `redis.enabled` | You want the chart to run Redis for route state. |
| Bundled Postgres | `postgres.enabled` | You want a simple in-cluster database. Managed Postgres is better for production. |
| TTL cleanup | `ttlController.enabled`, `ttlController.ttlDuration` | You want old sessions cleaned up automatically. Recommended. |
| Browser TURN | `browser-turn-secret`, `webrtc.*` | Browser users are outside the same machine or direct UDP is unreliable. |
| Admin auth | `controlPlane.adminAuth.*` | You need password, htpasswd, or Google OAuth admin login. |
| Observability | `otel.*` | You want browser GameServer log export and ClickHouse session bindings. |
| Metabase | `metabase.*` | You want an internal analytics UI. |
| GKE node prescaler | `gkeNodePrescaler.*` | You want browser node pools scaled ahead of demand on GKE. |
| Attestation | `browserRuntimeAttestor.*`, `ccDevicePlugin.*` | You run compatible GCP confidential-computing nodes. |
| Extra routes | `fleet.extraPorts`, `poolManager.extraRoutePorts`, `gateway.extraSessionRoutes` | Your browser runtime exposes additional services. |

## Base Production Example

```yaml
# platform values
clusterName: popcorn-prod
provider: gcp
region: us-central1
registry: ghcr.io/reclaimprotocol/popcorn-oss
imageTag: <release-or-commit-tag>

poolManager:
  enabled: true

gateway:
  enabled: true
  replicas: 2
  domainName: gateway.example.com
  staticIpName: popcorn-gateway-ip

controlPlane:
  enabled: true
  regions:
    - name: us-central1
      poolManagerUrl: http://pool-manager.popcorn.svc.cluster.local
      publicGatewayUrl: https://gateway.example.com
      enabled: true

redis:
  enabled: true

ttlController:
  enabled: true
```

```yaml
# browser-fleet values
region: us-central1
gatewayDomain: gateway.example.com
browserRuntimeImage: ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime@sha256:<digest>

agones:
  install: true

agonesInstaller:
  gameservers:
    namespaces:
      - popcorn
    minPort: 59000
    maxPort: 61000

fleet:
  replicas: 2

autoscaler:
  minReplicas: 2
  maxReplicas: 20
```

## Advanced: Existing Database

Disable bundled Postgres and point `analytics-db-secret` at your database:

```yaml
postgres:
  enabled: false

controlPlane:
  enabled: true
  databaseSecretName: analytics-db-secret
  databaseSsl: true
```

`analytics-db-secret` must contain `host`, `port`, `database`, `username`, and
`password`.

## Advanced: Observability

Keep observability disabled until the base deployment can create sessions:

```yaml
otel:
  enabled: false
```

When enabled, `otel.*` deploys an OpenTelemetry collector DaemonSet for browser
GameServer logs and enables pool-manager ClickHouse writes for session
bindings:

```yaml
otel:
  enabled: true
  exporter:
    grpcEndpoint: otel-grpc.example.com:4317
  clickhouse:
    database: otel
    secretName: otel-clickhouse-secret
```

See [Observability](observability.md) for the required Secret, table shape, and
what data is exported.

## Advanced: Split Namespaces

Same-namespace installs are easier. If browser workloads must run elsewhere:

```yaml
poolManager:
  gameServerNamespace: popcorn-browsers

gkeNodePrescaler:
  namespace: popcorn-browsers
```

Make sure RBAC and referenced Secrets exist in the namespaces the charts use.

## Advanced: Existing Agones

If your cluster already has Agones installed, leave the dependency disabled:

```yaml
agones:
  install: false
```

For a fresh self-hosted cluster, enable the dependency in browser-fleet values:

```yaml
agones:
  install: true

agonesInstaller:
  gameservers:
    namespaces:
      - popcorn
    minPort: 59000
    maxPort: 61000
```

Agones is cluster-level infrastructure. Do not enable the dependency from more
than one browser-fleet release in the same cluster.

## Advanced: Extra Session Routes

Use matching names across the browser fleet, pool manager, and gateway:

```yaml
# browser-fleet values
fleet:
  extraPorts:
    - name: tool-http
      containerPort: 3000
      portPolicy: None
      protocol: TCP

# platform values
poolManager:
  extraRoutePorts:
    tool-http:
      routeKey: tool
      port: 3000
  extraSessionUrls:
    toolUrl: "{baseUrl}/tool/{sessionId}/{internalToken}/"

gateway:
  extraSessionRoutes:
    - pathPrefix: tool
      routeKey: tool
      tokenScope: internal
```

`extraSessionUrls` supports `{baseUrl}`, `{wsBase}`, `{sessionId}`,
`{browserPodId}`, `{restrictedToken}`, and `{internalToken}`.

## Validate Values

```bash
helm template popcorn-platform charts/platform \
  --values /tmp/popcorn-platform.yaml

helm template browser-fleet charts/browser-fleet \
  --values /tmp/popcorn-browser-fleet.yaml
```
