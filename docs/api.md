# Session API

The control plane is the preferred client entry point for new deployments. It
validates clients, tries preferred regions in order, asks a regional pool
manager to allocate a browser pod, and returns gateway URLs for the selected
region.

For the end-to-end workflow of configuring regions, creating client
credentials, and creating sessions through `/v1/sessions`, see
[Control plane session creation](control-plane-sessions.md).

Default local control plane and gateway:

```text
Control plane: http://localhost:8081
Gateway:       http://localhost:8080
```

## Authentication

Client session API requests use bearer credentials:

```http
Authorization: Bearer <client-id>:<client-secret>
```

The control plane validates these credentials directly against Postgres-backed
client records.

Browser, CDP, and runtime API URLs returned from `/v1/sessions` include signed path tokens. Treat those URLs as bearer secrets.

For local Kind smoke tests, create a control-plane client and call
`/v1/sessions` as documented in the local Kind guide.

## Create Session (Control Plane API)

```http
POST /v1/sessions
```

Create a client first from the control-plane admin UI or `POST
/admin/clients`. Session requests authenticate with that returned
`clientId:clientSecret` pair.

Request:

```bash
curl -sS -X POST https://control-plane.example.com/v1/sessions \
  -H "Authorization: Bearer <client-id>:<client-secret>" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"demo-session","regions":["asia-south1","us-central1"]}'
```

Body:

```json
{
  "sessionId": "demo-session",
  "regions": ["asia-south1", "us-central1"]
}
```

`sessionId` is optional. `regions` is optional; when present, regions are tried
only in the specified priority order.

Response:

```json
{
  "success": true,
  "sessionId": "demo-session",
  "url": "https://asia.example.com/browser-fleet-abc/demo-session/<token>/",
  "cdpUrl": "wss://asia.example.com/cdp/demo-session/<token>/",
  "cdpInternalUrl": "wss://asia.example.com/cdp-internal/demo-session/<token>/",
  "apiUrl": "https://asia.example.com/api/demo-session/<token>/",
  "browserPodId": "browser-fleet-abc",
  "region": "asia-south1",
  "clusterName": "asia-cluster"
}
```

If no requested region can allocate, the control plane returns `503` with an
`attempts` array describing each regional failure.

Fields:

- `url`: interactive browser view.
- `cdpUrl`: client-facing CDP endpoint.
- `cdpInternalUrl`: trusted internal CDP endpoint with broader access.
- `apiUrl`: browser runtime API route.
- `browserPodId`: current browser pod or GameServer name.

Deployments may add extra URL fields through Helm extension values. Those fields
are deployment-specific and are not part of the OSS default response shape.

## Health

```http
GET /health
```

Example:

```bash
curl -sS http://localhost:8080/health
```

Response:

```text
OK
```

## Admin Endpoints

Admin endpoints are intended for local operations and trusted internal tooling.
Pool-manager exposes only internal allocation endpoints. Control-plane exposes
the admin UI at `/admin` plus token/Basic/cookie-protected JSON helpers for
client and session management. The client `/v1/sessions` bearer credentials
are separate from admin credentials.

- Control-plane `GET /admin/regions`: list configured regions and regional health.
- Control-plane `GET /admin/sessions`: list stored sessions, optionally filtered by `clientId`.
- Control-plane `POST /admin/sessions`: create a routed admin session.
- Control-plane `GET /admin/session/:id`: inspect a routed session through its region.
- Control-plane `DELETE /admin/session/:id`: delete a routed session.

Do not expose admin endpoints publicly without additional access control.

For browser use, visit the control-plane `/admin` UI.

## Gateway Paths

The gateway routes returned URLs by path:

- `/<browserPodId>/<sessionId>/<token>/...`: browser view.
- `/cdp/<sessionId>/<token>/...`: restricted CDP.
- `/cdp-internal/<sessionId>/<token>/...`: trusted internal CDP.
- `/api/<sessionId>/<token>/...`: browser runtime API.
- `/proof/<sessionId>?nonce=<hex>`: optional attestation proof.

## Playwright

```js
import { chromium } from "playwright";

const controlPlaneUrl = process.env.CONTROL_PLANE_URL ?? "http://localhost:8081";
const clientId = process.env.POPCORN_CLIENT_ID;
const clientSecret = process.env.POPCORN_CLIENT_SECRET;
const session = await fetch(`${controlPlaneUrl}/v1/sessions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${clientId}:${clientSecret}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ sessionId: `pw-${Date.now()}` }),
}).then((r) => r.json());

const browser = await chromium.connectOverCDP(session.cdpUrl);
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.goto("https://example.com");
console.log(await page.title());
await browser.close();
```

## Puppeteer

```js
import puppeteer from "puppeteer-core";

const controlPlaneUrl = process.env.CONTROL_PLANE_URL ?? "http://localhost:8081";
const clientId = process.env.POPCORN_CLIENT_ID;
const clientSecret = process.env.POPCORN_CLIENT_SECRET;
const session = await fetch(`${controlPlaneUrl}/v1/sessions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${clientId}:${clientSecret}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ sessionId: `pptr-${Date.now()}` }),
}).then((r) => r.json());

const browser = await puppeteer.connect({
  browserWSEndpoint: session.cdpUrl,
});

const page = await browser.newPage();
await page.goto("https://example.com");
console.log(await page.title());
await browser.close();
```

## Errors

Common responses:

- `401`: missing, malformed, or invalid client credentials.
- `403`: invalid path token or insufficient path-token scope.
- `404`: session or route not found.
- `503`: no browser capacity or allocation failed.

Clients should handle `503` with retry and backoff. Do not retry indefinitely after `401` or `403`.
