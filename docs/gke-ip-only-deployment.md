# GKE IP-Only Deployment

This path is for a first self-hosted GKE smoke test when you do not have DNS
ready. It exposes the gateway on an HTTP GKE Ingress backed by a reserved
global static IP. The temporary test path also exposes the control plane on a
second HTTP-only static IP so client and session APIs can be tested without
`kubectl port-forward`.

The public control-plane mode is only for short-lived smoke tests. Keep auth
enabled, do not put secrets in logs, and delete the resources when validation
is complete. For a private operator-only control plane, leave
`controlPlane.staticIpName` empty and use port-forward, VPN, or an internal
ingress instead.

Use the domain-based path in [Deployment](deployment.md) when you need HTTPS
with GKE ManagedCertificate. GKE managed certificates require DNS names; they
are not used in this IP-only flow.

## What This Creates

- one temporary GKE Standard cluster;
- one namespace named `popcorn`;
- one global static IP for the gateway;
- one optional global static IP for the temporary public control plane;
- HTTP GKE Ingress resources with no host rules;
- one direct UDP firewall rule for the Agones GameServer port range;
- bundled Redis and Postgres for a starter install;
- one browser Fleet with direct UDP and STUN-only ICE servers.

The gateway public URL is `http://<gateway-ip>`. The temporary control-plane
public URL is `http://<control-plane-ip>`. Session responses should use
`http://<gateway-ip>` for browser/API URLs and `ws://<gateway-ip>` for CDP.

## Checklist

1. Set environment variables.
2. Reserve a global static IP for the gateway.
3. Reserve a global static IP for the temporary public control plane.
4. Create a GKE Standard cluster with HTTP load balancing enabled.
5. Open the Agones UDP range to the client CIDR that will test the browser.
6. Create Kubernetes Secrets.
7. Install Agones as cluster infrastructure.
8. Copy and edit the IP-only example values.
9. Install the platform chart.
10. Install the browser-fleet chart.
11. Wait for gateway/control-plane Ingresses and browser GameServers.
12. Create a client through the public control plane.
13. Create a session.
14. Validate gateway health, returned URL schemes, CDP, browser page load, and direct UDP logs.
15. Clean up cloud resources when the test is complete.

## Environment

```bash
export GCP_PROJECT_ID=rc-popcorn
export GCP_REGION=us-central1
export GCP_ZONE=us-central1-a
export CLUSTER_NAME=popcorn-oss-ip-test
export NAMESPACE=popcorn
export GATEWAY_IP_NAME=popcorn-oss-ip-test-gateway-ip
export CONTROL_PLANE_IP_NAME=popcorn-oss-ip-test-control-plane-ip
export NODE_TAG=popcorn-oss-ip-test-node
export UDP_FIREWALL_RULE=popcorn-oss-ip-test-webrtc-udp
export AGONES_MIN_PORT=59000
export AGONES_MAX_PORT=59100
```

Restrict direct UDP to the CIDR that will open the browser:

```bash
export CLIENT_CIDR="$(curl -fsS https://ifconfig.me)/32"
```

## Create Cloud Resources

Reserve the gateway IP:

```bash
gcloud compute addresses create "$GATEWAY_IP_NAME" \
  --global \
  --project "$GCP_PROJECT_ID"

export GATEWAY_IP="$(gcloud compute addresses describe "$GATEWAY_IP_NAME" \
  --global \
  --project "$GCP_PROJECT_ID" \
  --format='value(address)')"
```

Reserve the temporary public control-plane IP:

```bash
gcloud compute addresses create "$CONTROL_PLANE_IP_NAME" \
  --global \
  --project "$GCP_PROJECT_ID"

export CONTROL_PLANE_IP="$(gcloud compute addresses describe "$CONTROL_PLANE_IP_NAME" \
  --global \
  --project "$GCP_PROJECT_ID" \
  --format='value(address)')"
```

Create the cluster:

