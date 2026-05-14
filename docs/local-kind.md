# Local Kind Deployment

This guide describes the expected OSS v1 local demo flow for running Popcorn in Kind. It intentionally avoids hosted services, private registries, and cloud-only secrets.

## Prerequisites

- Docker with BuildKit enabled.
- Kind.
- kubectl.
- Helm.
- Make.
- Node.js if you want to run the Playwright or Puppeteer examples.

Clone with the image submodule:

```bash
git clone --recursive https://github.com/reclaimprotocol/popcorn-oss.git
cd popcorn-oss
```

Or initialize submodules after cloning:

```bash
git submodule update --init --recursive
```

## Expected Local Flow

```bash
make local-keys
make run-local-cluster
make connect
```

`make local-keys` creates development-only JWT key material for:

- `services/pool-manager/keys/private.pem`
- `services/gateway/keys/public.pem`

These files are local development secrets. Do not commit generated private keys.

## Build Images

```bash
make build-pool-manager
make build-gateway
make build-browser-node
make build-ttl-controller
```

The local build creates service images for the platform and browser runtime. Browser image inputs come from the separate [popcorn-images](../popcorn-images/README.md) submodule. Use the explicit targets or `make run-local-cluster` for the OSS local path.

## Start Kind and Deploy

```bash
make deploy-local
```

The local deployment is expected to:

- create or reuse a Kind cluster named `popcorn`;
- install Agones;
- load locally built images into Kind;
- install the platform chart with Redis, pool manager, control plane, gateway,
  Postgres, and TTL controller enabled;
- install the browser fleet chart with attestation disabled by default;

The Makefile targets are composable, so you can also run the deployment in stages:

```bash
make up
make local-secrets
make load-local-images
make deploy-local
```

`make local-secrets` expects the local JWT keys above. The generated values are for local development only; see [Secrets](secrets.md) for production Secret names, keys, and external secret-manager options.

## Connect

```bash
make connect
```

The local gateway should be available at:

```text
http://localhost:8080
```

The local control plane should be available at:

```text
http://localhost:8081
```

Check health:

```bash
curl -sS http://localhost:8080/health
curl -sS http://localhost:8081/health
```

## Create a Demo Session

The local control plane uses the development admin token
`local_admin_token_for_dev`, so create a client and then create a routed
session:

```bash
CONTROL_PLANE_URL=http://localhost:8081
CONTROL_PLANE_ADMIN_TOKEN=local_admin_token_for_dev

curl -sS -X POST "$CONTROL_PLANE_URL/admin/clients" \
  -H "Authorization: Bearer $CONTROL_PLANE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"local demo client"}'
```

Use the returned `clientId` and `clientSecret` with `POST /v1/sessions`:

```bash
CLIENT_ID=client_0123456789abcdef
CLIENT_SECRET=secret_0123456789abcdef

curl -sS -X POST "$CONTROL_PLANE_URL/v1/sessions" \
  -H "Authorization: Bearer $CLIENT_ID:$CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"local-demo","regions":["local"]}'
```

The response includes browser and automation URLs. Open `url` in a browser, or
connect automation to `cdpUrl`. See [Control plane session creation](control-plane-sessions.md)
for the full workflow and response shape.

## Playwright Smoke Test

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
  body: JSON.stringify({ sessionId: "playwright-local", regions: ["local"] }),
}).then((r) => r.json());

const browser = await chromium.connectOverCDP(session.cdpUrl);
const page = browser.contexts()[0]?.pages()[0] ?? await browser.newPage();
await page.goto("https://example.com");
console.log(await page.title());
await browser.close();
```

## Puppeteer Smoke Test

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
  body: JSON.stringify({ sessionId: "puppeteer-local", regions: ["local"] }),
}).then((r) => r.json());

const browser = await puppeteer.connect({
  browserWSEndpoint: session.cdpUrl,
});

const page = await browser.newPage();
await page.goto("https://example.com");
console.log(await page.title());
await browser.close();
```

## Reset

```bash
make clean
```

This deletes the Kind cluster. It does not delete locally built Docker images.

## Troubleshooting

- `Missing local JWT keys`: run `make local-keys` once it exists, or create the local key pair shown above.
- `No route found`: confirm a browser GameServer is ready with `kubectl get gameservers`.
- `Failed to allocate browser instance`: check Agones status and browser fleet pods.
- `401 Invalid credentials`: use the development credentials from the OSS Helm example values.
- `403` on browser or CDP paths: the path token is missing, expired, or scoped for a different endpoint.

## Current Dependencies

The local Kind flow depends on Docker, Kind, kubectl, Helm, and the `popcorn-images` submodule. Optional screenshots or GIFs for the local demo can be added later without changing the core smoke test.
