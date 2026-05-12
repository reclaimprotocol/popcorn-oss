# Configuration

Popcorn is configured through Helm values and Kubernetes Secrets. The same charts support a local Kind demo and a production cluster, but production operators should replace all example registries, domains, credentials, and resource values.

## Deployment Profiles

### Local Kind

Use `make run-local-cluster` for the fastest self-hosted smoke test. It builds local images, creates development Secrets, installs the charts, and exposes the gateway on `http://localhost:8080`.

Local defaults are intentionally small:

- `gateway.serviceType=NodePort`
- analytics disabled unless explicitly enabled
- generated local JWT keys
- development admin credentials
- empty TURN credentials unless supplied
- one browser replica

The local profile is intended to use `/admin/session`. The client `/session`
API still validates credentials through the analytics service; enabling it for
clients requires an analytics endpoint, the shared analytics service token, and
client records in the analytics database.
The local Kind path can create browser sessions without TURN credentials, but browser streaming is only dependable from networks that can reach the browser pod's WebRTC candidates. For realistic browser access, especially from another device, a VPN, a corporate network, or a cloud-hosted cluster, configure Cloudflare TURN through `browser-turn-secret`.

For same-machine local development without TURN, `kind-config.yaml` publishes UDP ports `7000-7010` from the Kind node and the local Makefile constrains Agones GameServer allocations to that same range. The browser fleet also sets `webrtc.advertiseHost=127.0.0.1`, so Neko advertises a host candidate the local browser can actually reach. If you change the local Agones port range, update both `kind-config.yaml` and the Agones `gameservers.minPort` / `gameservers.maxPort` values together, then recreate the Kind cluster because Docker port mappings are fixed when the node container is created.

### Existing Kubernetes Cluster

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

The namespace can be any Kubernetes namespace you choose; `popcorn` is the documentation example. Keep the platform and browser-fleet releases in the same namespace for the normal deployment shape. In that shape, pool-manager allocates Agones GameServers in its own release namespace, the GKE node prescaler watches the same namespace, and in-cluster service URLs resolve to services in that namespace.

If you deliberately split platform and browser workloads across namespaces, set `poolManager.gameServerNamespace` and `gkeNodePrescaler.namespace` to the browser workload namespace, and make sure the pool-manager RBAC plus required Secrets are rendered for the namespaces they reference.

Before installing into a shared cluster, replace:

- `registry`
- `imageTag`
- public domains
- service type and ingress settings
- Secret names or external secret mappings
- CPU and memory requests
- autoscaler limits

## Important Values

### Platform Chart

| Value | Default intent | Notes |
| --- | --- | --- |
| `clusterName` | identifies the deployment | Used in service metadata and analytics. |
| `provider` | `generic` for OSS examples | Keep provider-specific automation disabled unless configured. |
| `registry` | image registry prefix | OSS examples use GHCR. Internal production values may use GCP Artifact Registry. |
| `imageTag` | runtime image tag | Prefer immutable tags or digests for production. |
| `poolManager.enabled` | API allocator | Required for session creation. |
| `poolManager.gameServerNamespace` | release namespace | Optional override for where pool-manager allocates and manages Agones GameServers. Leave empty for same-namespace deployments. |
| `poolManager.jwtSecretName` | `gateway-jwt-keys` | Secret must contain `private.pem`. |
| `gateway.enabled` | public gateway | Required for browser/CDP access. |
| `gateway.jwtSecretName` | `gateway-jwt-keys` | Secret must contain `public.pem`. |
| `redis.enabled` | local Redis | Enable bundled Redis for simple installs. |
| `postgres.enabled` | local Postgres | Optional analytics storage. |
| `analytics.enabled` | analytics API | Optional for the admin-only OSS local path. Required somewhere, bundled or external, for client `/session` auth. |
| `ttlController.enabled` | session cleanup | Recommended outside throwaway demos. |
| `otel.enabled` | observability | Optional; requires ClickHouse credentials when enabled. |
| `gkeNodePrescaler.enabled` | GKE-only scaling helper | Keep disabled for generic Kubernetes. |
| `gkeNodePrescaler.namespace` | release namespace | Optional override for the namespace watched by the prescaler. Leave empty for same-namespace deployments. |

### Browser Fleet Chart

| Value | Default intent | Notes |
| --- | --- | --- |
| `gatewayDomain` | gateway host | Browser runtime uses this to form callback URLs. |
| `externalSecrets.enabled` | optional secret sync | If enabled, requires External Secrets Operator and a configured secret store. |
| `ccDevicePlugin.enabled` | confidential-computing support | Keep disabled unless nodes support it. |
| `browserRuntimeImage` | browser runtime image | Use GHCR or another public/pinned image for OSS. |
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

Use `docs/secrets.md` as the source of truth for required Secret names and keys. The charts are intentionally backend-neutral: they consume Kubernetes Secrets regardless of how those Secrets are created.

Browser WebRTC access should have a TURN fallback. Popcorn supports Cloudflare TURN by reading `TURN_KEY_ID` and `TURN_API_TOKEN` from `browser-turn-secret`; the browser runtime then requests short-lived ICE server credentials on startup. Keep `NEKO_ICESERVERS` empty for this dynamic Cloudflare flow, or set it only when using a static custom ICE server list.

## Optional Components

Enable optional components one at a time:

- Analytics: required for client `/session` credential validation; requires analytics service and database Secrets when hosted in this deployment.
- TTL controller: requires the analytics service token when analytics callbacks are enabled.
- Attestation: requires compatible nodes and digest-pinned images.
- Observability: requires exporter endpoints and ClickHouse credentials.
- Cloud-specific scaling helpers: require provider credentials and should remain disabled in generic OSS examples.

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
kubectl get secret gateway-jwt-keys pool-manager-env-secrets browser-turn-secret
kubectl rollout status deployment/pool-manager
kubectl rollout status deployment/popcorn-gateway
```