```bash
gcloud container clusters create "$CLUSTER_NAME" \
  --zone "$GCP_ZONE" \
  --project "$GCP_PROJECT_ID" \
  --machine-type n2d-standard-8 \
  --num-nodes 1 \
  --disk-size 100 \
  --disk-type pd-balanced \
  --enable-ip-alias \
  --enable-shielded-nodes \
  --workload-pool "$GCP_PROJECT_ID.svc.id.goog" \
  --tags "$NODE_TAG" \
  --addons HttpLoadBalancing,GcePersistentDiskCsiDriver

gcloud container clusters get-credentials "$CLUSTER_NAME" \
  --zone "$GCP_ZONE" \
  --project "$GCP_PROJECT_ID"
```

Open direct UDP for the browser stream:

```bash
gcloud compute firewall-rules create "$UDP_FIREWALL_RULE" \
  --project "$GCP_PROJECT_ID" \
  --network default \
  --direction INGRESS \
  --action ALLOW \
  --rules "udp:${AGONES_MIN_PORT}-${AGONES_MAX_PORT}" \
  --source-ranges "$CLIENT_CIDR" \
  --target-tags "$NODE_TAG"
```

## Create Secrets

Generate local files and random values:

```bash
openssl genrsa -out /tmp/popcorn-jwt-private.pem 2048
openssl rsa -in /tmp/popcorn-jwt-private.pem -pubout -out /tmp/popcorn-jwt-public.pem

export POOL_MANAGER_SERVICE_AUTH_TOKEN="$(openssl rand -hex 32)"
export CONTROL_PLANE_SERVICE_AUTH_TOKEN="$(openssl rand -hex 32)"
export CONTROL_PLANE_ADMIN_USER=admin
export CONTROL_PLANE_ADMIN_PASS="$(openssl rand -base64 32)"
export CONTROL_PLANE_ADMIN_SESSION_SECRET="$(openssl rand -hex 32)"
export CONTROL_PLANE_ADMIN_TOKEN="$(openssl rand -hex 32)"
export POSTGRES_DATABASE=analytics
export POSTGRES_USER=analytics_admin
export POSTGRES_PASSWORD="$(openssl rand -base64 32)"
```

Create the namespace and Secrets:

```bash
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NAMESPACE" create secret generic gateway-jwt-keys \
  --from-file=private.pem=/tmp/popcorn-jwt-private.pem \
  --from-file=public.pem=/tmp/popcorn-jwt-public.pem

kubectl -n "$NAMESPACE" create secret generic pool-manager-service-auth \
  --from-literal=POOL_MANAGER_SERVICE_AUTH_TOKEN="$POOL_MANAGER_SERVICE_AUTH_TOKEN"

kubectl -n "$NAMESPACE" create secret generic control-plane-secret \
  --from-literal=CONTROL_PLANE_SERVICE_AUTH_TOKEN="$CONTROL_PLANE_SERVICE_AUTH_TOKEN" \
  --from-literal=ADMIN_USER="$CONTROL_PLANE_ADMIN_USER" \
  --from-literal=ADMIN_PASS="$CONTROL_PLANE_ADMIN_PASS" \
  --from-literal=ADMIN_SESSION_SECRET="$CONTROL_PLANE_ADMIN_SESSION_SECRET" \
  --from-literal=ADMIN_TOKEN="$CONTROL_PLANE_ADMIN_TOKEN"

kubectl -n "$NAMESPACE" create secret generic analytics-db-secret \
  --from-literal=host=postgres \
  --from-literal=port=5432 \
  --from-literal=database="$POSTGRES_DATABASE" \
  --from-literal=username="$POSTGRES_USER" \
  --from-literal=password="$POSTGRES_PASSWORD"

kubectl -n "$NAMESPACE" create secret generic browser-turn-secret \
  --from-literal=TURN_KEY_ID="" \
  --from-literal=TURN_API_TOKEN="" \
  --from-literal='NEKO_ICESERVERS=[{"urls":["stun:stun.l.google.com:19302"]}]'
```

