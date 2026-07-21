# Configuration

Popcorn is configured through Helm values and Kubernetes Secrets. Keep the base
deployment small, then enable optional pieces one at a time.

## Required Configuration

| Area | Values | Why it matters |
| --- | --- | --- |
| Deployment identity | `clusterName`, `provider`, `region` | Labels sessions and chooses provider-specific behavior. |
| Images | `registry`, `imageTag`, `browserRuntimeImage`, `imagePullSecrets` | Controls what runs in the cluster. Pin digests for production. |
| Gateway | `gateway.enabled`, `gateway.domainName`, `gateway.staticIpName`, `gateway.serviceType` | Public entry point for browser, CDP, API, and proof routes. `staticIpName` can be used without `domainName` for an HTTP IP-only GKE Ingress. |
| Pool manager | `poolManager.enabled`, `poolManager.serviceAuth`, `poolManager.gameServerFleet` | Allocates Agones browser GameServers. |
| Browser fleet | `gatewayDomain`, `fleet.replicas`, `autoscaler.*` | Controls browser capacity and returned URLs. |
| Agones | `agones.install`, `agonesInstaller.*` | Optionally installs Agones from the browser-fleet chart for fresh clusters. Keep `agones.install=false` after installing Agones as cluster infrastructure. |
| Control plane | `controlPlane.enabled`, `controlPlane.regions`, `controlPlane.sessionMaxTtlSeconds` | Client credential API, regional session routing, and maximum client-requested TTL. |
| Secrets | `secrets.*`, `browser-fleet.secrets.browserRuntimeProxyName` | Names of required Kubernetes Secrets. |

## Optional Configuration

| Option | Values | Use when |
| --- | --- | --- |
| Bundled Redis | `redis.enabled` | You want the chart to run Redis for route state. |
| TTL cleanup | `ttlController.enabled`, `ttlController.ttlDuration` | You want old sessions cleaned up automatically. Recommended. |
| Browser runtime env | `extraBrowserRuntimeEnv`, `secrets.browserRuntimeProxyName` | You need to tune the browser image (persona, startup URL, CDP ports) or route egress through an HTTPS proxy. |
| Admin auth | `controlPlane.adminAuth.*` | You need password, htpasswd, or Google OAuth admin login. |
| Observability | `otel.*` | You want backend-neutral OTLP export for browser logs and session lifecycle events. |
| GKE node prescaler | `gkeNodePrescaler.*` | You want browser node pools scaled ahead of demand on GKE. |
| Attestation | `browserRuntimeAttestor.*`, `ccDevicePlugin.*` | You run compatible GCP confidential-computing nodes. |
| Extra routes | `fleet.extraPorts`, `poolManager.extraRoutePorts`, `gateway.extraSessionRoutes` | Your browser runtime exposes additional services. |

## Base Production Example

The default production example uses DNS and GKE ManagedCertificate. For a
domainless smoke test, use
[`examples/helm/platform-ip-values.yaml`](../examples/helm/platform-ip-values.yaml)
and
[`examples/helm/browser-fleet-ip-values.yaml`](../examples/helm/browser-fleet-ip-values.yaml).

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

streaming:
  mode: vnc

agones:
  install: false

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

## Streaming (Live View)

Popcorn streams the browser desktop over VNC / live view. The shipped browser
image is the minimal-vnc "Popcorn Browser" running Tilion Fortress and serves the
desktop through noVNC on port `6080`. Set `streaming.mode=vnc` in the
browser-fleet values.

Use the LiveView route names for the browser desktop surface. The API response
field names remain `vncUrl` and `vncWsUrl` for compatibility, but the URL paths
are `/liveview` and `/liveview-ws`:

```yaml
# browser-fleet values
streaming:
  mode: vnc

# platform values
poolManager:
  extraRoutePorts:
    novnc:
      routeKey: liveview
      port: 6080
  extraSessionUrls:
    url: "{baseUrl}/liveview/{sessionId}/{restrictedToken}/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000"
    vncUrl: "{baseUrl}/liveview/{sessionId}/{restrictedToken}/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000"
    vncWsUrl: "{wsBase}/liveview-ws/{sessionId}/{restrictedToken}"

gateway:
  extraSessionRoutes:
    - pathPrefix: liveview
      routeKey: liveview
```

