# API and gateway reference

This page lists the public APIs and gateway routes for a self-hosted deployment.
Pool-manager `/internal/*` routes must remain private.

## Credentialed client API

Client routes use:

```http
Authorization: Bearer <client-id>:<client-secret>
```

### Create a session

```http
POST /v1/sessions
Content-Type: application/json
```

```json
{
  "sessionId": "demo-session",
  "ttlSeconds": 900,
  "regions": ["us-central1", "asia-south1"]
}
```

All fields are optional:

- `sessionId`: 1 to 64 letters, digits, `_`, or `-`. The server generates it
  when omitted.
- `ttlSeconds`: positive integer at or below
  `controlPlane.sessionMaxTtlSeconds`.
- `regions`: enabled region names tried in the supplied order.
- `liveViewEncryption`: requests default to the standard transport; set this to
  `"e2e"` to require the E2E transport.

The viewer creates its key during the first encrypted connection:

```json
{
  "sessionId": "demo",
  "regions": ["local"],
  "liveViewEncryption": "e2e"
}
```

The create response releases `liveViewE2e.bindingSecret` once. The viewer
generates an X25519 keypair and sends the secret inside its first encrypted
Noise handshake. After the pod persists the enrolled public key, the viewer
removes the secret from reconnect storage. Fetch and TTL responses return
persistent session metadata.

The create response puts the bootstrap data in a `#popcorn-e2e=...` fragment on
`url` and `vncUrl`. The browser keeps the fragment client-side. The viewer stores
the bootstrap data and client key, then removes the fragment. On reload, the
viewer route finds the stored allocation record. Recreating the same session ID
creates a new allocation record and client key.

### Get a session

```http
GET /v1/session/:id
```

The caller must own the session.

### Extend a session

```http
PATCH /v1/session/:id/ttl
Content-Type: application/json
```

```json
{
  "extendBySeconds": 300
}
```

### Delete a session

```http
DELETE /v1/session/:id
```

Deletion ends the allocated GameServer and removes active route state. Clients
should delete sessions as soon as work is complete rather than waiting for TTL
cleanup.

## Session response

```json
{
  "success": true,
  "sessionId": "demo-session",
  "url": "https://browser.example.com/liveview/demo-session/<token>/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000",
  "cdpUrl": "wss://browser.example.com/cdp/demo-session/<token>/",
  "cdpInternalUrl": "wss://browser.example.com/cdp-internal/demo-session/<token>/",
  "apiUrl": "https://browser.example.com/api/demo-session/<token>/",
  "vncUrl": "https://browser.example.com/liveview/demo-session/<token>/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000",
  "vncWsUrl": "wss://browser.example.com/liveview-ws/demo-session/<token>",
  "browserPodId": "browser-fleet-abc",
  "expiresAt": "2026-08-04T12:30:00.000Z",
  "region": "us-central1",
  "clusterName": "popcorn-prod-us"
}
```

| Field | Meaning |
| --- | --- |
| `url` | canonical interactive LiveView page |
| `cdpUrl` | restricted client CDP endpoint |
| `cdpInternalUrl` | trusted full-CDP endpoint |
| `apiUrl` | generic extension API path returned when a matching extension is installed |
| `vncUrl` | compatibility name for the canonical LiveView page |
| `vncWsUrl` | compatibility name for the RFB WebSocket endpoint |
| `browserPodId` | allocated Agones GameServer/pod identity |
| `expiresAt` | session deadline when one is set |
| `region` | selected control-plane region name |
| `clusterName` | selected cluster access identity |

For an E2E session, `url` and `vncUrl` point to the same LiveView page with
`encryption=e2e`. The create response also contains `liveViewE2e` metadata and
the one-time binding secret. `cdpUrl` and `cdpInternalUrl` remain available to
server integrations. Authenticated WSS protects these server-side connections
in transit. The [LiveView E2E guide](liveview-e2e-encryption.md) defines the
handshake and response fields.

`sessionExtensions.*.routing.sessionUrls` may add deployment-owned response
fields. Core LiveView fields take precedence over extension fields.

Treat every full URL as a bearer secret.

## Common API status codes

| Status | Typical meaning |
| ---: | --- |
| 400 | invalid identifier, TTL, region, or request body |
| 401 | missing or invalid client/admin credentials |
| 403 | client lacks cluster access or gateway token scope is wrong |
| 404 | unknown session or route, or resource owned by another client |
| 409 | requested session already exists or state conflicts |
| 502 | a regional dependency returned an invalid/error response |
| 503 | eligible region allocation failed |

Error bodies and logs provide the specific reason. Use them to distinguish
ownership, payment, and routing failures that share a status code.

## Admin API

Admin routes are for trusted operators. The control plane provides a browser UI
at `/admin` plus JSON routes including:

| Route | Purpose |
| --- | --- |
| `GET /admin/regions` | configured region health |
| `GET /admin/sessions` | durable session records |
| `POST /admin/sessions` | operator-created session |
| `GET /admin/session/:id` | inspect one session |
| `PATCH /admin/session/:id/ttl` | extend one session |
| `DELETE /admin/session/:id` | terminate one session |
| `GET /admin/clients` | list clients |
| `POST /admin/clients` | create credentials |
| `PATCH /admin/clients/:id` | update status or cluster access |
| `DELETE /admin/clients/:id` | revoke a client |

Create a scoped client:

```bash
curl -fsS -X POST "$CONTROL_PLANE_URL/admin/clients" \
  -H "Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"automation","allowedClusters":["popcorn-prod-us"]}'
```

`allowedClusters` accepts cluster names. An empty or omitted list selects
deny-all. `null` grants all current and future non-x402 clusters and should be
used only as an explicit compatibility choice.

## Gateway paths

| Path | Token/access model | Upstream |
| --- | --- | --- |
| `/liveview/<session>/<token>/...` | restricted session token | browser `:6080` |
| `/liveview-ws/<session>/<token>` | restricted session token | browser `:6080` |
| `/cdp/<session>/<token>/...` | restricted session token and CDP policy | browser `:9222` |
| `/cdp-agent/<session>/<token>/...` | route-bound automation scope | browser `:9226` |
| `/cdp-internal/<session>/<token>/...` | internal scope | browser `:9226` |
| `/api/<session>/<token>/...` | internal scope | optional route key `api` |
| `/proof/<session>?nonce=<hex>` | session route and proof validation | optional attestor `:8085` |
| `/health` | public access | gateway health response |

The gateway may also serve the older
`/<browserPodId>/<session>/<token>/...` browser asset path. New integrations
should use the returned URLs rather than constructing paths.

## Internal regional API

The control plane calls the pool manager with
`POOL_MANAGER_SERVICE_AUTH_TOKEN`. The pool manager exposes:

```text
GET    /internal/servers
POST   /internal/sessions
GET    /internal/session/:id
PATCH  /internal/session/:id/ttl
PATCH  /internal/session/:id/access-ttl
POST   /internal/session/:id/reallocate-expired
DELETE /internal/session/:id
GET    /health
```

These routes can allocate and terminate browser workloads. Keep them on the
private control-plane network.

## Optional x402 API

The paid API is isolated under `/v1/x402/sessions`. It uses payment challenges
and capability-style session access rather than client ID/client secret.
`/v1/sessions` keeps its credentialed client behavior when x402 is enabled. See
[x402 API](x402.md) for the complete lifecycle and security model.
