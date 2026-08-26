# Configuration

Popcorn uses two values documents: one for `charts/platform` and one for
`charts/browser-fleet`. Keep environment-specific values in a private
deployment repository and keep the chart defaults unchanged.

This page explains how to choose values. The exhaustive key and default list is
in [Helm values reference](chart-options.md).

## Values layering

Use a small base plus one environment overlay:

```text
deploy/
├── platform-base.yaml
├── browser-base.yaml
└── production/
    ├── platform.yaml
    └── browser.yaml
```

Render the exact combination that will be installed:

```bash
helm template popcorn-platform charts/platform \
  --namespace popcorn \
  -f deploy/platform-base.yaml \
  -f deploy/production/platform.yaml
```

Avoid large collections of `--set` flags in production. They are hard to review
and easy to lose during an upgrade.

## Deployment identity and images

Set stable names that match the control-plane region configuration:

```yaml
clusterName: popcorn-prod-us
provider: gcp
region: us-central1
registry: ghcr.io/reclaimprotocol/popcorn-oss
imageTag: <pinned-release>
```

`clusterName` controls client access lists and analytics identity. Treat a
rename as a migration, not a cosmetic change. The browser image is configured
separately:

```yaml
browserRuntimeImage: ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime@sha256:<digest>
browserRuntimeImagePullPolicy: IfNotPresent
```

## Choose route-state Redis

Exactly one design should be authoritative:

| Design | Values | Use |
| --- | --- | --- |
| Simple in-cluster Redis | `redis.enabled=true` | Local testing and non-critical evaluation only |
| Bundled HA Redis | `redisHa.enabled=true` | Production when the chart owns Redis |
| External Redis | both disabled; set pool-manager and gateway hosts | Production when Redis is managed elsewhere |

The simple Redis Deployment has no persistent volume. Do not increase its
replica count expecting HA; independent Redis processes do not form a shared
store.

For bundled HA Redis, point both `poolManager.redisHost` and
`gateway.redisHost` at `redis-ha-master`. For an external service, point both at
the same authoritative endpoint unless a documented migration deliberately
uses `poolManager.redisSecondaryHost`.

## Configure the gateway

For the chart-managed GKE Ingress:

```yaml
gateway:
  enabled: true
  replicas: 3
  domainName: browser.example.com
  staticIpName: popcorn-gateway-ip
  serviceType: ClusterIP
  podDisruptionBudget:
    enabled: true
    minAvailable: 2
```

Setting `staticIpName` creates a GCE Ingress. Adding `domainName` also creates a
ManagedCertificate and HTTPS redirect. The chart automatically enables a GKE
Network Endpoint Group on the Service. For a private or externally managed
ingress, leave `staticIpName` empty and configure the Service and external
proxy deliberately. The proxy must support long-lived WebSockets.

## Configure the pool manager

```yaml
poolManager:
  enabled: true
  gameServerNamespace: popcorn
  gameServerFleet: browser-fleet
  redisHost: redis-ha-master.popcorn.svc.cluster.local
  serviceAuth:
    secretName: pool-manager-us-service-auth
    secretKey: POOL_MANAGER_SERVICE_AUTH_TOKEN
```

The pool manager and browser Fleet must refer to the same namespace and Fleet
name. The service token is a regional trust boundary; use a distinct token for
each pool manager.

## Configure the control plane

The control plane needs Postgres and at least one enabled region:

```yaml
controlPlane:
  enabled: true
  replicas: 2
  databaseSsl: true
  databaseSecretName: analytics-db-secret
  sessionMaxTtlSeconds: 900
  regions:
    - name: us-central1
      clusterName: popcorn-prod-us
      poolManagerUrl: http://pool-manager.popcorn.svc.cluster.local
      publicGatewayUrl: https://browser.example.com
      enabled: true
      poolManagerAuth:
        secretName: pool-manager-us-service-auth
        secretKey: POOL_MANAGER_SERVICE_AUTH_TOKEN
```

`name` is the region value clients may request. `clusterName` is the access-list
identity stored on clients. `publicGatewayUrl` is used to construct returned
session URLs and must match the public TLS endpoint.

Keep the control plane private unless clients must call it directly. If public,
expose only the intended paths and protect `/admin` separately.

## Configure browser capacity

```yaml
fleet:
  replicas: 10
  browserRuntimeCpuRequest: "1000m"
  browserRuntimeCpuLimit: "2000m"
  browserRuntimeMemoryRequest: 2Gi
  browserRuntimeMemoryLimit: 4Gi

autoscaler:
  bufferSize: 5
  minReplicas: 10
  maxReplicas: 50
```

`bufferSize` is warm capacity, not total capacity. Coordinate these values with
the browser node-pool autoscaler. Use node selectors and tolerations when
browser workers have dedicated or sandboxed nodes.

LiveView and CDP are built in. The Fleet always exposes fixed pod ports with
Agones `portPolicy: None`; there is no streaming mode or host-port range.

## Browser policy and environment

```yaml
browserPolicy:
  variant: neutral

extraBrowserRuntimeEnv:
  - name: APP_URL
    value: https://example.com/start
  - name: CLOAK_TIMEZONE
    value: America/New_York
```

Environment entries use the Kubernetes `env` shape and support `valueFrom`.
See [Browser runtime](popcorn-browser.md) for runtime variables and security
profiles.

## Session extensions

An extension is an optional service in the browser pod. Define it once in a
keyed map and load the same document into both charts:

```yaml
sessionExtensions:
  tool:
    enabled: true
    browser:
      ports:
        - name: tool-http
          containerPort: 3000
          portPolicy: None
          protocol: TCP
      containers:
        - name: tool
          image: registry.example.com/tool@sha256:<digest>
          ports:
            - name: tool-http
              containerPort: 3000
    routing:
      portName: tool-http
      port: 3000
      routeKey: tool
      sessionUrls:
        toolUrl: "{baseUrl}/tool/{sessionId}/{internalToken}/"
      gatewayRoutes:
        - pathPrefix: tool
          routeKey: tool
          tokenScope: internal
```

The keyed map is intentional: Helm merges extension names while it replaces
lists. Do not create separate container, port, pool-manager, and gateway lists.
VNC and CDP are core routes and must not be restated as extensions.

## Optional components

Enable one optional area at a time after the core acceptance test passes:

- `ttlController.enabled`: recommended session cleanup.
- `otel.enabled`: browser log collection and session lifecycle export.
- `imagePrepuller.enabled`: reduce cold pull time on browser nodes.
- `networkPolicy.ingressEnabled`: restrict browser ingress to the configured
  gateway and pool-manager namespaces;
- `networkPolicy.enabled`: restrict browser egress; review cluster-specific
  DNS and Kubernetes API CIDRs first.
- `browserRuntimeAttestor.enabled` and `ccDevicePlugin.enabled`: confidential
  attestation only.
- `controlPlane.x402.enabled`: isolated paid-session API only.

## Configuration checks

Before applying values:

- [ ] Both charts render with no schema errors.
- [ ] Images are pinned and available to every target node.
- [ ] Exactly one Redis design is authoritative.
- [ ] Region names, cluster names, URLs, Fleet names, and Secret names align.
- [ ] Public URLs use TLS and WebSocket-capable infrastructure.
- [ ] Browser capacity fits within node autoscaling limits.
- [ ] Optional components have their dependencies and Secrets.
