# Pool Manager

The pool manager allocates Agones browser GameServers, creates scoped session
URLs, writes session and route state to Redis, and shuts sessions down. It is a
regional internal service called by the control plane; it is not a public
client API.

## Internal API

The service listens on TCP port `3000` and exposes:

- `GET /health`
- `GET /internal/servers`
- `POST /internal/sessions`
- `GET /internal/session/:id`
- `PATCH /internal/session/:id/ttl`
- `PATCH /internal/session/:id/access-ttl`
- `POST /internal/session/:id/reallocate-expired`
- `DELETE /internal/session/:id`

Internal routes require `POOL_MANAGER_SERVICE_AUTH_TOKEN`.

## Configuration

Core environment values are `GAME_SERVER_NAMESPACE`, `GAME_SERVER_FLEET`,
`REDIS_HOST`, `REDIS_SECONDARY_HOST`, `CLUSTER_NAME`, and `POPCORN_REGION`.
Operators can add same-pod services without changing pool-manager source by
setting `POOL_MANAGER_SESSION_EXTENSION_ROUTE_PORTS` and
`POOL_MANAGER_SESSION_EXTENSION_URLS` from `sessionExtensions` in the platform chart.

OTLP export uses the standard `OTEL_EXPORTER_OTLP_*` values when
`OTEL_LOGS_ENABLED=true`. See [Configuration](../../docs/configuration.md),
[API reference](../../docs/reference.md), and
[Operations](../../docs/operations.md) for deployment contracts.

## Develop

```bash
bun install --frozen-lockfile
bun test
bun run index.ts
docker build -t popcorn/pool-manager:local .
```

The service requires a valid auth token and access to Redis and Kubernetes when
started outside tests.
