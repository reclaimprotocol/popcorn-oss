# Secrets

Popcorn services read secrets from Kubernetes Secrets mounted as files or exposed as environment variables. For supported GCP deployments, use GCP Secret Manager with External Secrets Operator, or create the expected Kubernetes Secrets directly.

Use one of these patterns:

- Local development: `make local-secrets` creates development-only Kubernetes Secrets in a Kind cluster.
- Existing Kubernetes Secrets: create the expected Secret objects before installing the Helm charts.
- GCP Secret Manager: install External Secrets Operator and map Secret Manager entries into the same Secret names and keys.

Do not commit generated private keys, client credentials, registry credentials, cloud credentials, or production tokens.

## Required Secrets

Platform Secret names are centralized under `secrets.*` in the platform Helm
values. Browser TURN Secret naming is configured in the browser-fleet chart.
The defaults are:

| Helm value | Default Secret |
| --- | --- |
| `secrets.gatewayJwtName` | `gateway-jwt-keys` |
| `secrets.poolManagerServiceAuthName` | `pool-manager-service-auth` |
| `secrets.controlPlaneName` | `control-plane-secret` |
| `secrets.controlPlaneDatabaseName` | `analytics-db-secret` |
| `browser-fleet.secrets.browserTurnName` | `browser-turn-secret` |

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
  --from-file=public.pem=services/gateway/keys/public.pem
```

Use stable production keys across rollouts. Rotating these keys invalidates outstanding browser URLs.

### `pool-manager-service-auth`

Each regional pool manager should have its own service-auth Secret. The
control plane uses that region's token to call `/internal/sessions`,
`/internal/session/:id`, and `/internal/servers`.

| Key | Used by | Purpose |
| --- | --- | --- |
| `POOL_MANAGER_SERVICE_AUTH_TOKEN` | control plane, one pool manager | Per-region service token for internal allocation. |

For multi-region deployments, create one Secret per region and reference it
from `controlPlane.regions[].poolManagerAuth.secretName`.

### `control-plane-secret`

Required by the control plane. TTL callbacks use
`CONTROL_PLANE_SERVICE_AUTH_TOKEN`; regional pool-manager allocation should use the
per-region `pool-manager-service-auth` token instead.

| Key | Used by | Purpose |
| --- | --- | --- |
| `CONTROL_PLANE_SERVICE_AUTH_TOKEN` | control plane, TTL controller | Control-plane service token. |
| `ADMIN_USER` | control plane | Password-login username. |
| `ADMIN_PASS` | control plane | Password-login password. |
| `ADMIN_SESSION_SECRET` | control plane | Cookie signing secret for browser login. |
| `ADMIN_TOKEN` | control plane | Compatibility bearer token for operational API access. |
| `ADMIN_GOOGLE_CLIENT_ID` | control plane OAuth | Optional Google OAuth client ID. |
| `ADMIN_GOOGLE_CLIENT_SECRET` | control plane OAuth | Optional Google OAuth client secret. |

Control-plane admin auth supports password login, bcrypt htpasswd files, and
Google OAuth with allowed emails or domains. The Helm default is
`controlPlane.adminAuth.strategies=password,google`, so password login remains
available while OAuth becomes active when the Google client credentials,
redirect URI, and email/domain allowlist are configured.

### `analytics-db-secret`

Required when running the bundled control plane, bundled Postgres deployment,
or Metabase. Client `/v1/sessions` authentication depends on client records
stored in Postgres.

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

- control-plane admin username/password default to `admin`/`admin`;
- service tokens are fixed development placeholders;
- TURN credentials are empty unless `TURN_KEY_ID` and `TURN_API_TOKEN` are set in your shell.

## Existing Kubernetes Secrets

Create Secrets directly before running Helm:

```bash
kubectl create secret generic pool-manager-service-auth \
  --from-literal=POOL_MANAGER_SERVICE_AUTH_TOKEN="$POOL_MANAGER_SERVICE_AUTH_TOKEN"

kubectl create secret generic control-plane-secret \
  --from-literal=CONTROL_PLANE_SERVICE_AUTH_TOKEN="$CONTROL_PLANE_SERVICE_AUTH_TOKEN" \
  --from-literal=ADMIN_USER="$CONTROL_PLANE_ADMIN_USER" \
  --from-literal=ADMIN_PASS="$CONTROL_PLANE_ADMIN_PASS" \
  --from-literal=ADMIN_SESSION_SECRET="$CONTROL_PLANE_ADMIN_SESSION_SECRET" \
  --from-literal=ADMIN_TOKEN="$CONTROL_PLANE_ADMIN_TOKEN"

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
kubectl rollout restart deployment/control-plane deployment/ttl-controller
```

JWT key rotation invalidates active browser URLs. Token and password rotation may interrupt active clients. Prefer short browser session TTLs and scheduled maintenance windows for production rotations.

Browser pods read TURN settings only at startup. After rotating `browser-turn-secret`, recycle the browser GameServers so new pods fetch fresh Cloudflare ICE credentials:

```bash
kubectl delete gameserver --all
```
