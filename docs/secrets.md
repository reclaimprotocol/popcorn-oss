# Secrets

Popcorn services read secrets from Kubernetes Secrets mounted as files or exposed as environment variables. For supported GCP deployments, use GCP Secret Manager with External Secrets Operator, or create the expected Kubernetes Secrets directly.

Use one of these patterns:

- Local development: `make local-secrets` creates development-only Kubernetes Secrets in a Kind cluster.
- Existing Kubernetes Secrets: create the expected Secret objects before installing the Helm charts.
- GCP Secret Manager: install External Secrets Operator and map Secret Manager entries into the same Secret names and keys.

Do not commit generated private keys, client credentials, registry credentials, cloud credentials, or production tokens.

## Required Secrets

### `gateway-jwt-keys`

Used by the pool manager and gateway for signed path tokens.

| Key | Used by | Purpose |
| --- | --- | --- |
| `private.pem` | pool manager | Signs browser, CDP, runtime API, and proof URLs. |
| `public.pem` | gateway | Verifies signed path tokens before proxying requests. |

Generate local keys:

```bash
./scripts/local/generate-jwt-keys.sh
kubectl create secret generic gateway-jwt-keys \
  --from-file=private.pem=services/pool-manager/keys/private.pem \
  --from-file=public.pem=services/pool-manager/keys/public.pem
```

Use stable production keys across rollouts. Rotating these keys invalidates outstanding browser URLs.

### `pool-manager-env-secrets`

Loaded into the pool manager with `envFrom`.

| Key | Required | Purpose |
| --- | --- | --- |
| `ADMIN_USER` | yes, unless using only an admin password file or Google OAuth | Username for admin Basic auth and password login fallback. |
| `ADMIN_PASS` | yes, unless using only an admin password file or Google OAuth | Password for admin Basic auth and password login fallback. Also used as a fallback cookie signing secret if `ADMIN_SESSION_SECRET` is absent. |
| `ADMIN_SESSION_SECRET` | required for Google OAuth or password-file browser login | Random secret used to sign admin browser login cookies. Legacy `ADMIN_PASS` is only a fallback for existing username/password deployments. |
| `ADMIN_GOOGLE_CLIENT_ID` | only for Google admin auth | Google OAuth client ID for `/admin/auth/google`. |
| `ADMIN_GOOGLE_CLIENT_SECRET` | only for Google admin auth | Google OAuth client secret for `/admin/auth/google`. |
| `SERVICE_AUTH_TOKEN` | yes | Service-to-service token used by internal platform calls. The current `/session` auth path does not read this key directly from `pool-manager-env-secrets`. |

For file-based admin password auth, mount a separate Secret containing an
htpasswd-style bcrypt file and set `poolManager.adminAuth.passwordFileSecretName`.
Each line should be `username:$2b$...`; blank lines and `#` comments are
ignored.

The current pool manager does not read `SESSION_AUTH_CLIENTS`. Client
credentials for `/session` are validated through the analytics service, not a
local JSON map in this Secret.

### `analytics-service-secret`

Required by the pool manager for client `/session` authentication, and by
analytics or TTL callbacks when those components are enabled.

| Key | Used by | Purpose |
| --- | --- | --- |
| `SERVICE_AUTH_TOKEN` | analytics, pool manager, TTL controller | Shared service token for analytics API calls. The platform chart exposes this to the pool manager as `ANALYTICS_AUTH_TOKEN`. |
| `ADMIN_TOKEN` | analytics | Admin token for analytics operational endpoints. |

### `analytics-db-secret`

Required when running the bundled analytics service, bundled Postgres
deployment, or Metabase. Client `/session` authentication depends on analytics
client records stored in Postgres, either in this deployment or in an external
analytics service you point `poolManager.analyticsServiceUrl` at.

| Key | Purpose |
| --- | --- |
| `host` | Postgres host. Use `postgres` for the bundled chart Postgres. |
| `port` | Postgres port, normally `5432`. |
| `database` | Analytics database name. |
| `username` | Analytics database user. |
| `password` | Analytics database password. |

### `browser-turn-secret`

Required by browser pods. Values can be empty for a local-only Kind demo, but production deployments should provide TURN credentials if browser sessions are reached across NAT or the public internet.

| Key | Required | Purpose |
| --- | --- | --- |
| `TURN_KEY_ID` | yes | TURN credential key ID. |
| `TURN_API_TOKEN` | yes | TURN API token or credential secret. |
| `NEKO_ICESERVERS` | no | JSON ICE server override consumed by the browser runtime. |

