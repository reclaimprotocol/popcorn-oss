# Secrets

Popcorn services read secrets from Kubernetes Secrets mounted as files or exposed as environment variables. The application code does not need to know whether those Kubernetes Secrets were created by `kubectl`, External Secrets Operator, Sealed Secrets, SOPS, Vault, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, 1Password, or another operator.

Use one of these patterns:

- Local development: `make local-secrets` creates development-only Kubernetes Secrets in a Kind cluster.
- Existing Kubernetes Secrets: create the expected Secret objects before installing the Helm charts.
- External secret manager: install External Secrets Operator and map provider keys into the same Secret names and keys.

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
| `POPCORN_ADMIN_USER` | yes | Basic auth username for admin session endpoints. |
| `POPCORN_ADMIN_PASS` | yes | Basic auth password for admin session endpoints. |
| `SERVICE_AUTH_TOKEN` | yes | Service-to-service token used by internal platform calls. |
| `SESSION_AUTH_CLIENTS` | no | JSON map of client credentials for `/session` API access. |

Example `SESSION_AUTH_CLIENTS`:

```json
{"demo-client":{"secret":"replace-me","scopes":["session:create","session:read","session:delete"]}}
```

### `analytics-service-secret`

Required when analytics, pool-manager analytics calls, or TTL analytics callbacks are enabled.

| Key | Used by | Purpose |
| --- | --- | --- |
| `SERVICE_AUTH_TOKEN` | analytics, pool manager, TTL controller | Shared service token for analytics API calls. |
| `ADMIN_TOKEN` | analytics | Admin token for analytics operational endpoints. |

### `analytics-db-secret`

Required when analytics, the bundled Postgres deployment, or Metabase is enabled.

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
  --from-literal=POPCORN_ADMIN_USER="$POPCORN_ADMIN_USER" \
  --from-literal=POPCORN_ADMIN_PASS="$POPCORN_ADMIN_PASS" \
  --from-literal=SERVICE_AUTH_TOKEN="$SERVICE_AUTH_TOKEN" \
  --from-literal=SESSION_AUTH_CLIENTS="$SESSION_AUTH_CLIENTS"

kubectl create secret generic analytics-service-secret \
  --from-literal=SERVICE_AUTH_TOKEN="$SERVICE_AUTH_TOKEN" \
  --from-literal=ADMIN_TOKEN="$ANALYTICS_ADMIN_TOKEN"

kubectl create secret generic browser-turn-secret \
  --from-literal=TURN_KEY_ID="$TURN_KEY_ID" \
  --from-literal=TURN_API_TOKEN="$TURN_API_TOKEN"
```

See `examples/kubernetes/existing-secrets.example.yaml` for a complete placeholder manifest.

## External Secret Managers

External Secrets Operator can sync provider-backed values into the same Kubernetes Secret names. Popcorn does not require a specific provider.

Recommended flow:

1. Install External Secrets Operator.
2. Configure a `SecretStore` or `ClusterSecretStore` for your provider.
3. Create `ExternalSecret` objects that produce the required Kubernetes Secrets listed above.
4. Install Popcorn with the same Secret names in Helm values.

See `examples/kubernetes/external-secrets.example.yaml` for provider-neutral placeholder mappings.

The browser fleet chart already supports an optional `externalSecrets.enabled` path for `browser-turn-secret`. The platform chart can consume either directly-created Kubernetes Secrets or externally-synced Secrets with the same names.

## Rotation

Rotate secrets by updating the backing Kubernetes Secret, then restarting affected workloads:

```bash
kubectl rollout restart deployment/pool-manager deployment/popcorn-gateway
kubectl rollout restart deployment/analytics-service deployment/ttl-controller
```

JWT key rotation invalidates active browser URLs. Token and password rotation may interrupt active clients. Prefer short browser session TTLs and scheduled maintenance windows for production rotations.

