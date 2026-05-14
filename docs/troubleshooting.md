# Troubleshooting

Start with the current state:

```bash
kubectl get pods
kubectl get gameservers
kubectl get fleet,fleetautoscaler
kubectl get secret gateway-jwt-keys pool-manager-service-auth control-plane-secret browser-turn-secret
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

## Pool Manager Does Not Start

The platform chart injects the pool-manager service-auth Secret into the pool
manager as `POOL_MANAGER_SERVICE_AUTH_TOKEN`. The pool manager requires that
token at startup. If the Secret or key is missing, the pod fails to start or
remains unready.

Check the pod events and required Secret:

```bash
kubectl describe pod -l app=pool-manager
kubectl get secret pool-manager-service-auth -o jsonpath='{.data.POOL_MANAGER_SERVICE_AUTH_TOKEN}' | base64 -d
kubectl logs deployment/pool-manager
```

Common signs:

- `CreateContainerConfigError` mentioning `pool-manager-service-auth` or `POOL_MANAGER_SERVICE_AUTH_TOKEN`;
- pool-manager logs mention missing `POOL_MANAGER_SERVICE_AUTH_TOKEN`;
- deployment rollout never becomes ready.

## `401` Or `403` From Session APIs

Pool-manager only accepts internal control-plane bearer calls. Control-plane
admin endpoints support password auth and optional Google OAuth. Client
endpoints use control-plane-backed client credentials.

For client `/v1/sessions`, check the control-plane region wiring:

```bash
kubectl get deploy control-plane -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="CONTROL_PLANE_REGIONS")].value}'
kubectl get secret pool-manager-service-auth -o jsonpath='{.data.POOL_MANAGER_SERVICE_AUTH_TOKEN}' | base64 -d
```

Common causes:

- wrong admin username/password;
- missing or mismatched `ADMIN_SESSION_SECRET` across control-plane replicas;
- control-plane Google OAuth user email is unverified or not in the configured allowed emails/domains;
- pool manager rejects the configured regional service token;
- the client ID/secret was not created in the control plane, or the client was revoked;
- using the removed pool-manager `/session` compatibility path instead of control-plane `/v1/sessions`.

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
kubectl logs <browser-pod-name> -c browser-runtime
```

Common causes:

- image cannot be pulled;
- TURN credentials are missing or invalid for public access;
- insufficient CPU or memory;
- node does not support required sandbox or confidential-computing settings;
- `browserRuntimeImage` points at a private registry without image pull credentials.

## Browser Opens But WebRTC Does Not Connect

If the browser session URL loads but the video stream stays disconnected, check the TURN configuration first. The browser runtime should log that Cloudflare ICE servers were generated:

```bash
kubectl logs <browser-pod-name> -c browser-runtime | grep -i cloudflare
kubectl get secret browser-turn-secret -o jsonpath='{.data.TURN_KEY_ID}' | grep -q . && echo TURN_KEY_ID=set
kubectl get secret browser-turn-secret -o jsonpath='{.data.TURN_API_TOKEN}' | grep -q . && echo TURN_API_TOKEN=set
```

Common causes:

- `TURN_KEY_ID` or `TURN_API_TOKEN` is empty;
- the Cloudflare TURN key was deleted, expired, or copied incorrectly;
- the browser pod was not restarted after updating `browser-turn-secret`;
- a firewall blocks direct UDP and no TURN relay is configured;
- a custom `NEKO_ICESERVERS` override is malformed.

For same-machine Kind without TURN, also verify that the Agones UDP port is published through Docker and that the browser runtime advertises localhost:

```bash
docker port popcorn-control-plane | grep udp
kubectl get gameservers -o wide
kubectl logs <browser-pod-name> -c browser-runtime | grep -E 'advertise host|Direct WebRTC'
```

You should see UDP `7000-7010` mapped on the Kind node, a GameServer port in that range, and `external=127.0.0.1` in the browser runtime logs. If `docker port` shows only `8080/tcp`, recreate the Kind cluster so the UDP mappings from `kind-config.yaml` are applied:

```bash
make clean
make run-local-cluster
```

After updating TURN credentials, recycle browser GameServers so new pods fetch fresh Cloudflare ICE server credentials:

```bash
kubectl delete gameserver --all
```

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

## Control Plane Or TTL Controller Fails

Check the control-plane token and database Secret:

```bash
kubectl get secret control-plane-secret -o jsonpath='{.data.CONTROL_PLANE_SERVICE_AUTH_TOKEN}' | base64 -d
kubectl get secret analytics-db-secret -o yaml
```

For client `/v1/sessions`, the control plane is the authentication path and
must be reachable with valid client records.

## Public CI Fails

Run the OSS checks locally where possible. The public tree must not contain private deployment paths, private GitHub URLs, production domains, or secret material.