Popcorn browser sessions use WebRTC for the interactive browser stream. In Kubernetes, browser pods usually sit behind private pod networking, node NAT, firewalls, or cloud load balancers. Direct peer-to-peer UDP may work on a flat local network, but it is not reliable for users on the public internet, corporate networks, mobile networks, or local Kind clusters running behind a desktop VM. A TURN relay gives WebRTC a predictable fallback path when direct connectivity fails.

Local Kind can run without Cloudflare TURN only for same-machine testing. The local setup publishes Agones UDP ports `7000-7010` from the Kind node and advertises `127.0.0.1` to Neko. That path is not a substitute for TURN when the browser client is outside the developer machine or when a network blocks direct UDP.

Cloudflare TURN is the recommended hosted TURN option for production and realistic local testing. Set `TURN_KEY_ID` and `TURN_API_TOKEN` from a Cloudflare Calls TURN key. On browser pod startup, the runtime exchanges those values for short-lived ICE server credentials and exports them to Neko as `NEKO_ICESERVERS`. Leave `NEKO_ICESERVERS` empty unless you need to provide a static custom ICE server JSON override.

Do not store Cloudflare API tokens in Helm values or source control. Put them in `browser-turn-secret` directly or sync them from GCP Secret Manager.

## Local Development

For Kind:

```bash
make local-keys
make local-secrets
```

The generated values are intentionally local-only:

- admin username/password default to `admin`/`admin`;
- service tokens are fixed development placeholders;
- TURN credentials are empty unless `TURN_KEY_ID` and `TURN_API_TOKEN` are set in your shell.

## Existing Kubernetes Secrets

Create Secrets directly before running Helm:

```bash
kubectl create secret generic pool-manager-env-secrets \
  --from-literal=ADMIN_USER="$ADMIN_USER" \
  --from-literal=ADMIN_PASS="$ADMIN_PASS" \
  --from-literal=ADMIN_SESSION_SECRET="$ADMIN_SESSION_SECRET" \
  --from-literal=SERVICE_AUTH_TOKEN="$SERVICE_AUTH_TOKEN"

kubectl create secret generic pool-manager-admin-password-file \
  --from-file=admin.htpasswd=./admin.htpasswd

kubectl create secret generic analytics-service-secret \
  --from-literal=SERVICE_AUTH_TOKEN="$SERVICE_AUTH_TOKEN" \
  --from-literal=ADMIN_TOKEN="$ANALYTICS_ADMIN_TOKEN"

kubectl create secret generic browser-turn-secret \
  --from-literal=TURN_KEY_ID="$TURN_KEY_ID" \
  --from-literal=TURN_API_TOKEN="$TURN_API_TOKEN" \
  --from-literal=NEKO_ICESERVERS=""
```

See `examples/kubernetes/existing-secrets.example.yaml` for a complete placeholder manifest.

## GCP Secret Manager

External Secrets Operator can sync GCP Secret Manager values into the same Kubernetes Secret names. The bundled chart templates expect a `ClusterSecretStore` named `gcpsm`.

Recommended flow:

1. Install External Secrets Operator.
2. Configure `ClusterSecretStore/gcpsm` for GCP Secret Manager using Workload Identity.
3. Create `ExternalSecret` objects that produce the required Kubernetes Secrets listed above.
4. Install Popcorn with the same Secret names in Helm values.

See `examples/kubernetes/external-secrets.example.yaml` for GCP Secret Manager placeholder mappings.

The browser fleet chart already supports an optional `externalSecrets.enabled` path for `browser-turn-secret`. The platform chart can consume either directly-created Kubernetes Secrets or externally-synced Secrets with the same names.

## Rotation

Rotate secrets by updating the backing Kubernetes Secret, then restarting affected workloads:

```bash
kubectl rollout restart deployment/pool-manager deployment/popcorn-gateway
kubectl rollout restart deployment/analytics-service deployment/ttl-controller
```

JWT key rotation invalidates active browser URLs. Token and password rotation may interrupt active clients. Prefer short browser session TTLs and scheduled maintenance windows for production rotations.

Browser pods read TURN settings only at startup. After rotating `browser-turn-secret`, recycle the browser GameServers so new pods fetch fresh Cloudflare ICE credentials:

```bash
kubectl delete gameserver --all
```
