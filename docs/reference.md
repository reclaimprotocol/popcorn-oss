# Reference

This page is a compact reference for the self-hosted Popcorn OSS surface. For
walkthroughs, see [Quickstart](quickstart.md) and [Deployment](deployment.md).

## Session API

Client integrations create browser sessions through the control plane:

```http
POST /v1/sessions
Authorization: Bearer <client-id>:<client-secret>
Content-Type: application/json
```

Request body:

```json
{
  "sessionId": "demo-session",
  "ttlSeconds": 900,
  "regions": ["us-central1", "asia-south1"]
}
```

- `sessionId` is optional. When set, use 1-64 characters from `A-Z`, `a-z`,
  `0-9`, `_`, and `-`.
- `ttlSeconds` is optional. When set, it must be a positive integer no larger
  than the control-plane `SESSION_MAX_TTL_SECONDS` setting.
- `regions` is optional. When set, the control plane tries only those enabled
  regions in order.
- If `sessionId` is omitted, Popcorn generates one. If `ttlSeconds` is omitted,
  GameServer cleanup uses the configured TTL controller fallback.

Client integrations fetch their own browser sessions through the control plane:

```http
GET /v1/session/:id
Authorization: Bearer <client-id>:<client-secret>
```

Response:

```json
{
  "success": true,
  "sessionId": "demo-session",
  "url": "https://asia.popcorn.example/browser-fleet-abc/demo-session/<token>/",
  "cdpUrl": "wss://asia.popcorn.example/cdp/demo-session/<token>/",
  "apiUrl": "https://asia.popcorn.example/api/demo-session/<token>/",
  "expiresAt": "2026-05-26T12:30:00.000Z",
  "region": "asia-south1",
  "clusterName": "asia-cluster"
}
```

The response mirrors the creation response, with `region` and `clusterName`
added by the control plane.

- `404` — the session does not exist, or it belongs to another client.
- `409` — the session exists but its region is not configured on this control
  plane.
- `502` — the control plane could not reach the regional pool manager.

Client integrations extend their own browser sessions through the control plane:

```http
PATCH /v1/session/:id/ttl
Authorization: Bearer <client-id>:<client-secret>
Content-Type: application/json
```

Request body:

```json
{
  "extendBySeconds": 900
}
```

Client integrations delete their own browser sessions through the control plane:

```http
DELETE /v1/session/:id
Authorization: Bearer <client-id>:<client-secret>
```

Local defaults:

```text
Control plane: http://localhost:8081
Gateway:       http://localhost:8080
```

## Response Fields

Successful response:

```json
{
  "success": true,
  "sessionId": "demo-session",
  "url": "https://gateway.example.com/browser-fleet-abc/demo-session/<token>/",
  "cdpUrl": "wss://gateway.example.com/cdp/demo-session/<token>/",
  "cdpInternalUrl": "wss://gateway.example.com/cdp-internal/demo-session/<token>/",
  "apiUrl": "https://gateway.example.com/api/demo-session/<token>/",
  "browserPodId": "browser-fleet-abc",
  "expiresAt": "2026-05-26T12:30:00.000Z",
  "region": "us-central1",
  "clusterName": "prod-us-central1"
}
```

- `url`: interactive browser view. In VNC/LiveView mode this can be overridden
  to a `/liveview/.../liveview.html` value.
- `cdpUrl`: client-facing Chrome DevTools Protocol endpoint.
- `cdpInternalUrl`: trusted internal CDP endpoint.
- `apiUrl`: browser runtime API endpoint.
- `browserPodId`: allocated browser pod or Agones GameServer name.
- `expiresAt`: explicit session expiry when the session was created or extended
  with a per-session TTL.
- `region`: control-plane region that allocated the session.
- `clusterName`: Kubernetes cluster name configured for that region.

Deployments can add fields through `poolManager.extraSessionUrls`. VNC/LiveView
deployments commonly keep the historical field names while returning LiveView
paths:

```json
{
  "vncUrl": "https://gateway.example.com/liveview/demo-session/<token>/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000",
  "vncWsUrl": "wss://gateway.example.com/liveview-ws/demo-session/<token>"
}
```

Treat every returned URL as a bearer secret. The embedded path tokens authorize
access until the token expires or the session is deleted.

Common errors:

- `400`: invalid session ID, unknown region, disabled region, or malformed body.
- `401`: missing or invalid client credentials.
- `403`: invalid gateway path token or insufficient token scope.
- `404`: session or route not found.
- `409`: requested session ID already exists.
- `502`: regional pool manager could not delete the session.
- `503`: no requested region could allocate a browser session.

