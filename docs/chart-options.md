# Helm values reference

This is the operator-facing reference for the values shipped by Popcorn's two
charts. Defaults come from each chart's `values.yaml`; production values should
override images, capacity, exposure, and Secret names deliberately.

Use [Configuration](configuration.md) to choose values and
[Production installation](deployment.md) to apply them.

## Platform chart

### Deployment and scheduling

| Key | Default | Purpose |
| --- | --- | --- |
| `clusterName` | `local` | Cluster identity stored with sessions. |
| `provider` | `gcp` | Provider behavior; supported values are `gcp` and `kind`. |
| `region` | `asia-south1` | Region identity returned with sessions. |
| `registry` | `ghcr.io/reclaimprotocol/popcorn-oss` | Registry for Popcorn service images. |
| `imageTag` | `latest` | Shared platform image tag. Pin a release or digest-backed build in production. |
| `imagePullSecrets` | `[]` | Pod image-pull Secret references. |
| `nodeSelector` | `{}` | Default node selector for platform workloads. |
| `tolerations` | `[]` | Default platform tolerations. |
| `affinity` | `{}` | Default platform affinity. |
| `secrets.gatewayJwtName` | `gateway-jwt-keys` | JWT signing and verification Secret. |
| `secrets.poolManagerServiceAuthName` | `pool-manager-service-auth` | Pool-manager service-auth Secret. |
| `secrets.controlPlaneName` | `control-plane-secret` | Control-plane service and admin Secret. |
| `secrets.controlPlaneDatabaseName` | `analytics-db-secret` | Control-plane Postgres Secret. |
| `sessionExtensions` | `{}` | Keyed optional same-pod services; see [Session extensions](#session-extensions). |

### Pool manager

| Key | Default | Purpose |
| --- | --- | --- |
| `poolManager.enabled` | `false` | Deploy the pool manager. |
| `poolManager.replicas` | `1` | Deployment replicas. |
| `poolManager.imagePullPolicy` | `Always` | Container image pull policy. |
| `poolManager.redisHost` | `redis` | Primary route-state Redis host. |
| `poolManager.redisSecondaryHost` | `""` | Optional secondary Redis host during HA migration. |
| `poolManager.gameServerNamespace` | `""` | GameServer namespace; empty uses the Helm release namespace. |
| `poolManager.gameServerFleet` | `browser-fleet` | Agones Fleet name. |
| `poolManager.jwtSecretName` | `""` | Override for the gateway JWT Secret. |
| `poolManager.serviceAuth.secretName` | `""` | Override for the service-auth Secret. |
| `poolManager.serviceAuth.secretKey` | `POOL_MANAGER_SERVICE_AUTH_TOKEN` | Key inside the service-auth Secret. |
| `poolManager.resources.requests.cpu` | `100m` | CPU request. |
| `poolManager.resources.requests.memory` | `128Mi` | Memory request. |
| `poolManager.resources.limits.cpu` | `500m` | CPU limit. |
| `poolManager.resources.limits.memory` | `256Mi` | Memory limit. |

The core LiveView, restricted CDP, and internal CDP routes need no values.
Optional service route ports and response fields come only from
`sessionExtensions`.

### Gateway

| Key | Default | Purpose |
| --- | --- | --- |
| `gateway.enabled` | `true` | Deploy the browser gateway. |
| `gateway.replicas` | `1` | Deployment replicas. Use at least three for production HA. |
| `gateway.imagePullPolicy` | `Always` | Container image pull policy. |
| `gateway.updateStrategy.maxSurge` | `1` | Rolling-update surge. |
| `gateway.updateStrategy.maxUnavailable` | `0` | Rolling-update unavailable allowance. |
| `gateway.podDisruptionBudget.enabled` | `false` | Create a disruption budget. |
| `gateway.podDisruptionBudget.minAvailable` | `1` | Minimum available gateway pods. |
| `gateway.topologySpreadConstraints` | `[]` | Kubernetes topology-spread constraints. |
| `gateway.terminationGracePeriodSeconds` | `75` | Pod termination grace period. |
| `gateway.gracefulShutdown.enabled` | `true` | Delay and gracefully stop OpenResty. |
| `gateway.gracefulShutdown.delaySeconds` | `60` | Drain delay before OpenResty exits. |
| `gateway.domainName` | `""` | Public DNS name; enables managed HTTPS resources when set. |
| `gateway.staticIpName` | `""` | GCP global static-IP resource name; creates GCE Ingress and enables a NEG. |
| `gateway.serviceType` | `LoadBalancer` | Kubernetes Service type. |
| `gateway.redisHost` | `""` | Route Redis host; empty uses the release-local Redis service. |
| `gateway.poolManagerHost` | `""` | Pool-manager service host override. |
| `gateway.nodePorts` | `{}` | Optional named NodePort assignments, such as `http`. |
| `gateway.serviceAnnotations` | `{}` | Service annotations. |
| `gateway.backendConfig.enabled` | `true` | Create the GKE BackendConfig. |
| `gateway.backendConfig.timeoutSec` | `3600` | Backend request timeout. |
| `gateway.backendConfig.connectionDrainingTimeoutSec` | `60` | GKE connection-draining timeout. |
| `gateway.jwtSecretName` | `""` | Override for the JWT verification Secret. |
| `gateway.jwtPrivateKeySecretId` | `""` | Secret Manager ID used by ExternalSecret. |
| `gateway.jwtPublicKeySecretId` | `""` | Secret Manager ID used by ExternalSecret. |
| `gateway.resources.requests.cpu` | `100m` | CPU request. |
| `gateway.resources.requests.memory` | `64Mi` | Memory request. |
| `gateway.resources.limits.cpu` | `500m` | CPU limit. |
| `gateway.resources.limits.memory` | `256Mi` | Memory limit. |

### Redis

Choose one route-state backend.

| Key | Default | Purpose |
| --- | --- | --- |
| `redis.enabled` | `false` | Deploy the simple single-instance Redis. |
| `redis.replicas` | `1` | Simple Redis replicas; normal operation uses one. |
| `redis.image` | `redis:7-alpine` | Simple Redis image. |
| `redis.imagePullPolicy` | `IfNotPresent` | Simple Redis pull policy. |
| `redis.resources.requests.cpu` / `redis.resources.requests.memory` | `50m` / `64Mi` | Simple Redis requests. |
| `redis.resources.limits.cpu` / `redis.resources.limits.memory` | `250m` / `256Mi` | Simple Redis limits. |
| `redisHa.enabled` | `false` | Deploy the bundled Bitnami Redis dependency. |
| `redisHa.fullnameOverride` | `redis-ha` | Stable HA resource prefix. |
| `redisHa.architecture` | `replication` | Redis dependency architecture. |
| `redisHa.auth.enabled` | `false` | Dependency authentication; Popcorn's default assumes private cluster networking. |
| `redisHa.commonConfiguration` | append-only configuration | Redis durability and write-safety configuration. |
| `redisHa.replica.replicaCount` | `3` | HA Redis replica count. |
| `redisHa.replica.automountServiceAccountToken` | `true` | Service-account token behavior required by the dependency. |
| `redisHa.replica.podAntiAffinityPreset` | `hard` | Replica anti-affinity preset. |
| `redisHa.replica.topologySpreadConstraints` | zone spread | Replica topology policy. |
| `redisHa.replica.persistence.enabled` | `true` | Enable persistent volumes. |
| `redisHa.replica.persistence.storageClass` | `standard-rwo` | Storage class. |
| `redisHa.replica.persistence.size` | `8Gi` | Volume size. |
| `redisHa.replica.pdb.create` / `redisHa.replica.pdb.maxUnavailable` | `true` / `1` | Replica disruption budget. |
| `redisHa.replica.resources.requests.cpu` / `redisHa.replica.resources.requests.memory` | `100m` / `128Mi` | HA replica requests. |
| `redisHa.replica.resources.limits.cpu` / `redisHa.replica.resources.limits.memory` | `250m` / `256Mi` | HA replica limits. |
| `redisHa.sentinel.enabled` | `true` | Enable Sentinel. |
| `redisHa.sentinel.image.digest` | pinned digest | Sentinel image digest. |
| `redisHa.sentinel.masterSet` | `reclaim-master` | Persistent Sentinel master-set identity; do not rename on an existing deployment. |
| `redisHa.sentinel.quorum` | `2` | Sentinel failover quorum. |
| `redisHa.sentinel.downAfterMilliseconds` | `5000` | Failure detection interval. |
| `redisHa.sentinel.failoverTimeout` | `30000` | Failover timeout. |
| `redisHa.sentinel.parallelSyncs` | `1` | Replicas synchronized in parallel. |
| `redisHa.sentinel.masterService.enabled` | `true` | Create the stable master service. |
| `redisHa.sentinel.resources.requests.cpu` / `redisHa.sentinel.resources.requests.memory` | `50m` / `64Mi` | Sentinel requests. |
| `redisHa.sentinel.resources.limits.cpu` / `redisHa.sentinel.resources.limits.memory` | `150m` / `192Mi` | Sentinel limits. |
| `redisHa.rbac.create` | `true` | Dependency RBAC. |
| `redisHa.serviceAccount.create` | `true` | Dependency ServiceAccount. |
| `redisHa.serviceAccount.automountServiceAccountToken` | `true` | Dependency token mount. |
| `redisHa.image.digest` | pinned digest | Redis image digest. |
| `redisHa.kubectl.image.digest` | pinned digest | Dependency helper image digest. |

`redisHa` is an aliased upstream dependency. Popcorn documents the overrides it
ships; additional dependency-specific keys are an advanced escape hatch and are
defined by the bundled chart archive.

### Control plane

| Key | Default | Purpose |
| --- | --- | --- |
| `controlPlane.enabled` | `false` | Deploy the client/admin API. |
| `controlPlane.replicas` | `1` | Deployment replicas. |
| `controlPlane.imagePullPolicy` | `Always` | Image pull policy. |
| `controlPlane.nodeEnv` | `production` | Node runtime environment. |
| `controlPlane.databaseSsl` | `false` | Require TLS to Postgres. |
| `controlPlane.databaseSslCa` | `""` | Inline database CA certificate. |
| `controlPlane.databaseSslCaFile` | `""` | Database CA path inside the pod. |
| `controlPlane.serviceType` | `ClusterIP` | Service type when no chart-managed Ingress is configured. |
| `controlPlane.domainName` | `""` | Primary public domain. |
| `controlPlane.staticIpName` | `""` | Primary GCP global static-IP name; creates GCE Ingress and enables a NEG. |
| `controlPlane.publicServicePort` | `3000` | Ingress backend service port. |
| `controlPlane.publicPaths` | `[/]` | Paths exposed by the primary ingress. |
| `controlPlane.additionalIngresses` | `[]` | Extra ingress objects with required `name`, `domainName`, `staticIpName`, `securityPolicyName`, and `publicPaths`. |
| `controlPlane.sessionMaxTtlSeconds` | `900` | Maximum client-requested session TTL. |
| `controlPlane.nodePorts` | `{}` | Optional named NodePort assignments. |
| `controlPlane.secretName` | `""` | Override for the control-plane Secret. |
| `controlPlane.databaseSecretName` | `""` | Override for the Postgres Secret. |
| `controlPlane.serviceAuthSecretKey` | `CONTROL_PLANE_SERVICE_AUTH_TOKEN` | Service token key. |
| `controlPlane.regions` | `[]` | Region objects; see below. |
| `controlPlane.resources.requests.cpu` / `controlPlane.resources.requests.memory` | `250m` / `256Mi` | Requests. |
| `controlPlane.resources.limits.cpu` / `controlPlane.resources.limits.memory` | `500m` / `512Mi` | Limits. |

Each `controlPlane.regions[]` entry requires `name`, `clusterName`,
`poolManagerUrl`, and `publicGatewayUrl`. It may set `enabled`, `x402Only`, and
`poolManagerAuth.secretName` / `secretKey`.

Admin authentication supports these keys:

| Key | Default |
| --- | --- |
| `controlPlane.adminAuth.strategies` | `password,google` |
| `controlPlane.adminAuth.sessionTtlSeconds` | `43200` |
| `controlPlane.adminAuth.sessionSecretKey` | `ADMIN_SESSION_SECRET` |
| `controlPlane.adminAuth.userKey` | `ADMIN_USER` |
| `controlPlane.adminAuth.passKey` | `ADMIN_PASS` |
| `controlPlane.adminAuth.tokenKey` | `ADMIN_TOKEN` |
| `controlPlane.adminAuth.passwordFileSecretName` | `""` |
| `controlPlane.adminAuth.passwordFileSecretKey` | `admin.htpasswd` |
| `controlPlane.adminAuth.googleClientIdKey` | `ADMIN_GOOGLE_CLIENT_ID` |
| `controlPlane.adminAuth.googleClientSecretKey` | `ADMIN_GOOGLE_CLIENT_SECRET` |
| `controlPlane.adminAuth.googleRedirectUri` | `""` |
| `controlPlane.adminAuth.googleAllowedEmails` | `""` |
| `controlPlane.adminAuth.googleAllowedDomains` | `""` |

The optional paid API supports these keys. See [Optional x402 API](x402.md)
before enabling it.

| Key | Default |
| --- | --- |
| `controlPlane.x402.enabled` | `false` |
| `controlPlane.x402.testnet` | `false` |
| `controlPlane.x402.network` | `""` |
| `controlPlane.x402.publicBaseUrl` | `""` |
| `controlPlane.x402.payTo` | `""` |
| `controlPlane.x402.blockSeconds` | `300` |
| `controlPlane.x402.pricePerBlockAtomic` | `10000` |
| `controlPlane.x402.paymentAssetAddress` | `""` |
| `controlPlane.x402.paymentAssetName` | `""` |
| `controlPlane.x402.paymentAssetVersion` | `2` |
| `controlPlane.x402.maxExtensionBlocks` | `12` |
| `controlPlane.x402.maxPaidBlocks` | `12` |
| `controlPlane.x402.regionName` | `""` |
| `controlPlane.x402.facilitatorUrl` | `""` |
| `controlPlane.x402.facilitatorAuthMode` | `auto` |
| `controlPlane.x402.trustedProxyHops` | `1` |
| `controlPlane.x402.rateLimitPerMinute` | `30` |
| `controlPlane.x402.secretName` | `control-plane-x402-secret` |
| `controlPlane.x402.serverSecretKey` | `X402_SERVER_SECRET` |
| `controlPlane.x402.baseRpcUrlSecretKey` | `X402_BASE_RPC_URL` |
| `controlPlane.x402.cdpApiKeyIdKey` | `CDP_API_KEY_ID` |
| `controlPlane.x402.cdpApiKeySecretKey` | `CDP_API_KEY_SECRET` |
| `controlPlane.x402.facilitatorAuthHeadersSecretKey` | `X402_FACILITATOR_AUTH_HEADERS` |

### Cleanup and observability

| Key | Default | Purpose |
| --- | --- | --- |
| `ttlController.enabled` | `false` | Deploy automatic session cleanup. |
| `ttlController.replicas` | `1` | Deployment replicas. |
| `ttlController.imagePullPolicy` | `Always` | Pull policy. |
| `ttlController.controlPlaneUrl` | `""` | Lifecycle reporting endpoint. |
| `ttlController.ttlDuration` | `15m` | Cleanup interval/age policy used by the controller. |
| `ttlController.resources.requests.cpu` / `ttlController.resources.requests.memory` | `200m` / `64Mi` | Requests. |
| `ttlController.resources.limits.cpu` / `ttlController.resources.limits.memory` | `500m` / `128Mi` | Limits. |
| `otel.enabled` | `false` | Deploy the OpenTelemetry agent. |
| `otel.image` | `otel/opentelemetry-collector-contrib:0.149.0` | Collector image. |
| `otel.imagePullPolicy` | `IfNotPresent` | Pull policy. |
| `otel.exporter.grpcEndpoint` | `null` | External OTLP/gRPC endpoint. |
| `otel.exporter.httpEndpoint` | `null` | External OTLP/HTTP endpoint. Set only one endpoint. |
| `otel.exporter.headersSecretName` | `""` | Secret containing exporter header values. |
| `otel.exporter.headers` | `{}` | Map of outgoing header name to Secret key. |
| `otel.exporter.tls` | `{}` | Exporter TLS settings, including optional `insecure`. |
| `otel.clickhouse.enabled` | `false` | Legacy ClickHouse session-binding export. |
| `otel.clickhouse.database` | `otel` | ClickHouse database. |
| `otel.clickhouse.secretName` | `otel-clickhouse-secret` | ClickHouse credential Secret. |
| `otel.agent.nodeSelector` / `otel.agent.tolerations` / `otel.agent.affinity` | empty | Agent scheduling. |
| `otel.agent.resources.requests.cpu` / `otel.agent.resources.requests.memory` | `100m` / `128Mi` | Agent requests. |
| `otel.agent.resources.limits.cpu` / `otel.agent.resources.limits.memory` | `250m` / `256Mi` | Agent limits. |

## Browser Fleet chart

### Core runtime and cluster integration

| Key | Default | Purpose |
| --- | --- | --- |
| `region` | `asia-south1` | Region exposed to the runtime and attestor. |
| `gatewayDomain` | `""` | Public gateway domain and attestation audience. |
| `agones.install` | `false` | Install the bundled Agones dependency. Use only for a single disposable/self-managed release. |
| `agonesInstaller.agones.controller.generateTLS` | `false` | Bundled dependency TLS generation setting. |
| `agonesInstaller.gameservers.namespaces` | `[default]` | Namespaces watched by the bundled Agones installation. |
| `externalSecrets.enabled` | `false` | Create browser ExternalSecret resources. |
| `imagePullSecrets` | `[]` | Image-pull Secret references. |
| `podSecurityContext.fsGroup` | `1000` | Browser pod filesystem group. |
| `podSecurityContext.fsGroupChangePolicy` | `OnRootMismatch` | Kubernetes group-change policy. |
| `browserRuntimeSecurityProfile` | `legacy` | `legacy` or `hardened` container security profile. |
| `runtimeClassName` | `""` | Optional runtime class, such as `gvisor`. |
| `secrets.browserRuntimeProxyName` | `browser-runtime-proxy-secret` | Optional browser proxy Secret. |
| `ccDevicePlugin.enabled` | `false` | Deploy the confidential-computing device plugin. |
| `serviceAccount.create` | `true` | Create and select `browser-sa`. |
| `serviceAccount.gcpServiceAccount` | `""` | Workload Identity service-account annotation. |
| `serviceAccount.automountServiceAccountToken` | `true` | Browser pod token mount. |
| `networkPolicy.enabled` | `false` | Create the browser egress NetworkPolicy. |
| `networkPolicy.kubernetesApiCidr` | `""` | Narrow Kubernetes API CIDR allowed for the Agones sidecar. |
| `browserRuntimeImage` | OSS `browser-runtime:latest` | Browser container image; pin a digest in production. |
| `browserRuntimeImagePullPolicy` | `IfNotPresent` | Browser image pull policy. |
| `browserPolicy.variant` | `neutral` | Managed browser policy: `neutral` or `reclaim-portal`. |
| `extraBrowserRuntimeEnv` | `[]` | Additional templated Kubernetes env entries. |
| `sessionExtensions` | `{}` | Keyed optional same-pod services. |

VNC LiveView (`novnc:6080`), restricted CDP (`cdp:9222`), and internal CDP
(`cdp-internal:9226`) are fixed core ports using `portPolicy: None`. They do not
consume Agones host ports and have no values switches.

### Fleet and capacity

| Key | Default | Purpose |
| --- | --- | --- |
| `fleet.replicas` | `10` | Initial Fleet replicas. |
| `fleet.scheduling` | `Packed` | Agones `Packed` or `Distributed` scheduling. |
| `fleet.nodeSelector` / `fleet.tolerations` / `fleet.affinity` | empty | Browser pod scheduling. |
| `fleet.health.initialDelaySeconds` | `90` | Agones health startup delay. |
| `fleet.health.periodSeconds` | `5` | Health reporting period. |
| `fleet.health.failureThreshold` | `6` | Health failure threshold. |
| `fleet.browserRuntimeCpuRequest` / `fleet.browserRuntimeCpuLimit` | `1000m` / `2000m` | Browser CPU resources. |
| `fleet.browserRuntimeMemoryRequest` / `fleet.browserRuntimeMemoryLimit` | `2Gi` / `4Gi` | Browser memory resources. |
| `fleet.browserRuntimeAttestorCpuRequest` / `fleet.browserRuntimeAttestorCpuLimit` | `100m` / `200m` | Attestor CPU resources. |
| `fleet.browserRuntimeAttestorMemoryRequest` / `fleet.browserRuntimeAttestorMemoryLimit` | `128Mi` / `256Mi` | Attestor memory resources. |
| `autoscaler.bufferSize` | `5` | Ready GameServers kept in reserve. |
| `autoscaler.minReplicas` | `10` | Autoscaler floor. |
| `autoscaler.maxReplicas` | `50` | Autoscaler ceiling. |
| `autoscaler.syncSeconds` | `30` | Autoscaler sync interval. |

### Optional attestor and image pre-puller

| Key | Default | Purpose |
| --- | --- | --- |
| `browserRuntimeAttestor.enabled` | `false` | Add the attestor sidecar. |
| `browserRuntimeAttestor.imagePullPolicy` | `IfNotPresent` | Attestor pull policy. |
| `browserRuntimeAttestorImage` | OSS attestor `:latest` | Attestor image. |
| `imagePrepuller.enabled` | `false` | Deploy a DaemonSet that warms browser and extension images. |
| `imagePrepuller.imagePullPolicy` | `IfNotPresent` | Pre-puller image policy. |
| `imagePrepuller.nodeSelector` / `imagePrepuller.tolerations` / `imagePrepuller.affinity` | empty | Pre-puller scheduling. |
| `imagePrepuller.resources.requests.cpu` / `imagePrepuller.resources.requests.memory` | `10m` / `32Mi` | Pre-puller requests. |
| `imagePrepuller.resources.limits.cpu` / `imagePrepuller.resources.limits.memory` | `50m` / `128Mi` | Pre-puller limits. |

### Session extensions

Each `sessionExtensions.<name>` supports:

| Key | Consumer | Purpose |
| --- | --- | --- |
| `enabled` | both charts | Enables the named extension; defaults to `true` when omitted. |
| `browser.ports` | browser-fleet | Agones GameServer port entries. Use `portPolicy: None`. |
| `browser.containers` | browser-fleet | Sidecar container specs. |
| `browser.prepullInitContainers` | browser-fleet | Optional pre-puller init containers. |
| `browser.prepullContainers` | browser-fleet | Optional long-running pre-puller containers. |
| `routing.portName` | platform | Name matching the GameServer port. |
| `routing.port` | platform | Fixed container port written to route state. |
| `routing.routeKey` | platform | Redis/gateway route identity. |
| `routing.sessionUrls` | platform | Map of response field to URL template. |
| `routing.gatewayRoutes` | platform | List of `pathPrefix`, `routeKey`, and optional `tokenScope`. |

If `routing` is present, `portName`, `port`, and `routeKey` are required. Keep
one extension in one values document and load that document into both charts.
Because the top level is a keyed map, enabling one extension cannot replace
another extension's lists.

## Values design notes

`sessionExtensions` is the only extension model. Its keyed structure lets
independent values documents enable multiple sidecars without replacing one
another's configuration.

VNC is mandatory core behavior rather than an extension. All browser ports use
`portPolicy: None`, so Popcorn does not need an Agones host-port range.

Further simplifications worth considering separately:

1. Move the attestor resource settings from `fleet.*` under
   `browserRuntimeAttestor.resources` so ownership is obvious.
2. Consolidate the global Secret aliases and per-component `secretName`
   overrides into one `secrets` object. This is a breaking values migration.
3. Replace the overloaded gateway exposure fields with a single explicit
   exposure mode (`private`, `loadBalancer`, or `gkeIngress`) and validate the
   fields required by each mode.
4. Keep simple Redis and HA Redis as explicit mutually exclusive profiles;
   schema validation should reject enabling both.

Those changes improve naming or validation but do not justify another sidecar
configuration path.
