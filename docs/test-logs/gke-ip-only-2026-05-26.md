# GKE IP-Only Deployment Test Log - 2026-05-26

This log records the first IP-only GKE self-hosting pass. It intentionally
omits secret values.

## Run Metadata

| Field | Value |
| --- | --- |
| Repo commit | `7002a69ec0e2c51e3f5c3a1f1010888caa5140ce` |
| Date started | `2026-05-26 03:45:56 IST` |
| GCloud account | `abdulrreshamwala@reclaimprotocol.org` |
| GCP project | `rc-popcorn` |
| Region | `us-central1` |
| Zone | `us-central1-a` |
| Cluster | `popcorn-oss-ip-test` |
| Namespace | `popcorn` |
| Endpoint mode | IP-only HTTP gateway plus temporary public HTTP control plane |
| WebRTC mode | Direct UDP only with STUN ICE servers |

## Checklist

- [x] Confirm repo state and GCloud project before mutation.
- [x] Add Helm support for static-IP Ingress without a domain.
- [x] Add IP-only example values.
- [x] Add IP-only deployment docs.
- [x] Render domain and IP-only Helm examples locally.
- [x] Run local service tests where available.
- [x] Reserve gateway global static IP.
- [x] Reserve temporary public control-plane global static IP.
- [x] Create temporary GKE cluster.
- [x] Create direct UDP firewall rule.
- [x] Create Kubernetes Secrets.
- [x] Install Agones separately.
- [x] Install platform chart.
- [x] Install browser-fleet chart.
- [x] Validate gateway health.
- [x] Validate public control-plane health.
- [x] Validate public control-plane client/session flow.
- [x] Validate returned URL schemes.
- [x] Validate browser page load.
- [x] Validate CDP `Browser.getVersion`.
- [x] Validate browser GameServer lifecycle.
- [x] Check direct UDP browser-runtime logs.
- [ ] Clean up Helm releases and GCP resources.

## Commands And Findings

### Preflight

```text
git status --short: clean
git branch --show-current: main
git rev-parse HEAD: 7002a69ec0e2c51e3f5c3a1f1010888caa5140ce
gcloud account: abdulrreshamwala@reclaimprotocol.org
gcloud project: rc-popcorn
```

### Chart Changes

- `gateway.staticIpName` now renders GKE Ingress even when
  `gateway.domainName` is empty.
- `controlPlane.staticIpName` now renders the same hostless HTTP Ingress when
  `controlPlane.domainName` is empty.
- ManagedCertificate and HTTPS redirect render only when `gateway.domainName`
  or `controlPlane.domainName` is set.
- Hostless Ingress rules are used for IP-only HTTP.
- Gateway Service is forced to `ClusterIP` whenever `gateway.staticIpName` is
  set, matching GKE Ingress backend expectations.
- Browser-fleet now supports `imagePullSecrets` for Fleet pods and the optional
  image prepuller.

### Local Verification

```text
helm template examples:
- domain platform values rendered ManagedCertificate, FrontendConfig, host-based Ingress, and HTTPS redirect annotation.
- IP-only platform values rendered hostless gateway and control-plane GKE
  Ingresses with static IP annotations and no ManagedCertificate/FrontendConfig.
- browser-fleet domain and IP-only values rendered successfully.

helm lint charts/platform: passed
helm lint charts/browser-fleet: passed
git diff --check: passed
bun test services/control-plane: 8 pass, 0 fail
bun test services/pool-manager: no tests found
```

### Live Deployment

Created gateway static IP:

```text
gcloud compute addresses create popcorn-oss-ip-test-gateway-ip --global --project rc-popcorn
gateway IP: 136.110.171.122
```

Created temporary public control-plane static IP after the user asked to expose
the control plane instead of using port-forward:

```text
gcloud compute addresses create popcorn-oss-ip-test-control-plane-ip --global --project rc-popcorn
control-plane IP: 8.228.227.173
```

Created the cluster:

```text
gcloud container clusters create popcorn-oss-ip-test \
  --zone us-central1-a \
  --project rc-popcorn \
  --machine-type n2d-standard-8 \
  --num-nodes 1 \
  --disk-size 100 \
  --disk-type pd-balanced \
  --enable-ip-alias \
  --enable-shielded-nodes \
  --workload-pool rc-popcorn.svc.id.goog \
  --tags popcorn-oss-ip-test-node \
  --addons HttpLoadBalancing,GcePersistentDiskCsiDriver

GKE version: 1.35.3-gke.1389000
```

Opened direct UDP only to the operator public IP:

```text
operator IP: 103.135.63.96
gcloud compute firewall-rules create popcorn-oss-ip-test-webrtc-udp \
  --project rc-popcorn \
  --network default \
  --direction INGRESS \
  --action ALLOW \
  --rules udp:59000-59100 \
  --source-ranges 103.135.63.96/32 \
  --target-tags popcorn-oss-ip-test-node
```

Created these Kubernetes Secrets in namespace `popcorn`:

