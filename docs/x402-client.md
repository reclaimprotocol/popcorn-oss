# Use the x402 client

The x402 API creates a paid browser session without a Popcorn client account.
The caller pays from its own EVM wallet, receives capability URLs, and can use
the browser through LiveView or Chrome DevTools Protocol (CDP).

This page covers the client side. Operators should start with
[x402 deployment and operations](x402.md).

## What the client needs

- the Popcorn x402 API base URL;
- an EVM private key held in the client's wallet or custody boundary;
- the configured payment token and any gas required by its network;
- independently trusted values for the network, token contract, payee, token
  name/version, and price per time block;
- Node.js 20 or Bun.

Never accept payment terms merely because they arrived in a `402` response.
Compare every term with configuration obtained through a separate trusted
channel before asking the wallet to sign.

## Install the client libraries

The example matches the library versions used by this release:

```bash
npm install @x402/core@2.20.0 @x402/evm@2.20.0 viem@2.55.10
```

Set the expected contract and wallet values outside source control:

```bash
export POPCORN_X402_BASE_URL=https://x402-api.example.com
export PAYER_PRIVATE_KEY=0x...
export X402_NETWORK=eip155:84532
export X402_ASSET_ADDRESS=0x...
export X402_ASSET_NAME=USDC
export X402_ASSET_VERSION=2
export X402_PAY_TO=0x...
export X402_PRICE_PER_BLOCK_ATOMIC=10000
```

Use a secret manager or wallet signer in production. An environment variable is
shown only to keep the example small.

## Create a paid request helper

The server first returns `402 Payment Required` with a `PAYMENT-REQUIRED`
header. The helper validates the offer, creates an exact EVM payment payload,
and repeats the same request with `PAYMENT-SIGNATURE`.

```ts
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { privateKeyToAccount } from 'viem/accounts';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const baseUrl = required('POPCORN_X402_BASE_URL').replace(/\/$/, '');
const account = privateKeyToAccount(
  required('PAYER_PRIVATE_KEY') as `0x${string}`,
);
const expected = {
  network: required('X402_NETWORK'),
  asset: required('X402_ASSET_ADDRESS').toLowerCase(),
  assetName: required('X402_ASSET_NAME'),
  assetVersion: required('X402_ASSET_VERSION'),
  payTo: required('X402_PAY_TO').toLowerCase(),
  pricePerBlockAtomic: BigInt(required('X402_PRICE_PER_BLOCK_ATOMIC')),
};

const paymentClient = new x402Client();
registerExactEvmScheme(paymentClient, { signer: account });
const httpClient = new x402HTTPClient(paymentClient);

async function json(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON, received: ${text.slice(0, 200)}`);
  }
}

function selectOffer(
  paymentRequired: PaymentRequired,
  requestUrl: string,
  amount: bigint,
): PaymentRequirements {
  if (paymentRequired.x402Version !== 2) {
    throw new Error(`Unsupported x402 version: ${paymentRequired.x402Version}`);
  }
  if (new URL(paymentRequired.resource.url).toString() !== new URL(requestUrl).toString()) {
    throw new Error('Payment resource does not match the requested URL');
  }

  const matches = paymentRequired.accepts.filter((offer) =>
    offer.scheme === 'exact'
    && offer.network === expected.network
    && offer.asset.toLowerCase() === expected.asset
    && offer.payTo.toLowerCase() === expected.payTo
    && offer.amount === amount.toString()
    && offer.extra?.name === expected.assetName
    && offer.extra?.version === expected.assetVersion
  );
  if (matches.length !== 1) {
    throw new Error('The server did not return exactly one trusted payment offer');
  }
  return matches[0]!;
}

