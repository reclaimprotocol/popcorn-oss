import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import type { PaymentRequired } from '@x402/core/types';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const baseUrl = (process.env.X402_SMOKE_BASE_URL || 'http://127.0.0.1:4021').replace(/\/$/, '');
const serviceToken = process.env.X402_SMOKE_SERVICE_TOKEN;
const blockSeconds = Number(process.env.X402_BLOCK_SECONDS || '300');
const pricePerBlockAtomic = Number(process.env.X402_PRICE_PER_BLOCK_ATOMIC || '10000');
const network = process.env.X402_NETWORK || 'eip155:84532';
const paymentAssetName = process.env.X402_PAYMENT_ASSET_NAME || 'USDC';
const account = privateKeyToAccount(generatePrivateKey());
const paymentClient = new x402Client();
registerExactEvmScheme(paymentClient, { signer: account });
const httpClient = new x402HTTPClient(paymentClient);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function jsonBody(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${response.url || 'x402 API'}, got: ${text.slice(0, 200)}`);
  }
}

async function paidRequest(input: {
  path: string;
  idempotencyKey: string;
  body: Record<string, unknown>;
  expectedAmount: string;
}): Promise<{ body: any; paymentRequired: PaymentRequired; paymentSignature: string }> {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Idempotency-Key': input.idempotencyKey,
  });
  const challenge = await fetch(`${baseUrl}${input.path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input.body),
  });
  const challengeBody = await jsonBody(challenge.clone());
  assert(challenge.status === 402, `Expected 402 challenge, received ${challenge.status}: ${JSON.stringify(challengeBody)}`);
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => challenge.headers.get(name),
    challengeBody,
  );
  assert(paymentRequired.x402Version === 2, 'Expected x402 v2 challenge');
  assert(paymentRequired.accepts.length === 1, 'Expected exactly one payment option');
  assert(paymentRequired.accepts[0]?.amount === input.expectedAmount,
    `Expected ${input.expectedAmount} atomic ${paymentAssetName}, got ${paymentRequired.accepts[0]?.amount}`);
  assert(paymentRequired.accepts[0]?.network === network, `Expected ${network} challenge`);

  const payload = await httpClient.createPaymentPayload(paymentRequired);
  const paidHeaders = new Headers(headers);
  for (const [name, value] of Object.entries(httpClient.encodePaymentSignatureHeader(payload))) {
    paidHeaders.set(name, value);
  }
  const paymentSignature = paidHeaders.get('PAYMENT-SIGNATURE');
  assert(paymentSignature, 'Payment client did not produce PAYMENT-SIGNATURE');
  const paid = await fetch(`${baseUrl}${input.path}`, {
    method: 'POST',
    headers: paidHeaders,
    body: JSON.stringify(input.body),
  });
  const body = await jsonBody(paid.clone());
  assert(paid.status === 200, `Paid request failed with ${paid.status}: ${JSON.stringify(body)}`);
  assert(paid.headers.has('PAYMENT-RESPONSE'), 'Paid response is missing PAYMENT-RESPONSE');
  return { body, paymentRequired, paymentSignature };
}

const createKey = `smoke-create-${crypto.randomUUID()}`;
const created = await paidRequest({
  path: '/v1/x402/sessions',
  idempotencyKey: createKey,
  body: {},
  expectedAmount: String(pricePerBlockAtomic),
});
assert(created.body.paidSeconds === blockSeconds, 'Create did not purchase one configured time block');
assert(typeof created.body.sessionId === 'string' && /^x402s_[A-Za-z0-9_-]{43}$/.test(created.body.sessionId),
  'Create did not return an opaque session capability');
assert(created.body.sessionUrl === `${baseUrl}/v1/x402/sessions/${created.body.sessionId}`,
  'Create did not return the canonical anonymous session URL');
assert(typeof created.body.connectUrl === 'string' && typeof created.body.liveViewUrl === 'string',
  'Create did not return both public connection URLs');
assert(typeof created.body.vncUrl === 'string' && typeof created.body.vncWsUrl === 'string',
  'Create did not return both LiveView compatibility URLs');
const createdExpiry = Date.parse(created.body.expiresAt);