`liveview.html` connects to `/websockify` relative to the LiveView route. The
gateway rewrites that relative path to the browser runtime's internal
`/websockify` endpoint. The standalone gateway also accepts `/liveview-ws` for
clients that need the raw WebSocket URL.

## Browser Runtime Environment

Use `extraBrowserRuntimeEnv` in the browser-fleet values to pass additional
environment variables into the `browser-runtime` container. Entries are standard
Kubernetes env entries and are templated, so `value` and `valueFrom` both work:

```yaml
# browser-fleet values
extraBrowserRuntimeEnv:
  - name: APP_URL
    value: "https://example.com/start"
  - name: CHROMIUM_FLAGS
    value: "--window-size=1920,1080"
  - name: CLOAK_FINGERPRINT_PLATFORM
    value: "linux"
```

The shipped image reads two groups of knobs:

- Persona / stealth (`start-chromium`): `CLOAK_*` (for example
  `CLOAK_FINGERPRINT_SEED`, `CLOAK_TIMEZONE`, `CLOAK_LOCALE`,
  `CLOAK_FINGERPRINT_PLATFORM`, `CLOAK_ALLOW_3P_COOKIES`, `CLOAK_PROFILE_SEED`)
  and `TILION_*` (`TILION_TZ`, `TILION_LANG`) tune the default Tilion Fortress
  Windows persona and timezone/locale coherence.
- Runtime config: `APP_URL`, `CHROMIUM_FLAGS`, `REPLACE_DEFAULT_PAGE`,
  `READY_WINDOW_PATTERN`, `NOVNC_PORT`, the CDP port knobs (`CDP_INTERNAL_PORT`,
  `CDP_RESTRICTED_PORT`, `CDP_FULL_PORT`, listen/upstream addresses),
  `RECLAIM_ROUTER_URL`, and related settings.

See the full table in
[`images/minimal-vnc-desktop/README.md`](../images/minimal-vnc-desktop/README.md)
under "Runtime Configuration" for every supported variable, defaults, and
behavior.

## Advanced: Existing Postgres

Point `analytics-db-secret` at your database:

```yaml
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
GameServer logs. Pool-manager session lifecycle events are sent directly to the
configured external OTLP endpoint over the selected protocol. Configure exactly
one external collector endpoint:

```yaml
otel:
  enabled: true
  exporter:
    grpcEndpoint: otel-grpc.example.com:4317
```

If your OTLP backend requires headers, create a Secret and map header names to
Secret keys:

```yaml
otel:
  exporter:
    headersSecretName: otel-exporter-headers
    headers:
      Authorization: authorization
```

ClickHouse session bindings are a legacy fallback and must be enabled
explicitly:

```yaml
otel:
  clickhouse:
    enabled: true
    database: otel
    secretName: otel-clickhouse-secret
```

See [Observability](observability.md) for session correlation semantics,
exporter recipes, and exported fields.

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

For a fresh self-hosted cluster, install Agones before browser-fleet:

```bash
helm upgrade --install agones charts/browser-fleet/charts/agones-1.57.0.tgz \
  --namespace agones-system \
  --create-namespace \
  --set agones.controller.generateTLS=false \
  --set gameservers.minPort=59000 \
  --set gameservers.maxPort=61000 \
  --set-json 'gameservers.namespaces=["popcorn"]'
```

Then keep the dependency disabled in browser-fleet values:

```yaml
agones:
  install: false

agonesInstaller:
  gameservers:
    namespaces:
      - popcorn
    minPort: 59000
    maxPort: 61000
```

Agones is cluster-level infrastructure. Do not enable the dependency from more
than one browser-fleet release in the same cluster.

## Advanced: GKE IP-Only Gateway

Use this when DNS is not ready and you only need a GKE smoke test:

```yaml
gateway:
  enabled: true
  domainName: ""
  staticIpName: popcorn-oss-ip-test-gateway-ip

controlPlane:
  enabled: true
  serviceType: ClusterIP
  regions:
    - name: us-central1
      publicGatewayUrl: http://<gateway-ip>
```

With `staticIpName` set and `domainName` empty, the chart renders a hostless
HTTP GKE Ingress. ManagedCertificate and HTTPS redirect are created only when a
domain name is configured.

For a temporary public control-plane test without DNS, reserve a second global
static IP and set:

```yaml
controlPlane:
  domainName: ""
  staticIpName: popcorn-oss-ip-test-control-plane-ip
```

This is HTTP-only. For production, use DNS and TLS or keep the control plane on
a private access path.

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
