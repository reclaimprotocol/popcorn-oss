# Control Plane Session Creation

The control plane is the recommended entry point for new client-created browser
sessions. Clients call one stable API, and the control plane chooses an enabled
regional pool manager, records the session, and returns gateway URLs for the
allocated browser pod.

Client integrations should call `POST /v1/sessions` on the control plane.
Regional pool managers expose only internal allocation endpoints for the
control plane.

## Endpoint

Local Kind exposes the control plane at:

```text
http://localhost:8081
```

Production deployments normally expose the control plane through its own host,
for example:

```text
https://control-plane.example.com
```

The browser URLs returned by the control plane still point at the selected
region's public gateway, not necessarily at the control-plane host.

## 1. Configure Regions

Each control-plane region points at one regional pool manager and the gateway
URL clients should use for sessions allocated there:

```yaml
controlPlane:
  enabled: true
  domainName: control-plane.example.com
  regions:
    - name: us-central1
      clusterName: example-gke-cluster
      poolManagerUrl: http://pool-manager.popcorn.svc.cluster.local
      publicGatewayUrl: https://gateway.example.com
      enabled: true
      poolManagerAuth:
        secretName: pool-manager-us-central1-service-auth
        secretKey: POOL_MANAGER_SERVICE_AUTH_TOKEN
```

Regions are tried in the order configured unless a session request supplies a
`regions` list. Disabled regions cannot be selected.

For local Kind, `make run-local-cluster` enables one `local` region and maps the
control plane to `http://localhost:8081`.

## 2. Create Client Credentials

Create client credentials from the control-plane admin UI at `/admin`, or use
the admin API with `CONTROL_PLANE_ADMIN_TOKEN`.

Local Kind uses this development token unless you override it:

```bash
CONTROL_PLANE_URL=http://localhost:8081
CONTROL_PLANE_ADMIN_TOKEN=local_admin_token_for_dev

curl -sS -X POST "$CONTROL_PLANE_URL/admin/clients" \
  -H "Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"demo client"}'
```

The response includes a `clientId` and `clientSecret`. Store the secret when it
is returned; the control plane stores only its hash and will not show it again.

```json
{
  "success": true,
  "clientId": "client_0123456789abcdef",
  "clientSecret": "secret_0123456789abcdef..."
}
```

## 3. Create A Session

Call `POST /v1/sessions` with bearer credentials in the form
`clientId:clientSecret`:

```bash
CONTROL_PLANE_URL=http://localhost:8081
CLIENT_ID=client_0123456789abcdef
CLIENT_SECRET=secret_0123456789abcdef...

curl -sS -X POST "$CONTROL_PLANE_URL/v1/sessions" \
  -H "Authorization: Bearer $CLIENT_ID:$CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "demo-session",
    "regions": ["local"]
  }'
```

`sessionId` is optional. If provided, it must be 1-64 characters using only
letters, numbers, underscores, and hyphens. If omitted, the control plane
generates one.

`regions` is optional. If provided, it must be a non-empty array of enabled
region names. The control plane tries only those regions, in the provided order.
If omitted, all enabled regions are tried in configured order.

## 4. Use The Response

A successful response includes the selected region, the cluster name, and the
gateway URLs for the browser runtime:

```json
{
  "success": true,
  "sessionId": "demo-session",
  "url": "http://localhost:8080/browser-fleet-abc/demo-session/<token>/",
  "cdpUrl": "ws://localhost:8080/cdp/demo-session/<token>/",
  "cdpInternalUrl": "ws://localhost:8080/cdp-internal/demo-session/<token>/",
  "apiUrl": "http://localhost:8080/api/demo-session/<token>/",
  "browserPodId": "browser-fleet-abc",
  "region": "local",
  "clusterName": "local"
}
```

- `url`: interactive browser view.
- `cdpUrl`: client-facing Chrome DevTools Protocol endpoint for automation.
- `cdpInternalUrl`: trusted internal CDP endpoint with broader access.
- `apiUrl`: browser runtime API route.
- `browserPodId`: selected browser pod or Agones GameServer name.
- `region`: control-plane region that allocated the session.
- `clusterName`: Kubernetes cluster name reported for that region.

Treat every returned URL as a bearer secret. The path tokens embedded in those
URLs authorize browser, CDP, and runtime API access for that session.

## Playwright Example

```js
import { chromium } from "playwright";

const controlPlaneUrl = process.env.CONTROL_PLANE_URL ?? "http://localhost:8081";
const clientId = process.env.POPCORN_CLIENT_ID;
const clientSecret = process.env.POPCORN_CLIENT_SECRET;

const response = await fetch(`${controlPlaneUrl}/v1/sessions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${clientId}:${clientSecret}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    sessionId: `pw-${Date.now()}`,
    regions: ["local"],
  }),
});

if (!response.ok) {
  throw new Error(`Session create failed: ${response.status} ${await response.text()}`);
}

const session = await response.json();
const browser = await chromium.connectOverCDP(session.cdpUrl);
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();

await page.goto("https://example.com");
console.log(await page.title());
await browser.close();
```

In production, remove the hard-coded `regions` value unless the client needs to
pin or prioritize specific regions.

## Clean Up Sessions

Client session creation currently goes through `/v1/sessions`. Operational
cleanup uses the control-plane admin API:

```bash
curl -sS -X DELETE "$CONTROL_PLANE_URL/admin/session/demo-session" \
  -H "Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN"
```

Deletion asks the selected regional pool manager to remove route state and shut
down the assigned GameServer, then records the session as deleted.

## Common Failures

- `401 Missing credentials`: send `Authorization: Bearer <client-id>:<client-secret>`.
- `401 Invalid credentials`: create a client in the control plane, confirm it is active, and use the returned secret.
- `400 Invalid session ID`: use only `A-Z`, `a-z`, `0-9`, `_`, and `-`, up to 64 characters.
- `400 Unknown region`: request only names present in `controlPlane.regions`.
- `400 Region is disabled`: enable the region before requesting it.
- `409 Session ID already exists`: omit `sessionId` or choose a new value.
- `503 No requested region could allocate a session`: check the returned `attempts` array and the selected regional pool manager.
