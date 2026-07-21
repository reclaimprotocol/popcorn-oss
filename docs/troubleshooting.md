# Troubleshooting

Use this page when a self-hosted Popcorn install does not create or serve
browser sessions. Start with Kubernetes state, then follow the symptom that
matches the failure.

## First Checks

```bash
kubectl -n popcorn get pods
kubectl -n popcorn get fleet,fleetautoscaler,gameservers
kubectl -n popcorn get secret gateway-jwt-keys pool-manager-service-auth control-plane-secret analytics-db-secret
kubectl -n popcorn logs deployment/control-plane --tail=100
kubectl -n popcorn logs deployment/pool-manager --tail=100
kubectl -n popcorn logs deployment/popcorn-gateway --tail=100
```

If pods are pending, check capacity first. If pods are in
`CreateContainerConfigError`, check missing Secrets first. If session creation
returns `401`, `403`, or `5xx`, check control-plane and pool-manager auth.

## Helm Install Or Upgrade Fails

Render locally with the same values file used for the release:

```bash
helm template popcorn-platform charts/platform --values <your-platform-values.yaml>
helm template browser-fleet charts/browser-fleet --values <your-browser-fleet-values.yaml>
```

Common causes:

- a values key has the wrong type;
- External Secrets templates are enabled but External Secrets Operator is not installed;
- a Secret name in values does not match the Secret created in the cluster;
- GKE-only options are enabled on a non-GKE cluster;
- IP-only values still contain `http://REPLACE_WITH_GATEWAY_IP` instead of the
  reserved gateway IP.
- a fresh cluster is trying to install Agones CRDs and browser Fleet resources
  in the same release. Install Agones first, wait for the controller, then
  install browser-fleet with `agones.install=false`.

If a platform upgrade fails because `control-plane-migrate` already exists and
its pod template is immutable, delete only that completed Job and retry:

```bash
kubectl -n popcorn delete job control-plane-migrate --ignore-not-found
```

If you are not using External Secrets Operator, disable the relevant
`externalSecrets.enabled` value and create Kubernetes Secrets directly.

## Pods Are Stuck In ImagePullBackOff

Describe the pod and check the registry error:

```bash
kubectl -n popcorn describe pod <pod-name>
```

Common causes:

- GHCR packages are private and the namespace is missing an `imagePullSecrets`
  entry;
- the GitHub token used for the pull Secret does not have `read:packages`;
- `browser-runtime:latest` does not exist. Use a published commit tag or digest;
- the cluster is pulling from Artifact Registry without node/service account
  permissions.

If you need a private GHCR pull while packages are not public, create a
`docker-registry` Secret and reference it from platform and browser-fleet
values:

```bash
kubectl -n popcorn create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username=<github-user> \
  --docker-password=<token-with-read-packages>
```

## Pods Are Stuck In CreateContainerConfigError

Describe the pod and look for the missing Secret or key:

```bash
kubectl -n popcorn describe pod <pod-name>
```

Check the required defaults:

```bash
kubectl -n popcorn get secret gateway-jwt-keys
kubectl -n popcorn get secret pool-manager-service-auth
kubectl -n popcorn get secret control-plane-secret
kubectl -n popcorn get secret analytics-db-secret
```

Create the missing Secret with the keys listed in `docs/secrets.md`, then
restart the affected deployment:

```bash
kubectl -n popcorn rollout restart deployment/pool-manager deployment/popcorn-gateway deployment/control-plane
```

## Pool Manager Does Not Become Ready

The pool manager requires `POOL_MANAGER_SERVICE_AUTH_TOKEN` from
`pool-manager-service-auth`.

```bash
kubectl -n popcorn describe pod -l app=pool-manager
kubectl -n popcorn get secret pool-manager-service-auth -o jsonpath='{.data.POOL_MANAGER_SERVICE_AUTH_TOKEN}' | base64 -d
kubectl -n popcorn logs deployment/pool-manager --tail=100
```

Common causes:

- the Secret is missing;
- the key name is wrong;
- the token differs from the token configured for the region in the control plane;
- Redis is unavailable;
- the pod cannot reach the Kubernetes API or Agones resources.

## Session API Returns 401 Or 403

Use the control-plane `/v1/sessions` API for client-created sessions. The pool
manager internal session endpoints are bearer-protected and are not public
client APIs.

Check the region wiring and service token:

```bash
kubectl -n popcorn get deploy control-plane -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="CONTROL_PLANE_REGIONS")].value}'
kubectl -n popcorn get secret pool-manager-service-auth -o jsonpath='{.data.POOL_MANAGER_SERVICE_AUTH_TOKEN}' | base64 -d
```

Common causes:

- client ID or client secret was not created in the control plane;
- the client was revoked;
- admin username or password is wrong;
- `ADMIN_SESSION_SECRET` differs across control-plane replicas;
- Google OAuth user email is unverified or outside the allowlist;
- control-plane region token does not match the regional pool-manager token.

## Session API Returns 5xx

Check the control plane, database, pool manager, and Agones state:

```bash
kubectl -n popcorn logs deployment/control-plane --tail=200
kubectl -n popcorn logs deployment/pool-manager --tail=200
kubectl -n popcorn get fleet,fleetautoscaler,gameservers
kubectl -n popcorn get endpoints
```

Common causes:

- Postgres is unavailable or credentials are wrong;
- no Ready GameServers are available;
- the pool-manager service URL in `controlPlane.regions` is wrong;
- gateway JWT keys are missing or invalid;
- browser pods are failing image pull or readiness checks.

