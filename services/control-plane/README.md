# Control Plane

Central client entry point for Popcorn browser sessions across regions. The
control plane owns client credentials, multi-region session routing, and
analytics storage. Pool managers remain the regional allocators.

## Features

- Client credential authentication with client ID + secret
- Region-prioritized `POST /v1/sessions` session creation
- TTL callback support for expired regional sessions
- PostgreSQL-backed client and session records
- Admin API and UI for clients, sessions, and regional pool state

## Configuration

```bash
export POSTGRES_HOST=<postgres-host>
export POSTGRES_USER=analytics_admin
export POSTGRES_PASSWORD=<password>
export POSTGRES_DB=analytics
export CONTROL_PLANE_SERVICE_AUTH_TOKEN=<control-plane-service-token>
export ADMIN_AUTH_STRATEGIES=password,google
export ADMIN_USER=admin
export ADMIN_PASS=<admin-password>
export ADMIN_SESSION_SECRET=<cookie-signing-secret>
export CONTROL_PLANE_ADMIN_TOKEN=<token-for-admin-operations>
export CONTROL_PLANE_REGIONS='[
  {
    "name": "asia-south1",
    "clusterName": "asia-cluster",
    "poolManagerUrl": "http://pool-manager.asia.svc.cluster.local",
    "publicGatewayUrl": "https://asia.popcorn.example",
    "serviceAuthTokenFile": "/app/secrets/pool-managers/asia-south1/POOL_MANAGER_SERVICE_AUTH_TOKEN",
    "enabled": true
  }
]'
```

Prefer per-region pool-manager tokens through `serviceAuthTokenFile` or
`serviceAuthToken` on each region.

## Client Session API

For the complete client setup and session creation guide, see
[Reference](../../docs/reference.md).

```http
POST /v1/sessions
Authorization: Bearer <client-id>:<client-secret>
Content-Type: application/json
```

Request:

```json
{
  "sessionId": "demo-session",
  "ttlSeconds": 900,
  "regions": ["asia-south1", "us-central1"]
}
```

`sessionId` and `regions` are optional. When `regions` is omitted, enabled
regions are tried in configured order. When it is present, only those regions
are tried, in the provided priority order. `ttlSeconds` is optional and is
capped by `SESSION_MAX_TTL_SECONDS`.

Response:

```json
{
  "success": true,
  "sessionId": "demo-session",
  "url": "https://asia.popcorn.example/browser-fleet-abc/demo-session/<token>/",
  "cdpUrl": "wss://asia.popcorn.example/cdp/demo-session/<token>/",
  "cdpInternalUrl": "wss://asia.popcorn.example/cdp-internal/demo-session/<token>/",
  "apiUrl": "https://asia.popcorn.example/api/demo-session/<token>/",
  "browserPodId": "browser-fleet-abc",
  "expiresAt": "2026-05-26T12:30:00.000Z",
  "region": "asia-south1",
  "clusterName": "asia-cluster"
}
```

Extend a session owned by the client:

```http
PATCH /v1/session/:id/ttl
Authorization: Bearer <client-id>:<client-secret>
Content-Type: application/json

{ "extendBySeconds": 900 }
```

Delete a session owned by the client:

```http
DELETE /v1/session/:id
Authorization: Bearer <client-id>:<client-secret>
```

## Service APIs

The TTL controller reports expired sessions with `POST /sessions/:id/end`.
Pool managers do not call compatibility validation or session-ingest APIs.

## Admin APIs

Admin routes accept password/file/OAuth browser sessions. `Authorization:
Bearer <CONTROL_PLANE_ADMIN_TOKEN>` is still accepted for compatibility and
automation.

- `GET /admin/regions`
- `GET /admin/sessions`
- `POST /admin/sessions`
- `GET /admin/session/:id`
- `DELETE /admin/session/:id`
- `GET /admin/clients`
- `POST /admin/clients`
- `DELETE /admin/clients/:id`

Run migrations with:

```bash
bun run db:migrate
```
