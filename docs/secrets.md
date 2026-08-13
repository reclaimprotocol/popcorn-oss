# Secrets

Popcorn consumes Kubernetes Secrets; it does not provide a general secret
manager. Production deployments should synchronize them from an external
system or create them through a protected deployment pipeline.

## Required Secret map

| Secret | Required keys | Consumers | Rotation effect |
| --- | --- | --- | --- |
| `gateway-jwt-keys` | `private.pem`, `public.pem` | pool manager, gateway | Invalidates active signed URLs if replaced without overlap |
| `pool-manager-service-auth` | `POOL_MANAGER_SERVICE_AUTH_TOKEN` | pool manager, control plane region | Breaks regional allocation until both sides agree |
| `control-plane-secret` | `CONTROL_PLANE_SERVICE_AUTH_TOKEN`; admin keys depend on strategy | control plane, TTL controller | Depends on key; session/admin token rotation can log out operators |
| `analytics-db-secret` | `host`, `port`, `database`, `username`, `password` | migration Job, control plane | Restarts/migrations fail if credentials disagree |

Names may be overridden in Helm values. A multi-region control plane should use
one pool-manager service-token Secret per region.

## Generate gateway JWT keys

Generate an RSA keypair in a secure environment:

```bash
umask 077
openssl genpkey -algorithm RSA \
  -pkeyopt rsa_keygen_bits:3072 \
  -out gateway-private.pem
openssl rsa -in gateway-private.pem -pubout -out gateway-public.pem
```

Create the Secret without checking key material into Git:

```bash
kubectl -n popcorn create secret generic gateway-jwt-keys \
  --from-file=private.pem=gateway-private.pem \
  --from-file=public.pem=gateway-public.pem \
  --dry-run=client -o yaml | kubectl apply -f -
```

The pool manager signs path tokens with the private key. The gateway verifies
them with the public key.

## Service tokens

Generate independent random tokens:

```bash
openssl rand -base64 48
```

Create a regional pool-manager token:

```bash
kubectl -n popcorn create secret generic pool-manager-us-service-auth \
  --from-literal=POOL_MANAGER_SERVICE_AUTH_TOKEN='<random token>' \
  --dry-run=client -o yaml | kubectl apply -f -
```

Reference that same Secret in `poolManager.serviceAuth` and the matching
`controlPlane.regions[].poolManagerAuth` entry.

`CONTROL_PLANE_SERVICE_AUTH_TOKEN` protects internal lifecycle callbacks such
as session completion. Store it in `control-plane-secret`; the TTL controller
reads the same key.

## Admin authentication keys

The default control-plane Secret may contain:

| Key | Needed when |
| --- | --- |
| `ADMIN_SESSION_SECRET` | browser login sessions or Google OAuth are used |
| `ADMIN_USER`, `ADMIN_PASS` | static password strategy is enabled |
| `ADMIN_TOKEN` | bearer-token administration is enabled |
| `ADMIN_GOOGLE_CLIENT_ID`, `ADMIN_GOOGLE_CLIENT_SECRET` | Google OAuth is enabled |

For password-file authentication, create a separate Secret and configure
`controlPlane.adminAuth.passwordFileSecretName` and
`passwordFileSecretKey`. Prefer bcrypt password hashes.

Do not expose `/admin` solely because a login mechanism exists. Network access
control remains part of the security boundary.

## Postgres Secret

```bash
kubectl -n popcorn create secret generic analytics-db-secret \
  --from-literal=host='<postgres host>' \
  --from-literal=port='5432' \
  --from-literal=database='popcorn' \
  --from-literal=username='<database user>' \
  --from-literal=password='<database password>' \
  --dry-run=client -o yaml | kubectl apply -f -
```

Use a database account scoped to the Popcorn database. The migration Job needs
schema-change permissions.

## Optional Secrets

| Secret | Keys | Feature |
| --- | --- | --- |
| `browser-runtime-proxy-secret` | `HTTPS_PROXY_URL` | deployment-owned proxy preset for country-routed browser sessions |
| `otel-exporter-headers` | operator-defined | OTLP authentication headers |
| `otel-clickhouse-secret` | `CLICKHOUSE_ENDPOINT`, `CLICKHOUSE_HTTP_ENDPOINT`, `CLICKHOUSE_USERNAME`, `CLICKHOUSE_PASSWORD` | legacy ClickHouse export |
| `control-plane-x402-secret` | x402 server/RPC keys; optional CDP and facilitator keys | x402 API |
| attestation signing Secret | deployment-specific keys described in the attestation guide | attestation |

An extension may consume its own Secrets from
`sessionExtensions.<name>.browser.containers`.

## Country-routed browser proxy

To use the optional proxy preset on `POST /v1/sessions`, set
`HTTPS_PROXY_URL` in `browser-runtime-proxy-secret`. The URL must include
`{{country}}` or the existing `{{geoLocation}}` placeholder. The pool manager
reads this secret and only derives a configuration for the allocated browser;
callers never provide an upstream URL or credentials.


Make `HTTPS_PROXY_URL` available to the pool-manager process in deployments
that use country-routed sessions.

## External Secrets Operator

The repository includes an example in
`examples/kubernetes/external-secrets.example.yaml`. The bundled templates use:

```yaml
secretStoreRef:
  kind: ClusterSecretStore
  name: gcpsm
```

Create and authorize that store before enabling the templates. The browser
proxy ExternalSecret expects the remote key
`browser-runtime-https-proxy-url`. Gateway JWT ExternalSecret remote IDs come
from `gateway.jwtPrivateKeySecretId` and `gateway.jwtPublicKeySecretId`.

If your store has a different name or key model, manage ExternalSecret objects
outside the Popcorn chart.

## Rotation runbooks

### Service token

1. Choose a maintenance window.
2. Update the Secret used by both caller and receiver.
3. Restart the relevant workloads if the secret is exposed as an environment
   variable.
4. Create and delete a test session.
5. Revoke the old value in the external secret manager.

### Gateway JWT key

The current gateway accepts one public key. Replacing the keypair immediately
invalidates active URLs. Either wait for all sessions to expire, deliberately
terminate them, or implement an overlap-capable verifier before attempting
zero-downtime rotation.

### Database password

Use the database provider's dual-password or staged rotation mechanism when
available. Update the Secret, restart the control plane, and prove both the
migration Job and API can connect before revoking the old credential.

## Secret checks

Check names and keys without printing values:

```bash
kubectl -n popcorn get secret \
  gateway-jwt-keys pool-manager-service-auth \
  control-plane-secret analytics-db-secret

kubectl -n popcorn get secret gateway-jwt-keys \
  -o go-template='{{range $k,$v := .data}}{{printf "%s\n" $k}}{{end}}'
```

Never include decoded Secret output or full signed session URLs in diagnostic
bundles.
