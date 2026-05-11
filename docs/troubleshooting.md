# Troubleshooting

Start with the current state:

```bash
kubectl get pods
kubectl get gameservers
kubectl get fleet,fleetautoscaler
kubectl get secret gateway-jwt-keys pool-manager-env-secrets browser-turn-secret
kubectl logs deployment/pool-manager
kubectl logs deployment/popcorn-gateway
```

## Local Gateway Is Not Reachable

Check the Kind cluster and port mapping:

```bash
kubectl config current-context
kubectl get svc popcorn-gateway
curl -i http://localhost:8080/health
```

For the local Makefile path, the gateway should be exposed on `http://localhost:8080`. If the service exists but curl fails, recreate the Kind cluster:

```bash
make clean
make run-local-cluster
```

## `401` Or `403` From Session APIs

Admin endpoints use Basic auth. Client endpoints use client credentials.

Check `pool-manager-env-secrets`:

```bash
kubectl get secret pool-manager-env-secrets -o jsonpath='{.data.POPCORN_ADMIN_USER}' | base64 -d
kubectl get secret pool-manager-env-secrets -o jsonpath='{.data.SESSION_AUTH_CLIENTS}' | base64 -d
```

Common causes:

- wrong admin username/password;
- missing `SESSION_AUTH_CLIENTS`;
- malformed client credential JSON;
- using `/session` when only the local admin path was configured.

## Browser URL Opens But CDP Fails

Check that the CDP URL has the right scheme and token:

- local HTTP gateway: `ws://.../cdp/...`
- TLS gateway: `wss://.../cdp/...`

The token in each URL is scoped. A browser URL token cannot be reused for CDP, and a CDP token cannot be reused for the runtime API.

## Browser Pods Do Not Become Ready

Inspect the GameServer and browser pod:

```bash
kubectl get gameservers -o wide
kubectl describe gameserver <name>
kubectl logs <browser-pod-name> -c browser
```

Common causes:

- image cannot be pulled;
- TURN credentials are missing or invalid for public access;
- insufficient CPU or memory;
- node does not support required sandbox or confidential-computing settings;
- `browserRuntimeImage` points at a private registry without image pull credentials.

## Helm Template Fails

Render locally first:

```bash
helm template popcorn-platform charts/platform --values examples/helm/platform-values.yaml
helm template browser-fleet charts/browser-fleet --values examples/helm/browser-fleet-values.yaml
```

If the error mentions External Secrets resources, either install External Secrets Operator or set:

```yaml
externalSecrets:
  enabled: false
```

## Missing Secret Errors

A pod stuck in `CreateContainerConfigError` often means a Secret or key is missing:

```bash
kubectl describe pod <pod-name>
```

Create the missing Secret with the names and keys in `docs/secrets.md`, then restart the workload:

```bash
kubectl rollout restart deployment/pool-manager deployment/popcorn-gateway
```

## Analytics Or TTL Controller Fails

Check the analytics token and database Secret:

```bash
kubectl get secret analytics-service-secret -o jsonpath='{.data.SERVICE_AUTH_TOKEN}' | base64 -d
kubectl get secret analytics-db-secret -o yaml
```

If analytics is not required for your deployment, keep `analytics.enabled=false` and verify services do not depend on analytics-only endpoints.

## Export Or Public CI Fails

Run the export checks locally:

```bash
scripts/oss/export.sh /tmp/popcorn-oss-export
scripts/oss/check-export.sh /tmp/popcorn-oss-export
scripts/oss/scan-export.sh /tmp/popcorn-oss-export
```

The export must not contain private deployment paths, internal-only components, private GitHub URLs, production domains, or secret material.

