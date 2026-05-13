# Configuration

Popcorn is configured through Helm values and Kubernetes Secrets. The same charts support a local Kind demo and a GCP/GKE production deployment, but production operators should replace all example registries, domains, credentials, and resource values.

## Deployment Profiles

### Local Kind

Use `make run-local-cluster` for the fastest self-hosted smoke test. It builds local images, creates development Secrets, installs the charts, and exposes the gateway on `http://localhost:8080`.

Local defaults are intentionally small:

- `gateway.serviceType=NodePort`
- control plane disabled unless explicitly enabled
- generated local JWT keys
- development admin credentials
- empty TURN credentials unless supplied
- one browser replica

The local profile is intended to use `/admin/session`. The client `/session`
API still validates credentials through the control plane; enabling it for
clients requires a control-plane endpoint, the shared service token, and client
records in the control-plane database.
The local Kind path can create browser sessions without TURN credentials, but browser streaming is only dependable from networks that can reach the browser pod's WebRTC candidates. For realistic browser access, especially from another device, a VPN, a corporate network, or a cloud-hosted cluster, configure Cloudflare TURN through `browser-turn-secret`.

For same-machine local development without TURN, `kind-config.yaml` publishes UDP ports `7000-7010` from the Kind node and the local Makefile constrains Agones GameServer allocations to that same range. The browser fleet also sets `webrtc.advertiseHost=127.0.0.1`, so Neko advertises a host candidate the local browser can actually reach. If you change the local Agones port range, update both `kind-config.yaml` and the Agones `gameservers.minPort` / `gameservers.maxPort` values together, then recreate the Kind cluster because Docker port mappings are fixed when the node container is created.

### GCP/GKE

Use the example values as a starting point:

```bash
helm upgrade --install popcorn-platform charts/platform \
  --namespace popcorn \
  --create-namespace \
  --values examples/helm/platform-values.yaml

helm upgrade --install browser-fleet charts/browser-fleet \
  --namespace popcorn \
  --values examples/helm/browser-fleet-values.yaml
```

The namespace can be any GKE workload namespace you choose; `popcorn` is the documentation example. Keep the platform and browser-fleet releases in the same namespace for the normal deployment shape. In that shape, pool-manager allocates Agones GameServers in its own release namespace, the GKE node prescaler watches the same namespace, and in-cluster service URLs resolve to services in that namespace.

If you deliberately split platform and browser workloads across namespaces, set `poolManager.gameServerNamespace` and `gkeNodePrescaler.namespace` to the browser workload namespace, and make sure the pool-manager RBAC plus required Secrets are rendered for the namespaces they reference.

Before installing into a GKE cluster, replace:

- `registry`
- `imageTag`
- public domains
- GKE Ingress, static IP, and managed certificate settings
- Secret names or external secret mappings
- CPU and memory requests
- autoscaler limits

## Important Values

### Platform Chart

| Value | Default intent | Notes |
| --- | --- | --- |
| `clusterName` | identifies the deployment | Used in service metadata and analytics. |
| `provider` | `gcp` for OSS examples | Production support is GCP/GKE only for now. |
| `registry` | image registry prefix | OSS examples use GHCR. You may mirror images into your own GCP Artifact Registry. |
| `imageTag` | runtime image tag | Prefer immutable tags or digests for production. |
| `secrets.*` | central Secret names | One place to override Kubernetes Secret names for JWT keys, pool-manager admin env, pool-manager service auth, control-plane admin/service auth, database, and TURN. |
| `poolManager.enabled` | Regional allocator | Required for local pool-manager session creation. |
| `poolManager.gameServerNamespace` | release namespace | Optional override for where pool-manager allocates and manages Agones GameServers. Leave empty for same-namespace deployments. |
| `poolManager.controlPlaneUrl` | bundled control plane | Control-plane URL used for compatibility `/session` validation. `poolManager.analyticsServiceUrl` remains an alias. |
| `poolManager.serviceAuth.secretName` | `secrets.poolManagerServiceAuthName` | Per-region token Secret trusted by this pool-manager and mounted by the control plane region config. |
| `gateway.enabled` | public gateway | Required for browser/CDP access. |
| `redis.enabled` | local Redis | Enable bundled Redis for simple installs. |
| `postgres.enabled` | local Postgres | Optional analytics storage. |
| `controlPlane.enabled` | client control plane | Enables client credentials, `/v1/sessions`, multi-region routing, and analytics storage. |
| `controlPlane.adminAuth` | password login | Supports password, bcrypt htpasswd file, and Google OAuth with allowed emails/domains. |
| `controlPlane.regions` | `[]` | Ordered regional pool-manager config used by `/v1/sessions`; set `poolManagerAuth.secretName` per region. |
| `ttlController.enabled` | session cleanup | Recommended outside throwaway demos. |
| `otel.enabled` | observability | Optional; requires ClickHouse credentials when enabled. |
| `gkeNodePrescaler.enabled` | GKE-only scaling helper | Enable only after GCP project, cluster, location, node pool, and IAM are configured. |
| `gkeNodePrescaler.namespace` | release namespace | Optional override for the namespace watched by the prescaler. Leave empty for same-namespace deployments. |