```text
gateway-jwt-keys
pool-manager-service-auth
control-plane-secret
analytics-db-secret
browser-turn-secret
ghcr-pull
```

Secret values were generated locally and intentionally omitted from this log.
`browser-turn-secret` used STUN-only ICE servers.

### Live Blockers And Workarounds

GHCR packages were private. Anonymous pulls failed with `401 Unauthorized`.
After refreshing GitHub auth scopes with `read:packages` and `write:packages`,
the packages were readable locally and a namespace `ghcr-pull` Secret fixed
cluster pulls. Attempts to make the packages public through the GitHub API
returned `404`, so package visibility likely needs to be changed in GitHub
package settings or with a different admin capability.

`browser-runtime:latest` was not published. The browser-fleet release used:

```text
ghcr.io/reclaimprotocol/popcorn-oss/browser-runtime:7002a69ec0e2c51e3f5c3a1f1010888caa5140ce
```

Installing browser-fleet with `agones.install=true` on a fresh cluster failed
because `Fleet` and `FleetAutoscaler` CRDs were not established before the same
release rendered Fleet resources. The working path installed Agones first:

```text
helm upgrade --install agones charts/browser-fleet/charts/agones-1.57.0.tgz \
  --namespace agones-system \
  --create-namespace \
  --set agones.controller.generateTLS=false \
  --set gameservers.minPort=59000 \
  --set gameservers.maxPort=59100 \
  --set-json 'gameservers.namespaces=["popcorn"]'
```

Then browser-fleet was installed with `agones.install=false`.

Changing platform image values and exposing the control plane required deleting
the completed `control-plane-migrate` Job before retrying Helm, because Job pod
templates are immutable:

```text
kubectl -n popcorn delete job control-plane-migrate --ignore-not-found
```

The first public control-plane `/health` checks returned connection resets, then
default backend-style `404`, then `OK` once the GKE forwarding rule finished
warming up. The Ingress backend showed `HEALTHY` before all external requests
were stable.

### Live Validation

Gateway Ingress:

```text
popcorn-gateway: HOSTS=* ADDRESS=136.110.171.122 PORTS=80
curl http://136.110.171.122/health -> 200 OK, body OK
```

Temporary public control-plane Ingress:

```text
control-plane: HOSTS=* ADDRESS=8.228.227.173 PORTS=80
curl http://8.228.227.173/health -> OK after load-balancer warmup
```

Public control-plane client/session flow:

```text
POST http://8.228.227.173/admin/clients -> created client
POST http://8.228.227.173/v1/sessions -> created session
sessionId: gke-ip-public-1779751582
browserId: browser-fleet-7dbt7-648s8
region: us-central1
```

Returned URL schemes and hosts:

```text
url:    http://136.110.171.122/...
cdpUrl: ws://136.110.171.122/...
apiUrl: http://136.110.171.122/...
```

Browser page load:

```text
GET returned HTTP 200
content-type: text/html; charset=utf-8
download size: 6270 bytes
```

CDP:

```text
Browser.getVersion -> Chrome/148.0.7778.96
protocolVersion -> 1.3
```

Agones and direct UDP:

```text
GameServer browser-fleet-7dbt7-648s8 -> Allocated
address: 35.226.22.204
port: 59068
runtime log: Direct WebRTC candidate configured external=35.226.22.204 udp_mux=59068
neko log: nat1to1=35.226.22.204 epr=59000-59100 udpmux=59068
ICE servers: stun:stun.l.google.com:19302
```

This validates that direct UDP is configured and advertised. A full media-plane
test from a real browser/network should still be repeated by an operator,
because direct UDP can be blocked by client NAT or local network policy.

## Required Documentation Fixes Found

- The docs needed a domainless GKE path because the old deployment page implied
  DNS and ManagedCertificate were required for every GKE install.
- The chart examples needed an IP-only values pair.
- CI needed to render the new values pair so this path does not regress.
- The live user requested a public control-plane test path, so the IP-only docs
  now include a second temporary control-plane static IP.
- Fresh Agones installs should be separate from the browser-fleet release.
- GHCR package visibility needs to be public for the examples to work without
  `imagePullSecrets`.
- Browser runtime docs/examples should use a commit tag or digest, not
  `browser-runtime:latest`.
- GKE L7 Ingress can need warmup time even after the backend reports healthy.
- Browser GameServer lookup is more reliable from the returned `browserId` than
  a pod label selector.
- `services/pool-manager` has no Bun tests, so the planned test command
  currently records a coverage gap rather than a passing suite.

## Cleanup Status

Deferred for manual testing after the user asked for public test endpoints.
Cleanup still needs to remove:

```text
Helm releases: browser-fleet, popcorn-platform, agones
GKE cluster: popcorn-oss-ip-test
Firewall rule: popcorn-oss-ip-test-webrtc-udp
Global IPs: popcorn-oss-ip-test-gateway-ip, popcorn-oss-ip-test-control-plane-ip
```