async function paidPost<T>(
  path: string,
  body: Record<string, unknown>,
  amount: bigint,
): Promise<T> {
  const requestUrl = `${baseUrl}${path}`;
  const bodyText = JSON.stringify(body);
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID(),
  });

  const challenge = await fetch(requestUrl, {
    method: 'POST',
    headers,
    body: bodyText,
  });
  const challengeBody = await json(challenge.clone());
  if (challenge.status !== 402) {
    throw new Error(`Expected payment challenge, got ${challenge.status}: ${JSON.stringify(challengeBody)}`);
  }

  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => challenge.headers.get(name),
    challengeBody,
  );
  const offer = selectOffer(paymentRequired, requestUrl, amount);
  const payload = await httpClient.createPaymentPayload({
    ...paymentRequired,
    accepts: [offer],
  });
  const paidHeaders = new Headers(headers);
  for (const [name, value] of Object.entries(
    httpClient.encodePaymentSignatureHeader(payload),
  )) {
    paidHeaders.set(name, value);
  }

  // Reuse this idempotency key, body, and signature after an ambiguous result.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: paidHeaders,
      body: bodyText,
    });
    const responseBody = await json(response.clone());
    if (response.status === 200) {
      if (!response.headers.has('PAYMENT-RESPONSE')) {
        throw new Error('Paid response is missing PAYMENT-RESPONSE');
      }
      return responseBody as T;
    }

    const retryAfter = Number(response.headers.get('Retry-After') || 0);
    if ((response.status === 409 || response.status === 503)
      && retryAfter > 0 && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }
    throw new Error(`Paid request failed with ${response.status}: ${JSON.stringify(responseBody)}`);
  }
  throw new Error('Paid request did not complete after retries');
}
```

If a retry is necessary, do not generate a new payment payload. The helper
reuses the original `Idempotency-Key`, body, and signature so the server can
return or reconcile the original result without charging for a second action.

## Create a browser session

Create always buys one configured time block and accepts an empty JSON object:

```ts
type SessionCapabilities = {
  sessionId: string;
  sessionUrl: string;
  connectUrl: string;
  liveViewUrl: string;
  vncUrl: string;
  vncWsUrl: string;
  expiresAt: string;
};

type CreatedSession = SessionCapabilities & {
  paidSeconds: number;
  region: string;
  clusterName: string;
};

type ExtendedSession = SessionCapabilities & {
  additionalSeconds: number;
  paidSecondsTotal: number;
};

const session = await paidPost<CreatedSession>(
  '/v1/x402/sessions',
  {},
  expected.pricePerBlockAtomic,
);

console.log({ expiresAt: session.expiresAt, region: session.region });
```

`sessionId`, `sessionUrl`, and every connection URL are bearer capabilities.
Do not put them in analytics, screenshots, issue reports, or normal application
logs.

## Use LiveView or CDP

Open `session.vncUrl` in a browser to use the graphical LiveView. Clients that
need automation can connect Playwright to the automation-scoped CDP endpoint:

```bash
npm install playwright
```

```ts
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP(session.connectUrl);
const context = browser.contexts()[0] ?? await browser.newContext();
const page = context.pages()[0] ?? await context.newPage();
await page.goto('https://example.com');
console.log(await page.title());
await browser.close();
```

`connectUrl` grants full automation control of that browser session. Give it
only to the process that owns the paid session.

## Read, extend, and terminate

Status and termination use possession of the session capability; they do not
require another payment signature:

```ts
const sessionPath = `/v1/x402/sessions/${encodeURIComponent(session.sessionId)}`;

const statusResponse = await fetch(`${baseUrl}${sessionPath}`);
if (!statusResponse.ok) throw new Error(`Status failed: ${statusResponse.status}`);
const status = await statusResponse.json();

const blocks = 2;
const extended = await paidPost<ExtendedSession>(
  `${sessionPath}/extend`,
  { blocks },
  expected.pricePerBlockAtomic * BigInt(blocks),
);

const terminateResponse = await fetch(`${baseUrl}${sessionPath}`, {
  method: 'DELETE',
});
if (!terminateResponse.ok) {
  throw new Error(`Termination failed: ${terminateResponse.status}`);
}
```

Extension keeps the existing connection URLs and adds whole time blocks. Start
it while at least four minutes remain; an extension presented later is rejected
before settlement. Early termination stops the browser but does not refund
unused time.

## Client failure rules

- Treat `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, and session capabilities as
  secrets.
- Use a new idempotency key for every new create or extension action.
- Reuse the original key, body, and signature only when retrying that action.
- Honor `Retry-After`; a `503` with `PAYMENT-RESPONSE` can mean payment settled
  while durable reconciliation is finishing.
- Do not pay a second challenge after an ambiguous settlement.
- Apply request timeouts longer than payment verification and settlement, and
  allow the idempotent retry path to recover the result.
- Terminate a session whose capability might have leaked.

The repository's
[`x402-smoke-client.ts`](../services/control-plane/scripts/x402-smoke-client.ts)
exercises challenge validation, payment, replay, extension, status, and
termination against a deployment.
