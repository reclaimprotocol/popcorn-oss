# Control Plane

Central client entry point for Popcorn browser sessions across regions. The
control plane owns client credentials, multi-region session routing, and
analytics storage. Pool managers remain the regional allocators.

## Features

- Client credential authentication with client ID + secret
- Region-prioritized `POST /v1/sessions` session creation
- Compatibility APIs for existing pool-manager validation and session callbacks
- PostgreSQL-backed client and session records
- Admin API and UI for clients, sessions, and regional pool state

## Configuration

```bash
export POSTGRES_HOST=<postgres-host>
export POSTGRES_USER=analytics_admin
export POSTGRES_PASSWORD=<password>
export POSTGRES_DB=analytics
export CONTROL_PLANE_SERVICE_AUTH_TOKEN=<global-compat-service-token>
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
    "serviceAuthTokenFile": "/app/secrets/pool-managers/asia-south1/SERVICE_AUTH_TOKEN",
    "enabled": true
  }
]'
```

`SERVICE_AUTH_TOKEN` and `ADMIN_TOKEN` are still accepted as compatibility
aliases. Prefer per-region pool-manager tokens through `serviceAuthTokenFile`
or `serviceAuthToken` on each region.

## Client Session API

```http
POST /v1/sessions
Authorization: Bearer <client-id>:<client-secret>
Content-Type: application/json
```

Request:

```json
{
  "sessionId": "demo-session",
  "regions": ["asia-south1", "us-central1"]
}
```

`sessionId` and `regions` are optional. When `regions` is omitted, enabled
regions are tried in configured order. When it is present, only those regions
are tried, in the provided priority order.

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
  "region": "asia-south1",
  "clusterName": "asia-cluster"
}
```

## Compatibility APIs

Existing pool managers can continue to call:

- `POST /validate`
- `POST /sessions`
- `POST /sessions/:id/end`

These routes use the service token and preserve the old analytics callback
contract while the canonical service name is now `control-plane`.

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