const unauthenticatedReplay = await fetch(`${baseUrl}/v1/x402/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': createKey },
  body: '{}',
});
assert(unauthenticatedReplay.status === 409,
  'A bare idempotency key was able to replay a settled session capability');

const replay = await fetch(`${baseUrl}/v1/x402/sessions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': createKey,
    'PAYMENT-SIGNATURE': created.paymentSignature,
  },
  body: '{}',
});
const replayBody = await jsonBody(replay.clone());
assert(replay.status === 200 && replayBody.sessionId === created.body.sessionId,
  'Settled create idempotency replay did not return the original session');
assert(!replay.headers.has('PAYMENT-REQUIRED'), 'Settled replay unexpectedly requested payment again');

const extended = await paidRequest({
  path: `/v1/x402/sessions/${encodeURIComponent(created.body.sessionId)}/extend`,
  idempotencyKey: `smoke-extend-${crypto.randomUUID()}`,
  body: { blocks: 2 },
  expectedAmount: String(pricePerBlockAtomic * 2),
});
const extendedExpiry = Date.parse(extended.body.expiresAt);
assert(extended.body.additionalSeconds === blockSeconds * 2
  && extended.body.paidSecondsTotal === blockSeconds * 3,
  'Extension did not add two configured time blocks');
assert(extendedExpiry - createdExpiry === blockSeconds * 2 * 1000,
  'Extension deadline did not advance by two configured time blocks');
assert(extended.body.liveViewUrl === created.body.liveViewUrl && extended.body.connectUrl === created.body.connectUrl,
  'Extension replaced the stable connection URLs');
assert(extended.body.vncUrl === created.body.vncUrl && extended.body.vncWsUrl === created.body.vncWsUrl,
  'Extension replaced the stable LiveView compatibility URLs');

const status = await fetch(`${baseUrl}/v1/x402/sessions/${encodeURIComponent(created.body.sessionId)}`);
const statusBody = await jsonBody(status.clone());
assert(status.status === 200 && statusBody.paidSeconds === blockSeconds * 3,
  'Status did not show the paid extension');
assert(statusBody.expiresAt === extended.body.expiresAt, 'Status did not show the extended deadline');
assert(statusBody.liveViewUrl === extended.body.liveViewUrl && statusBody.connectUrl === extended.body.connectUrl,
  'Status did not preserve the original connection URLs');
assert(statusBody.vncUrl === extended.body.vncUrl && statusBody.vncWsUrl === extended.body.vncWsUrl,
  'Status did not preserve the original LiveView compatibility URLs');

let staleExpiryRejected = false;
if (serviceToken) {
  const staleExpiry = await fetch(`${baseUrl}/sessions/${encodeURIComponent(created.body.sessionId)}/end`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'expired', gameServerName: 'stale-browser-generation' }),
  });
  const staleExpiryBody = await jsonBody(staleExpiry.clone());
  assert(staleExpiry.status === 200 && staleExpiryBody.changed === false && staleExpiryBody.staleWorkload === true,
    'A stale GameServer callback was not rejected atomically');
  const afterStaleExpiry = await fetch(`${baseUrl}/v1/x402/sessions/${encodeURIComponent(created.body.sessionId)}`);
  const afterStaleExpiryBody = await jsonBody(afterStaleExpiry.clone());
  assert(afterStaleExpiry.status === 200 && afterStaleExpiryBody.status === 'active',
    'A stale GameServer callback ended the current paid workload');
  staleExpiryRejected = true;
}

const terminated = await fetch(`${baseUrl}/v1/x402/sessions/${encodeURIComponent(created.body.sessionId)}`, {
  method: 'DELETE',
});
const terminatedBody = await jsonBody(terminated.clone());
assert(terminated.status === 200 && terminatedBody.success === true && terminatedBody.refund === false,
  'Session termination failed or incorrectly offered a refund');

console.log(JSON.stringify({
  ok: true,
  network,
  payer: account.address,
  sessionId: created.body.sessionId,
  createAmountAtomic: created.paymentRequired.accepts[0]?.amount,
  extensionAmountAtomic: extended.paymentRequired.accepts[0]?.amount,
  initialPaidSeconds: created.body.paidSeconds,
  finalPaidSeconds: extended.body.paidSecondsTotal,
  stableLiveViewUrl: extended.body.liveViewUrl === created.body.liveViewUrl,
  stableConnectUrl: extended.body.connectUrl === created.body.connectUrl,
  staleExpiryRejected,
  idempotencyReplay: true,
  terminated: true,
}, null, 2));
