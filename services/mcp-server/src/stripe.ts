import crypto from 'crypto';
import { McpConfig, requireStripe } from './config';

/**
 * Thin Stripe Checkout client. The MCP tool surface never touches card data:
 * `top_up` returns a hosted Checkout URL, the human pays, and the webhook
 * credits the OAuth subject recorded in Checkout metadata.
 */

export type CheckoutSession = { id: string; url: string };

export async function createCheckoutSession(params: {
  subject: string;
  topUpId: string;
  amountUsdCents: number;
}): Promise<CheckoutSession> {
  requireStripe();
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(params.amountUsdCents),
    'line_items[0][price_data][product_data][name]': 'Popcorn credit',
    'line_items[0][price_data][product_data][description]':
      'Prepaid credit for Popcorn browser sessions. Closed-loop: non-transferable and non-refundable to cash.',
    'metadata[popcorn_subject]': params.subject,
    'metadata[popcorn_top_up_id]': params.topUpId,
    client_reference_id: params.topUpId,
  });
  if (McpConfig.topUpSuccessUrl) form.set('success_url', McpConfig.topUpSuccessUrl);
  if (McpConfig.topUpCancelUrl) form.set('cancel_url', McpConfig.topUpCancelUrl);

  const response = await fetch(`${McpConfig.stripeApiBase}/v1/checkout/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${McpConfig.stripeSecretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': params.topUpId,
    },
    body: form,
  });
  const body = (await response.json()) as any;
  if (!response.ok) {
    throw new Error(`stripe checkout failed: ${body?.error?.message ?? response.status}`);
  }
  return { id: body.id as string, url: body.url as string };
}

/** Verify a Stripe-Signature header (t=,v1= scheme) without the SDK. */
export function verifyWebhookSignature(
  payload: string,
  header: string,
  secret: string,
  toleranceSeconds = 300,
  now = Date.now(),
): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(',').map((part) => {
      const index = part.indexOf('=');
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }),
  ) as Record<string, string>;
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${payload}`).digest('hex');
  const provided = parts.v1 ?? '';
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}
