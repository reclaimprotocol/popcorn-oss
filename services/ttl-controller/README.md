# TTL Controller

The TTL controller watches allocated Agones GameServers and deletes sessions
that outlive their configured allocation TTL. It also reports terminal session
state to the control plane when callback configuration is present.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `--ttl-duration` | `10m` | Maximum allocation lifetime. |
| `--health-probe-bind-address` | `:8081` | Health and readiness probes. |
| `--leader-elect` | `false` | Enables controller-runtime leader election. |
| `CONTROL_PLANE_URL` | unset | Control-plane callback endpoint. |
| `CONTROL_PLANE_SERVICE_AUTH_TOKEN` | unset | Authenticates lifecycle callbacks. |
| `CLUSTER_NAME` | unset | Identifies the reporting cluster. |

The platform chart configures these values under `ttlController.*`. See
[Configuration](../../docs/configuration.md) and
[Operations](../../docs/operations.md).

## Develop

```bash
go test ./...
docker build -t popcorn/ttl-controller:local .
```