### Browser Fleet Chart

| Value | Default intent | Notes |
| --- | --- | --- |
| `gatewayDomain` | gateway host | Browser runtime uses this to form callback URLs. |
| `externalSecrets.enabled` | optional GCP Secret Manager sync | If enabled, requires External Secrets Operator and `ClusterSecretStore/gcpsm`. |
| `ccDevicePlugin.enabled` | GCP confidential-computing support | Keep disabled unless GKE nodes support it. |
| `browserRuntimeImage` | browser runtime image | Use GHCR or a GCP Artifact Registry mirror, pinned by digest for production. |
| `browserRuntimeAttestor.enabled` | optional attestation sidecar | Keep disabled unless using attestation. |
| `imagePrepuller.enabled` | pre-pull runtime image | Useful for larger fleets. |
| `extraBrowserRuntimeEnv` | extra runtime env vars | Optional list appended to the browser runtime container env. |
| `fleet.extraPorts` | extra Agones Fleet ports | Optional list for additional public or internal runtime ports. |
| `fleet.extraContainers` | extra pod containers | Optional list appended to the Fleet pod containers. |
| `imagePrepuller.extraInitContainers` | extra prepuller init containers | Optional list prepended to the image prepuller DaemonSet as init containers. |
| `imagePrepuller.extraContainers` | extra prepuller containers | Optional list appended to the image prepuller DaemonSet containers. |
| `webrtc.advertiseHost` | optional host override | Use `127.0.0.1` only for local Kind with matching UDP port mappings. Leave empty in production so the runtime uses the node or GameServer address plus TURN fallback. |
| `fleet.replicas` | desired browser capacity | Start small; use autoscaler limits for burst control. |
| `autoscaler.minReplicas` | minimum fleet size | Keep low for development. |
| `autoscaler.maxReplicas` | maximum fleet size | Set a hard cost guardrail. |

## Secrets

Use `docs/secrets.md` as the source of truth for required Secret names and keys. On GCP, use GCP Secret Manager with External Secrets Operator and a `ClusterSecretStore` named `gcpsm`, or create the Kubernetes Secrets directly before installing the charts.

Browser WebRTC access should have a TURN fallback. Popcorn supports Cloudflare TURN by reading `TURN_KEY_ID` and `TURN_API_TOKEN` from `browser-turn-secret`; the browser runtime then requests short-lived ICE server credentials on startup. Keep `NEKO_ICESERVERS` empty for this dynamic Cloudflare flow, or set it only when using a static custom ICE server list.

## Optional Components

Enable optional components one at a time:

- Control plane: required for `/v1/sessions` and client `/session` credential validation; requires control-plane and database Secrets when hosted in this deployment.
- TTL controller: requires the control-plane service token when session callbacks are enabled.
- Attestation: requires compatible GCP confidential-computing nodes and digest-pinned images.
- Observability: requires exporter endpoints and ClickHouse credentials.
- GKE node prescaler: requires GCP IAM and should remain disabled until the target node pool settings are correct.

## Validation

Before applying to a cluster:

```bash
helm template popcorn-platform charts/platform \
  --values examples/helm/platform-values.yaml

helm template browser-fleet charts/browser-fleet \
  --values examples/helm/browser-fleet-values.yaml
```

After applying:

```bash
kubectl get pods
kubectl get secret gateway-jwt-keys pool-manager-env-secrets pool-manager-service-auth control-plane-secret browser-turn-secret
kubectl rollout status deployment/pool-manager
kubectl rollout status deployment/popcorn-gateway
```
