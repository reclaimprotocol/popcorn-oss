import { Fetch, evm } from 'mppx/client';
import { privateKeyToAccount } from 'viem/accounts';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const baseUrl = required('POPCORN_X402_BASE_URL').replace(/\/$/, '');
const network = required('X402_NETWORK');
const chainId = Number(network.replace(/^eip155:/, ''));
if (!Number.isSafeInteger(chainId)) throw new Error('X402_NETWORK must be an eip155 chain');

const asset = required('X402_ASSET_ADDRESS') as `0x${string}`;
const payTo = required('X402_PAY_TO').toLowerCase();
const pricePerBlockAtomic = required('X402_PRICE_PER_BLOCK_ATOMIC');
const account = privateKeyToAccount(required('PAYER_PRIVATE_KEY') as `0x${string}`);

const paidFetch = Fetch.from({
  methods: [
    evm.charge({
      account,
      authorization: {
        name: required('X402_ASSET_NAME'),
        version: required('X402_ASSET_VERSION'),
      },
      currencies: [asset],
      decimals: Number(process.env.X402_ASSET_DECIMALS || '6'),
      maxAtomicAmount: pricePerBlockAtomic,
      networks: [chainId],
    }),
  ],
  onChallenge: async (challenge, { createCredential }) => {
    const request = challenge.request as Record<string, unknown>;
    if (request.network !== network
      || String(request.asset).toLowerCase() !== asset.toLowerCase()
      || String(request.payTo).toLowerCase() !== payTo
      || request.amount !== pricePerBlockAtomic) {
      throw new Error('Popcorn returned payment terms that do not match the trusted configuration');
    }
    return await createCredential();
  },
});

const response = await paidFetch(`${baseUrl}/v1/x402/sessions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': `mpp-smoke-${crypto.randomUUID()}`,
  },
  body: '{}',
});
const body = await response.json() as Record<string, unknown>;
if (!response.ok) {
  throw new Error(`MPP paid request failed with ${response.status}: ${JSON.stringify(body)}`);
}
if (!response.headers.has('PAYMENT-RESPONSE')) {
  throw new Error('Paid response is missing PAYMENT-RESPONSE');
}
if (typeof body.sessionId !== 'string' || typeof body.sessionUrl !== 'string') {
  throw new Error('Paid response did not return session capabilities');
}

console.log(JSON.stringify({
  ok: true,
  protocol: 'mpp-via-x402',
  network,
  payer: account.address,
  sessionId: body.sessionId,
  sessionUrl: body.sessionUrl,
  expiresAt: body.expiresAt,
}, null, 2));
