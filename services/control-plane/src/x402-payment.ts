import crypto from 'node:crypto';
import {
  HTTPFacilitatorClient,
  x402ResourceServer,
} from '@x402/core/server';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { generateJwt } from '@coinbase/cdp-sdk/auth';
import type { X402Config } from './config';

const USDC_BY_NETWORK = {
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
} as const;

export interface X402Offer {
  paymentRequired: PaymentRequired;
  requirements: PaymentRequirements;
  header: string;
}

export interface VerifiedX402Payment {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  payer?: string;
  payloadHash: string;
}

export class X402PaymentError extends Error {
  constructor(message: string, public readonly reason?: string) {
    super(message);
  }
}

export class X402PaymentGateway {
  private readonly resourceServer: x402ResourceServer;
  private initialization?: Promise<void>;

  constructor(private readonly config: X402Config) {
    const authHeaders = config.facilitatorAuthHeaders;
    const facilitator = config.facilitatorUrl.startsWith('https://api.cdp.coinbase.com/')
      ? createAuthenticatedCdpFacilitator({
        apiKeyId: config.cdpApiKeyId,
        apiKeySecret: config.cdpApiKeySecret,
        baseUrl: config.facilitatorUrl,
      })
      : new HTTPFacilitatorClient({
        url: config.facilitatorUrl,
        ...(authHeaders ? {
          createAuthHeaders: async () => ({
            verify: authHeaders,
            settle: authHeaders,
            supported: authHeaders,
          }),
        } : {}),
      });
    this.resourceServer = new x402ResourceServer(facilitator)
      .register(config.network, new ExactEvmScheme());
  }

  async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.resourceServer.initialize().catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    }
    await withDeadline(this.initialization, 30_000, 'Facilitator capability request timed out');
  }

  async createOffer(input: {
    blocks: number;
    resourceUrl: string;
    description: string;
  }): Promise<X402Offer> {
    await this.initialize();
    const amount = String(input.blocks * this.config.pricePerBlockAtomic);
    const [requirements] = await this.resourceServer.buildPaymentRequirements({
      scheme: 'exact',
      network: this.config.network,
      payTo: this.config.payTo!,
      price: {
        asset: USDC_BY_NETWORK[this.config.network],
        amount,
        extra: {
          name: this.config.network === 'eip155:8453' ? 'USD Coin' : 'USDC',
          version: '2',
        },
      },
      // Leave enough validity for a crash-safe reconciliation pass. The
      // worker runs every five seconds and checks chain state before retrying.
      maxTimeoutSeconds: 600,
    });
    if (!requirements) {
      throw new Error(`Facilitator does not support exact payments on ${this.config.network}`);
    }
    const paymentRequired = await this.resourceServer.createPaymentRequiredResponse(
      [requirements],
      {
        url: input.resourceUrl,
        description: input.description,
        mimeType: 'application/json',
        serviceName: 'Popcorn x402',
        tags: ['browser', 'x402', 'popcorn'],
      },
    );
    if (paymentRequired.x402Version !== 2) {
      throw new Error(`Facilitator selected unsupported x402 version ${paymentRequired.x402Version}`);
    }
    return {
      paymentRequired,
      requirements,
      header: encodePaymentRequiredHeader(paymentRequired),
    };
  }

  async verify(signature: string, offer: X402Offer): Promise<VerifiedX402Payment> {
    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(signature);
    } catch {
      throw new X402PaymentError('Invalid PAYMENT-SIGNATURE header', 'invalid_payment_payload');
    }
    if (payload.x402Version !== 2) {
      throw new X402PaymentError('Only x402 v2 payments are accepted', 'unsupported_x402_version');
    }
    const requirements = this.resourceServer.findMatchingRequirements(offer.paymentRequired.accepts, payload);
    if (!requirements) {
      throw new X402PaymentError('Payment does not match this request', 'payment_requirements_mismatch');
    }
    const extensionResult = this.resourceServer.validateExtensions(offer.paymentRequired, payload);
    if (!extensionResult.valid) {
      throw new X402PaymentError('Payment extensions do not match this request', extensionResult.invalidReason);
    }
    const result = await withDeadline(
      this.resourceServer.verifyPayment(payload, requirements, offer.paymentRequired.extensions),
      30_000,
      'Payment verification timed out',
    );
    if (!result.isValid) {
      throw new X402PaymentError(result.invalidMessage || 'Payment verification failed', result.invalidReason);
    }
    return {
      payload,
      requirements,
      payer: result.payer,
      // Hash the semantic payload, not the base64 header. Equivalent JSON key
      // order or padding must not bypass the durable authorization replay key.
      payloadHash: hashCanonicalPaymentPayload(payload),
    };
  }

  async settle(payment: VerifiedX402Payment, offer: X402Offer): Promise<SettleResponse> {
    return await this.settleRaw(payment.payload, payment.requirements, offer.paymentRequired.extensions);
  }

  async settleRaw(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    extensions?: Record<string, unknown>,
  ): Promise<SettleResponse> {
    return await withDeadline(
      this.resourceServer.settlePayment(
        payload,
        requirements,
        extensions,
      ),
      90_000,
      'Payment settlement timed out',
    );
  }

  settlementHeader(result: SettleResponse): string {
    return encodePaymentResponseHeader(result);
  }
}

function withDeadline<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

export function x402UsdcAddress(network: X402Config['network']): string {
  return USDC_BY_NETWORK[network];
}

export function createAuthenticatedCdpFacilitator(input: {
  apiKeyId?: string;
  apiKeySecret?: string;
  baseUrl: string;
}): HTTPFacilitatorClient {
  if (!input.apiKeyId || !input.apiKeySecret) throw new Error('Missing CDP API credentials');
  const parsed = new URL(input.baseUrl);
  const basePath = parsed.pathname.replace(/\/$/, '');
  const sign = async (method: string, path: string) => ({
    Authorization: `Bearer ${await generateJwt({
      apiKeyId: input.apiKeyId!,
      apiKeySecret: input.apiKeySecret!,
      requestMethod: method,
      requestHost: parsed.host,
      requestPath: path,
    })}`,
  });
  return new HTTPFacilitatorClient({
    url: input.baseUrl,
    createAuthHeaders: async () => ({
      supported: await sign('GET', `${basePath}/supported`),
      verify: await sign('POST', `${basePath}/verify`),
      settle: await sign('POST', `${basePath}/settle`),
    }),
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

export function hashCanonicalPaymentPayload(payload: PaymentPayload): string {
  const authorization = payload.payload?.authorization;
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
    throw new X402PaymentError('Payment is missing an EIP-3009 authorization', 'invalid_payment_authorization');
  }
  const from = (authorization as Record<string, unknown>).from;
  const nonce = (authorization as Record<string, unknown>).nonce;
  if (typeof from !== 'string' || typeof nonce !== 'string' || !from || !nonce) {
    throw new X402PaymentError('Payment authorization is missing from or nonce', 'invalid_payment_authorization');
  }
  // Only immutable signed authorization identity participates. Resource and
  // accepted metadata can be re-encoded or enriched and must not create a new
  // replay identity for the same EIP-3009 authorization.
  const identity = {
    network: payload.accepted.network,
    asset: payload.accepted.asset.toLowerCase(),
    from: from.toLowerCase(),
    nonce: nonce.toLowerCase(),
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize(identity)))
    .digest('hex');
}