## Browser URL Opens But CDP Or Runtime API Fails

Use the URL returned for that access path. Browser, CDP, and runtime API URLs
each have scoped tokens. The optional proof route is separate and uses
`/proof/<sessionId>?nonce=<hex>`.

Check the CDP scheme:

- local HTTP gateway: `ws://.../cdp/...`
- TLS gateway: `wss://.../cdp/...`

Do not reuse a browser URL token for CDP or a CDP token for the runtime API.
If all scoped URLs fail, check gateway logs and JWT key consistency between
pool manager and gateway.

For IP-only GKE deployments, the returned browser URL should start with
`http://<gateway-ip>` and the returned CDP URL should start with
`ws://<gateway-ip>`. If they still use the placeholder or a DNS name, fix
`controlPlane.regions[].publicGatewayUrl` and restart the control plane.

If a newly created public IP-only control-plane Ingress briefly returns
connection resets or default backend `404`, wait for the GKE forwarding rule and
URL map to finish warming up. `kubectl describe ingress control-plane` should
show the control-plane backend as `HEALTHY`.

## Browser Pods Do Not Become Ready

Inspect the GameServer and browser pod:

```bash
kubectl -n popcorn get gameservers -o wide
kubectl -n popcorn describe gameserver <name>
kubectl -n popcorn logs <browser-pod-name> -c browser-runtime --tail=200
```

Common causes:

- browser runtime image cannot be pulled;
- private registry credentials are missing;
- CPU or memory requests cannot fit on browser nodes;
- confidential-computing or sandbox settings do not match the node pool.

## Live View (VNC) Does Not Connect

The browser streams over the noVNC HTTP/WebSocket port (`6080`) on the pod,
routed through the gateway as the `liveview` route. This path is TCP only.

Typical symptoms:

- the live-view page loads but the canvas stays blank or reconnects in a loop;
- the WebSocket connection to `/liveview-ws/<sessionId>/<token>` fails to
  upgrade;
- the browser runtime returns `503` on the noVNC HTTP and WebSocket routes.

Check the live-view route and the pod's noVNC port:

```bash
kubectl -n popcorn get gameservers -o wide
kubectl -n popcorn logs <browser-pod-name> -c browser-runtime --tail=200
kubectl -n popcorn logs deployment/popcorn-gateway --tail=200
```

Common causes:

- the gateway route or `proxy_pass` does not reach the pod's `6080` (noVNC) port;
- the `/liveview-ws/<sessionId>/<token>` WebSocket upgrade is blocked by a proxy
  or load balancer that does not forward `Upgrade`/`Connection` headers;
- the returned `vncUrl`/`vncWsUrl` point at the wrong base or a stale token;
- Chromium is not ready yet. noVNC and CDP listeners bind early, but their HTTP
  and WebSocket routes return `503` until Chromium's X window matches the
  readiness pattern (`READY_WINDOW_PATTERN`, default Chromium/Chrome). See
  `images/minimal-vnc-desktop/README.md` for the readiness behavior. A `503`
  that clears on its own once the window opens is expected; a persistent `503`
  means the app window never matched the pattern or the app failed to start.

If the `503` persists, check the browser-runtime startup logs for the app window
and readiness state:

```bash
kubectl -n popcorn logs <browser-pod-name> -c browser-runtime --tail=200
```

## Optional Component Fails

For TTL controller, verify the control-plane service token and logs:

```bash
kubectl -n popcorn get secret control-plane-secret -o jsonpath='{.data.CONTROL_PLANE_SERVICE_AUTH_TOKEN}' | base64 -d
kubectl -n popcorn logs deployment/ttl-controller --tail=100
```

For control-plane database failures, verify the database Secret and network path:

```bash
kubectl -n popcorn get secret analytics-db-secret -o yaml
kubectl -n popcorn get pods -l app=postgres
```

For OpenTelemetry issues, check the collector and configured exporter path:

```bash
kubectl -n popcorn get daemonset otel-agent
kubectl -n popcorn logs daemonset/otel-agent --tail=100
kubectl -n popcorn logs deployment/pool-manager --tail=100 | grep -i otel
```

For attestation or GKE node prescaler issues, disable the optional component and
confirm the base session lifecycle still works before debugging the add-on.

## Advanced: Local Kind

For the local Makefile path, the gateway should be reachable at
`http://localhost:8080`:

```bash
kubectl config current-context
kubectl get svc popcorn-gateway
curl -i http://localhost:8080/health
```

If the service exists but curl fails, recreate the Kind cluster:

```bash
make clean
make run-local-cluster
```

For same-machine Kind, live view (VNC) is served over TCP through the gateway.
Verify the GameServer is Ready and the browser runtime's noVNC port is serving:

```bash
kubectl -n popcorn get gameservers -o wide
kubectl -n popcorn logs <browser-pod-name> -c browser-runtime --tail=200
```

Once Chromium is ready, the noVNC HTTP and WebSocket routes on port `6080` stop
returning `503` (see "Live View (VNC) Does Not Connect" above). If the live-view
page will not load, confirm the gateway is reachable at
`http://localhost:8080` and re-check the `liveview` route.

## Advanced: Public Repo Checks

Public OSS changes should not include private deployment paths, private GitHub
URLs, production domains, or secret material. Run local checks where possible
before opening a release PR.
