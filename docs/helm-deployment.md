# Helm Deployment

Popcorn can run on any Kubernetes cluster that supports the required workloads. The Helm deployment is split into a platform chart and a browser fleet chart.

## Charts

- `charts/platform`: gateway, pool manager, Redis, optional analytics, optional TTL controller, and supporting RBAC.
- `charts/browser-fleet`: Agones browser fleet, optional attestor sidecar, optional image prepuller, and browser runtime settings.

OSS deployments should use public, self-hosted values and image references. The OSS examples use GitHub Container Registry image names; internal production values can continue to use GCP Artifact Registry.

## Prerequisites

- Kubernetes cluster.
- Helm 3.
- kubectl configured for the target cluster.
- Agones installed in the cluster.
- Popcorn images pushed to a registry your cluster can pull.
- RSA key pair for signing gateway path tokens.
- Analytics-backed client credentials for the client session API.
  Local smoke tests can use the admin session endpoint instead.

## Image Inputs

Popcorn runtime image assets are built from the separate [popcorn-images](../popcorn-images/README.md) repository. For OSS self-hosting, use GHCR images or your own public registry and digest-pin production deployments.

Example image references:

```yaml
registry: ghcr.io/reclaimprotocol/popcorn-oss
imageTag: v0.1.0
browserRuntimeImage: ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime@sha256:<digest>
browserRuntimeAttestorImage: ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime-attestor@sha256:<digest>
```

Do not use private project registries in public examples. Internal production chart defaults may keep GCP Artifact Registry references; the OSS export rewrites those defaults to public GHCR-style image references.

## Keys

The gateway validates JWT path tokens using the public key, while the pool manager signs tokens with the private key.

Development flow:

```bash
make local-keys
```

`make local-keys` creates development-only key material for the local Kind path.

Production deployments should create Kubernetes secrets through their normal secret-management process. Do not commit private keys or production secrets. See [Secrets](secrets.md) for the complete required Secret contract and provider-neutral examples.

## Client Session Authentication

The public `/session` API is analytics-backed in the current pool-manager
implementation. The pool manager validates `Authorization: Bearer
<client-id>:<client-secret>` by calling `POST /validate` on
`poolManager.analyticsServiceUrl`, authenticated with `ANALYTICS_AUTH_TOKEN`
from `analytics-service-secret`.

For local smoke tests, use `/admin/session` with the admin credentials. For a
client-facing deployment, either enable the bundled analytics service and
Postgres or point `poolManager.analyticsServiceUrl` at an existing analytics
service with client records. A local `SESSION_AUTH_CLIENTS` Secret value is not
used by the current code path.

## Admin Authentication

`/admin` and `/admin/*` use pool-manager admin auth. Basic auth remains
available for automation, and browser users can sign in through password login
or Google OAuth.

Minimal password-file values:

```yaml
poolManager:
  adminAuth:
    strategies: password
    passwordFileSecretName: pool-manager-admin-password-file
```

Google OAuth can be enabled with password auth:

```yaml
poolManager:
  adminAuth:
    strategies: password,google
    googleRedirectUri: https://gateway.example.com/admin/auth/google/callback
    googleAllowedEmails: admin@example.com
    googleAllowedDomains: example.com
```

Store `ADMIN_SESSION_SECRET`, `ADMIN_GOOGLE_CLIENT_ID`, and
`ADMIN_GOOGLE_CLIENT_SECRET` in `pool-manager-env-secrets` or another Secret
referenced by `poolManager.adminAuth`. `ADMIN_SESSION_SECRET` is required for
Google OAuth and password-file browser login; legacy `ADMIN_PASS` remains a
compatibility fallback for existing username/password deployments.

## Minimal Local Values Shape

The OSS Helm example values are included under `examples/helm/`. For Kind, they should look roughly like this:

```yaml
registry: popcorn
imageTag: local
clusterName: local
provider: kind

poolManager:
  enabled: true
  imagePullPolicy: IfNotPresent

gateway:
  enabled: true
  imagePullPolicy: IfNotPresent
  serviceType: NodePort
  nodePorts:
    http: 30080
  backendConfig:
    enabled: false

redis:
  enabled: true
```

Browser fleet local values:

```yaml
externalSecrets:
  enabled: false

ccDevicePlugin:
  enabled: false

browserRuntimeImage: popcorn/browser-node:local
browserRuntimeImagePullPolicy: IfNotPresent

browserRuntimeAttestor:
  enabled: false

fleet:
  replicas: 1
  browserRuntimeCpuRequest: 500m
  browserRuntimeCpuLimit: 2000m
  browserRuntimeMemoryRequest: 512Mi
  browserRuntimeMemoryLimit: 2Gi

autoscaler:
  bufferSize: 1
  minReplicas: 1
  maxReplicas: 3
```

## Install

Install Agones first if your cluster does not already have it:

```bash
kubectl create namespace agones-system --dry-run=client -o yaml | kubectl apply -f -
helm repo add agones https://agones.dev/chart/stable
helm repo update
helm upgrade --install agones agones/agones \
  --namespace agones-system \
  --set agones.controller.generateTLS=false
```

Install the platform:

```bash
kubectl create namespace popcorn --dry-run=client -o yaml | kubectl apply -f -
helm upgrade --install popcorn-platform charts/platform \
  --namespace popcorn \
  --values examples/helm/local-platform-values.yaml
```

Install the browser fleet:

```bash
helm upgrade --install browser-fleet charts/browser-fleet \
  --namespace popcorn \
  --values examples/helm/local-browser-fleet-values.yaml
```

`popcorn` is only an example workload namespace. The charts do not require that name, but the platform chart and browser-fleet chart should be installed into the same workload namespace unless you intentionally configure `poolManager.gameServerNamespace` and the matching RBAC/secrets for a split-namespace deployment.

The `examples/helm/*.yaml` files are public-safe examples for OSS chart rendering. The `examples/kubernetes/*.yaml` files show placeholder Secret manifests for direct Kubernetes Secrets and External Secrets Operator. Replace placeholder image registries, domains, service accounts, and secret names before installing into a shared or production cluster.

## Upgrade

For production, prefer immutable image digests:

```bash
helm upgrade --install browser-fleet charts/browser-fleet \
  --namespace popcorn \
  --set browserRuntimeImage=ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime@sha256:<digest>
```

Before upgrading, ensure:

- at least one new browser pod can become Ready;
- gateway and pool manager images are compatible with the browser runtime;
- path-token keys are stable across the rollout;
- session TTL behavior is acceptable for in-flight sessions.

## Uninstall

```bash
helm uninstall browser-fleet --namespace popcorn
helm uninstall popcorn-platform --namespace popcorn
```

Agones is shared infrastructure. Remove it only if no other workloads use it:

```bash
helm uninstall agones --namespace agones-system
```

## Production Notes

- Use GHCR or another public/self-hosted registry and digest-pinned images.
- Keep private keys in Kubernetes secrets or an external secret system.
- Terminate TLS at your ingress or load balancer.
- Keep the gateway public; keep Redis and pool manager internal unless you intentionally expose them.
- Use `fleet.extraPorts`, `fleet.extraContainers`, `extraBrowserRuntimeEnv`, `imagePrepuller.extraInitContainers`, and `imagePrepuller.extraContainers` for private deployment extensions.
- Enable attestation only on compatible confidential-computing nodes.
- Add resource requests and limits that match your concurrency target.
