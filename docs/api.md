# Session API

The pool manager owns session lifecycle. In a deployed cluster, clients call the gateway, and the gateway proxies API requests to the pool manager or browser pod based on the path.

Default local gateway:

```text
http://localhost:8080
```

## Authentication

Client session API requests use bearer credentials:

```http
Authorization: Bearer <client-id>:<client-secret>
```

Production and staged deployments should issue and rotate client credentials through their own auth layer (for example, analytics service integration).

Browser, CDP, and runtime API URLs returned from `/session` include signed path tokens. Treat those URLs as bearer secrets.

For local Kind smoke tests, use `/admin/session` with trusted local admin credentials (`admin:admin`) as documented in the local Kind guide.

## Create Session (Client API)

```http
POST /session
```

This endpoint is the client-facing API path. It requires client credentials to be configured in your deployment.

If your local setup has not wired client credentials, this endpoint can return `401/403`.

Request:

```bash
curl -sS -X POST http://localhost:8080/session \
  -H "Authorization: Bearer <client-id>:<client-secret>" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"demo-session"}'
```

Body:

```json
{
  "sessionId": "demo-session"
}
```

`sessionId` is optional. If omitted, the pool manager generates a short ID.

Response:

```json
{
  "success": true,
  "sessionId": "demo-session",
  "url": "http://localhost:8080/browser-fleet-abc/demo-session/<token>/",
  "cdpUrl": "ws://localhost:8080/cdp/demo-session/<token>/",
  "cdpInternalUrl": "ws://localhost:8080/cdp-internal/demo-session/<token>/",
  "apiUrl": "http://localhost:8080/api/demo-session/<token>/",
  "browserPodId": "browser-fleet-abc"
}
```

Fields:

- `url`: interactive browser view.
- `cdpUrl`: client-facing CDP endpoint.
- `cdpInternalUrl`: trusted internal CDP endpoint with broader access.
- `apiUrl`: browser runtime API route.
- `browserPodId`: current browser pod or GameServer name.

## Get Session

```http
GET /session/:id
```

Example:

```bash
curl -sS http://localhost:8080/session/demo-session \
  -H "Authorization: Bearer <client-id>:<client-secret>"
```

Response shape is the same as create session. A missing session returns `404`.

## Delete Session

```http
DELETE /session/:id
```

Example:

```bash
curl -sS -X DELETE http://localhost:8080/session/demo-session \
  -H "Authorization: Bearer <client-id>:<client-secret>"
```

Response:

```json
{
  "success": true
}
```

Deleting a session removes route state and asks Agones to shut down the assigned GameServer.

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

Admin endpoints are intended for local operations and trusted internal tooling. They use HTTP Basic auth configured by the deployment.

- `GET /admin/servers`: list GameServers and allocation status.
- `POST /admin/session`: create a session attributed to the admin client.
- `GET /admin/session/:id`: inspect an admin-visible session.
- `DELETE /admin/session/:id`: delete a session.
- `DELETE /admin/gameserver/:name`: force shutdown for a GameServer.

Do not expose admin endpoints publicly without additional access control.

### Create Session (Admin)

```bash
POPCORN_ADMIN_USER="${POPCORN_ADMIN_USER:-admin}"
POPCORN_ADMIN_PASS="${POPCORN_ADMIN_PASS:-admin}"

curl -sS -X POST http://localhost:8080/admin/session \
  -u "$POPCORN_ADMIN_USER:$POPCORN_ADMIN_PASS" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"admin-demo"}'
```

The response shape matches client session creation.

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

const adminUser = process.env.POPCORN_ADMIN_USER ?? "admin";
const adminPass = process.env.POPCORN_ADMIN_PASS ?? "admin";
const session = await fetch("http://localhost:8080/admin/session", {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from(`${adminUser}:${adminPass}`).toString("base64"),
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

const adminUser = process.env.POPCORN_ADMIN_USER ?? "admin";
const adminPass = process.env.POPCORN_ADMIN_PASS ?? "admin";
const session = await fetch("http://localhost:8080/admin/session", {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from(`${adminUser}:${adminPass}`).toString("base64"),
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
