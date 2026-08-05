# Gateway

The gateway is the public, session-aware reverse proxy for browser, LiveView,
CDP, attestation, and operator-defined routes. It uses Redis route records to
find the allocated browser Pod and validates the scoped RS256 token embedded in
each session URL.

The implementation runs on OpenResty. `nginx.conf` defines routing and redacted
logging, while `auth.lua` enforces token algorithm, scope, session identity,
expiry, and route-bound access deadlines.

## Configuration

The container listens on TCP port `80` and accepts these environment values:

| Variable | Default | Purpose |
| --- | --- | --- |
| `POD_NAMESPACE` | `default` | Namespace used for service DNS defaults. |
| `GATEWAY_REDIS_HOST` | `redis.<namespace>.svc.cluster.local` | Redis route store. |
| `GATEWAY_POOL_MANAGER_HOST` | `pool-manager.<namespace>.svc.cluster.local` | Internal pool-manager fallback. |
| `RESOLVER_IP` | detected from `/etc/resolv.conf` | Kubernetes DNS resolver. |

The platform chart mounts the JWT public key at
`/etc/nginx/certs/public.pem`. Route values and security expectations are
documented in [Architecture](../../docs/architecture.md) and
[Security](../../docs/security.md).

## Develop

```bash
bash tests/auth-algorithm.sh
bash tests/route-bound-access.sh
docker build -t popcorn/gateway:local .
```