If GHCR packages are not public yet, create an image pull Secret and reference
it from both values files:

```bash
gh auth token | docker login ghcr.io -u "$(gh api user --jq .login)" --password-stdin

kubectl -n "$NAMESPACE" create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username="$(gh api user --jq .login)" \
  --docker-password="$(gh auth token)"
```

## Install Popcorn

Copy the examples and replace the gateway IP placeholder:

```bash
cp examples/helm/platform-ip-values.yaml /tmp/popcorn-platform-ip.yaml
cp examples/helm/browser-fleet-ip-values.yaml /tmp/popcorn-browser-fleet-ip.yaml

perl -0pi -e "s#http://REPLACE_WITH_GATEWAY_IP#http://${GATEWAY_IP}#g" \
  /tmp/popcorn-platform-ip.yaml
```

Set the runtime image to a published commit tag or digest. The live test used
the current commit tag because `browser-runtime:latest` was not published:

```bash
export BROWSER_RUNTIME_IMAGE=ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime:<commit-sha-or-digest>
perl -0pi -e "s#ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime:REPLACE_WITH_COMMIT_SHA#${BROWSER_RUNTIME_IMAGE}#g" \
  /tmp/popcorn-browser-fleet-ip.yaml
```

If you created `ghcr-pull`, add it at install time:

```bash
export IMAGE_PULL_SECRET_SET='--set imagePullSecrets[0].name=ghcr-pull'
```

Render before applying:

```bash
helm template popcorn-platform charts/platform \
  --namespace "$NAMESPACE" \
  --values /tmp/popcorn-platform-ip.yaml

helm template browser-fleet charts/browser-fleet \
  --namespace "$NAMESPACE" \
  --values /tmp/popcorn-browser-fleet-ip.yaml
```

Install Agones first. On a fresh cluster, installing Agones CRDs and Agones
Fleet resources in the same Helm release can race because the CRDs are not
established before the browser Fleet is rendered:

```bash
helm upgrade --install agones charts/browser-fleet/charts/agones-1.57.0.tgz \
  --namespace agones-system \
  --create-namespace \
  --set agones.controller.generateTLS=false \
  --set gameservers.minPort="$AGONES_MIN_PORT" \
  --set gameservers.maxPort="$AGONES_MAX_PORT" \
  --set-json "gameservers.namespaces=[\"$NAMESPACE\"]"

kubectl -n agones-system rollout status deployment/agones-controller
kubectl -n agones-system rollout status deployment/agones-extensions
```

Install Popcorn:

```bash
helm upgrade --install popcorn-platform charts/platform \
  --namespace "$NAMESPACE" \
  --values /tmp/popcorn-platform-ip.yaml \
  ${IMAGE_PULL_SECRET_SET:-}

helm upgrade --install browser-fleet charts/browser-fleet \
  --namespace "$NAMESPACE" \
  --values /tmp/popcorn-browser-fleet-ip.yaml \
  --set agones.install=false \
  ${IMAGE_PULL_SECRET_SET:-}
```

Wait for readiness:

```bash
kubectl -n "$NAMESPACE" rollout status deployment/pool-manager
kubectl -n "$NAMESPACE" rollout status deployment/popcorn-gateway
kubectl -n "$NAMESPACE" rollout status deployment/control-plane
kubectl -n "$NAMESPACE" get ingress popcorn-gateway control-plane
kubectl -n "$NAMESPACE" get fleet,fleetautoscaler,gameservers
```

## Verify

Check the gateway and public control plane:

```bash
curl -i "http://${GATEWAY_IP}/health"
curl -i "http://${CONTROL_PLANE_IP}/health"
```

Create a client and a session:

```bash
export CONTROL_PLANE_URL="http://${CONTROL_PLANE_IP}"

CLIENT_JSON="$(curl -sS -X POST "$CONTROL_PLANE_URL/admin/clients" \
  -H "Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"gke ip smoke"}')"

export POPCORN_CLIENT_ID="$(printf '%s' "$CLIENT_JSON" | jq -r .clientId)"
export POPCORN_CLIENT_SECRET="$(printf '%s' "$CLIENT_JSON" | jq -r .clientSecret)"

SESSION_JSON="$(curl -sS -X POST "$CONTROL_PLANE_URL/v1/sessions" \
  -H "Authorization: Bearer $POPCORN_CLIENT_ID:$POPCORN_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"gke-ip-smoke","regions":["us-central1"]}')"

printf '%s\n' "$SESSION_JSON" | jq
```

Expected URL schemes:

```bash
printf '%s\n' "$SESSION_JSON" | jq -r '.url,.cdpUrl,.apiUrl'
```

For an IP-only HTTP gateway, the browser URL should start with
`http://<gateway-ip>` and the CDP URL should start with `ws://<gateway-ip>`.

Check that the browser page itself is served:

```bash
export BROWSER_URL="$(printf '%s\n' "$SESSION_JSON" | jq -r .url)"
curl -sS -o /tmp/popcorn-browser.html -w '%{http_code}\n' "$BROWSER_URL"
```

Verify CDP with a WebSocket client:

```bash
export CDP_URL="$(printf '%s\n' "$SESSION_JSON" | jq -r .cdpUrl)"
node - <<'NODE'
const ws = new WebSocket(process.env.CDP_URL);
const timeout = setTimeout(() => {
  console.error('CDP timed out');
  process.exit(1);
}, 10000);
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
});
ws.addEventListener('message', (event) => {
  console.log(event.data);
  clearTimeout(timeout);
  ws.close();
});
ws.addEventListener('error', (event) => {
  console.error(event.message || event);
  process.exit(1);
});
NODE
```

Check direct UDP configuration in the browser runtime logs:

```bash
BROWSER_POD="$(printf '%s\n' "$SESSION_JSON" | jq -r '.browserId // .browserPodId // .browserPodName')"

kubectl -n "$NAMESPACE" logs "$BROWSER_POD" -c browser-runtime --tail=200 \
  | grep -E 'Direct WebRTC|webrtc starting|nat1to1|udpmux|Agones: READY|neko ready'
```

If the page loads but the stream does not connect, confirm the firewall rule,
client CIDR, Agones port range, and whether the client network blocks direct
UDP. For real users, prefer TURN as a fallback.

## Cleanup

```bash
helm -n "$NAMESPACE" uninstall browser-fleet || true
helm -n "$NAMESPACE" uninstall popcorn-platform || true
helm -n agones-system uninstall agones || true

gcloud container clusters delete "$CLUSTER_NAME" \
  --zone "$GCP_ZONE" \
  --project "$GCP_PROJECT_ID" \
  --quiet

gcloud compute firewall-rules delete "$UDP_FIREWALL_RULE" \
  --project "$GCP_PROJECT_ID" \
  --quiet

gcloud compute addresses delete "$GATEWAY_IP_NAME" \
  --global \
  --project "$GCP_PROJECT_ID" \
  --quiet

gcloud compute addresses delete "$CONTROL_PLANE_IP_NAME" \
  --global \
  --project "$GCP_PROJECT_ID" \
  --quiet
```

## Notes From The IP-Only Path

- `gateway.staticIpName` is enough to render a GKE Ingress.
- `gateway.domainName` is optional. Leave it empty for IP-only HTTP.
- ManagedCertificate and HTTPS redirect are rendered only when a domain is set.
- `controlPlane.staticIpName` can render the same kind of hostless HTTP
  Ingress for a temporary public test, but it has no TLS in IP-only mode.
- The platform values must set `controlPlane.regions[].publicGatewayUrl` to the
  exact public gateway URL, including `http://` for IP-only deployments.
- GKE HTTP load balancers can briefly return connection resets or default
  backend `404` responses while the forwarding rule finishes warming up.
- Direct UDP requires both an Agones port range and a matching GCP firewall
  rule. TURN is still the recommended production fallback.
