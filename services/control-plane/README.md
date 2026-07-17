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
- Operations analytics: live fleet allocation plus session-lifecycle stats
  (`GET /internal/stats` and the admin **Analytics** tab)

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

`url` is the primary interactive browser view. Deployments can add more response
fields through the pool manager's extra URL templates. In VNC/LiveView mode,
`url` can be overridden to `/liveview/.../liveview.html`; `vncUrl` and
`vncWsUrl` can also be returned as compatibility field names whose values use
`/liveview/.../liveview.html` and `/liveview-ws/...`.

Fetch a session owned by the client:

```http
GET /v1/session/:id
Authorization: Bearer <client-id>:<client-secret>
```

Returns the regional session details (same shape as the creation response,
including `region` and `clusterName`). Unknown sessions, and sessions owned by
another client, return `404`. A session whose region is not configured returns
`409`.

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

### Operations stats

```http
GET /internal/stats?windowHours=1
Authorization: Bearer <CONTROL_PLANE_SERVICE_AUTH_TOKEN>
```

Returns live fleet allocation (read from the pool managers / Agones) combined
with cumulative session stats over the window. `windowHours` is optional
(default `1`, capped at `720`). Duration and outcome counts are keyed off
`ended_at`; `created` is keyed off `created_at`.

```json
{
  "windowHours": 1,
  "configuredTtlSeconds": 900,
  "live": { "allocated": 18, "ready": 12, "capacity": 30, "activeSessions": 5 },
  "throughput": { "sessionsPerMinute": 0.25 },
  "window": {
    "created": 15,
    "deleted": 3,
    "expired": 6,
    "ended": 9,
    "avgDurationSeconds": 142,
    "p50DurationSeconds": 120,
    "p95DurationSeconds": 300,
    "totalDurationSeconds": 1278
  },
  "byRegion": [
    { "region": "asia-south1", "allocated": 18, "capacity": 30, "sessions": 15 }
  ],
  "topClients": [ { "clientName": "Acme Corp", "sessions": 9 } ],
  "series": [
    { "bucketStart": "2026-07-17T14:00:00.000Z", "created": 2, "deleted": 1, "expired": 1, "ended": 2, "avgDurationSeconds": 130 }
  ]
}
```

`series` is a 12-bucket time series over the window for the trend charts. The
same payload backs the admin **Analytics** tab (`GET /admin/ui/analytics`).
`configuredTtlSeconds` reflects `SESSION_MAX_TTL_SECONDS`.

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

The admin UI has three tabs — **Clients**, **Clusters**, and **Analytics**.
The Analytics tab (`GET /admin/ui/analytics?windowHours=1`) renders the
`/internal/stats` data: live allocation, session-lifecycle metrics, and trend
charts (created vs ended, average duration, outcome split, per-region
allocation, top clients).

Run migrations with:

```bash
bun run db:migrate
```