## Gateway Paths

The gateway authorizes and routes these paths:

| Path | Purpose |
| --- | --- |
| `/<browserPodId>/<sessionId>/<token>/...` | Browser view and browser assets. |
| `/liveview/<sessionId>/<token>/liveview.html?...` | LiveView HTML route for noVNC-style desktop viewing. |
| `/liveview-ws/<sessionId>/<token>` | LiveView WebSocket route for RFB traffic. |
| `/cdp/<sessionId>/<token>/...` | Client-facing CDP WebSocket/API route. |
| `/cdp-internal/<sessionId>/<token>/...` | Trusted internal CDP route. |
| `/api/<sessionId>/<token>/...` | Browser runtime API route. |
| `/proof/<sessionId>?nonce=<hex>` | Optional attestation proof route. |
| `/health` | Gateway health check. |

The LiveView response fields intentionally retain the historic names `vncUrl`
and `vncWsUrl` so existing clients do not need a response-shape migration. The
route paths and user-facing name are LiveView.

The gateway also falls back to the pool manager for internal UI and API routes
when deployed in that mode. New public clients should use the control-plane
`POST /v1/sessions` API, not pool-manager internal endpoints.

## Admin And Internal APIs

Control-plane admin routes are for trusted operators:

- `GET /admin`: browser admin UI.
- `POST /admin/clients`: create client credentials.
- `GET /admin/clients`: list clients.
- `DELETE /admin/clients/:id`: revoke a client.
- `GET /admin/regions`: list configured regions and health.
- `GET /admin/sessions`: list stored sessions.
- `POST /admin/sessions`: create an operator session.
- `GET /admin/session/:id`: inspect a routed session.
- `DELETE /admin/session/:id`: delete a routed session.
- `PATCH /admin/session/:id/ttl`: extend a routed session.

Create a client with the admin bearer token:

```bash
CLIENT_JSON=$(curl -sS -X POST "$CONTROL_PLANE_URL/admin/clients" \
  -H "Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"my integration"}')

export CLIENT_ID=$(printf '%s' "$CLIENT_JSON" | jq -r .clientId)
export CLIENT_SECRET=$(printf '%s' "$CLIENT_JSON" | jq -r .clientSecret)
```

Regional pool managers expose only control-plane authenticated internal routes:

- `GET /internal/servers`
- `POST /internal/sessions`
- `GET /internal/session/:id`
- `DELETE /internal/session/:id`
- `PATCH /internal/session/:id/ttl`
- `GET /health`

## Config Option Index

Core Helm values:

| Area | Key examples | Notes |
| --- | --- | --- |
| Images | `registry`, `imageTag`, `browserRuntimeImage` | Use published GHCR images or a private mirror. Pin digests for production. |
| Gateway | `gateway.enabled`, `gateway.domainName`, `gateway.serviceType`, `gateway.extraSessionRoutes` | Public entry point for browser, CDP, API, and proof paths. |
| Pool manager | `poolManager.enabled`, `poolManager.gameServerNamespace`, `poolManager.extraSessionUrls`, `poolManager.extraRoutePorts` | Allocates browser sessions and writes route state. |
| Control plane | `controlPlane.enabled`, `controlPlane.domainName`, `controlPlane.regions` | Client session API, admin UI, regional routing, and analytics records. |
| Admin auth | `controlPlane.adminAuth.*` | Password, password file, token, and Google OAuth settings. |
| Secrets | `secrets.*`, `*.secretName`, `*.secretKey` | JWT keys, service tokens, database credentials, admin auth, and the optional browser egress proxy URL. |
| Redis | `redis.enabled`, `poolManager.redisHost`, `gateway.redisHost` | Stores active route and session state. Keep private. |
| Postgres | `controlPlane.database*`, `metabase.database*` | Stores clients, sessions, analytics metadata, and optional Metabase state. |
| Browser fleet | `fleet.*`, `autoscaler.*`, `streaming.mode`, `extraBrowserRuntimeEnv` | Capacity, resource limits, live-view streaming, and runtime environment. |
| Cleanup | `ttlController.*` | Expires sessions and reports terminal state to the control plane. |
| Operations | `otel.*`, `gkeNodePrescaler.*`, `imagePrepuller.*` | OTLP browser log/session event export, capacity, and image warmup helpers. |
| Attestation | `browserRuntimeAttestor.*`, `ccDevicePlugin.*` | Optional confidential-computing proof support. |

Advanced details live in [Configuration](configuration.md),
[Observability](observability.md), and [Security](security.md).
