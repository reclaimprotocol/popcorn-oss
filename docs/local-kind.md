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
cd popcorn
```

The `reclaimprotocol/popcorn-oss` repository may remain private while release validation is in progress.

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
- install the platform chart with Redis, pool manager, and gateway enabled;
- install the browser fleet chart with attestation disabled by default;

If a parallel PR has not landed yet, the available fallback targets are:

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

Check health:

```bash
curl -sS http://localhost:8080/health
```

## Create a Demo Session

The local Kind smoke-test flow uses the admin endpoint, so external client credentials are not required.
`/session` requires analytics-backed client credentials and is not assumed in the default local path.

```bash
POPCORN_ADMIN_USER="${POPCORN_ADMIN_USER:-admin}"
POPCORN_ADMIN_PASS="${POPCORN_ADMIN_PASS:-admin}"

curl -sS -X POST http://localhost:8080/admin/session \
  -u "$POPCORN_ADMIN_USER:$POPCORN_ADMIN_PASS" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"local-demo"}'
```

The response includes browser and automation URLs:

```json
{
  "success": true,
  "sessionId": "local-demo",
  "url": "http://localhost:8080/browser-fleet-abc/local-demo/<token>/",
  "cdpUrl": "ws://localhost:8080/cdp/local-demo/<token>/",
  "cdpInternalUrl": "ws://localhost:8080/cdp-internal/local-demo/<token>/",
  "apiUrl": "http://localhost:8080/api/local-demo/<token>/",
  "browserPodId": "browser-fleet-abc"
}
```

Open `url` in a browser, or connect automation to `cdpUrl`.

## Playwright Smoke Test

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
  body: JSON.stringify({ sessionId: "playwright-local" }),
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

const adminUser = process.env.POPCORN_ADMIN_USER ?? "admin";
const adminPass = process.env.POPCORN_ADMIN_PASS ?? "admin";
const session = await fetch("http://localhost:8080/admin/session", {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from(`${adminUser}:${adminPass}`).toString("base64"),
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ sessionId: "puppeteer-local" }),
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
