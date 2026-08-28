import { McpConfig } from './config';

/**
 * Billing boundary.
 *
 * This service performs the BROWSER effect, so it owns operation idempotency
 * and recovery. Whoever implements `BillingProvider` performs the PAYMENT
 * effect, so they own payment idempotency and reconciliation. The two are
 * deliberately NOT one distributed transaction: they meet at reservation
 * semantics keyed by a shared `operationId`, which makes retries safe on both
 * sides.
 *
 *   reserve -> perform browser operation -> commit
 *                                  \-> failure -> release
 *
 * Nothing here knows about money, currencies, checkout pages, price ids, cards
 * or pricing policy. A provider may hand back an opaque `nextAction` that the
 * caller should follow to obtain more credit; this service passes it through
 * untouched and never interprets it.
 */

export type UsageContext = {
  subject: string;
  /** Stable id of the operation being billed; identical across retries. */
  operationId: string;
  operation: 'create_session' | 'extend_session';
};

/** Opaque instruction from the provider, e.g. "approve this somewhere else". */
export type NextAction = {
  type: string;
  url?: string;
  [key: string]: unknown;
};

export type Reservation =
  | { ok: true; reservationId: string }
  | { ok: false; reason: 'insufficient_credit' | 'billing_unavailable'; nextAction?: NextAction };

export interface BillingProvider {
  readonly name: string;
  /** Remaining usage credits, or null when this provider does not meter. */
  getBalance(subject: string): Promise<number | null>;
  reserve(context: UsageContext): Promise<Reservation>;
  commit(reservationId: string): Promise<void>;
  release(reservationId: string): Promise<void>;
}

/**
 * Default for self-hosters: every authenticated request is allowed and nothing
 * is metered.
 */
export class NoBillingProvider implements BillingProvider {
  readonly name = 'none';

  async getBalance(_subject: string): Promise<number | null> {
    return null;
  }

  async reserve(context: UsageContext): Promise<Reservation> {
    return { ok: true, reservationId: `none:${context.operationId}` };
  }

  async commit(_reservationId: string): Promise<void> {}

  async release(_reservationId: string): Promise<void> {}
}

/**
 * Calls operator-configured internal HTTP endpoints. The operator's billing
 * service decides what a credit is worth and how it is bought; this client
 * only speaks credits, subjects and operation ids.
 *
 *   GET  {base}/v1/balance/:subject
 *   POST {base}/v1/reservations
 *   POST {base}/v1/reservations/:id/commit
 *   POST {base}/v1/reservations/:id/release
 */
export class ExternalBillingProvider implements BillingProvider {
  readonly name = 'external';

  constructor(
    private readonly baseUrl: string,
    private readonly authToken: string,
    private readonly timeoutMs = 5000,
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
          ...(init.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async getBalance(subject: string): Promise<number | null> {
    try {
      const response = await this.call(`/v1/balance/${encodeURIComponent(subject)}`);
      if (!response.ok) return null;
      const body = (await response.json()) as { balance?: unknown };
      return typeof body.balance === 'number' ? body.balance : null;
    } catch {
      return null;
    }
  }

  async reserve(context: UsageContext): Promise<Reservation> {
    let body: {
      allowed?: boolean;
      reservation_id?: string;
      reason?: string;
      next_action?: NextAction;
      approval_url?: string;
    };
    try {
      const response = await this.call('/v1/reservations', {
        method: 'POST',
        body: JSON.stringify({
          subject: context.subject,
          operation_id: context.operationId,
          operation: context.operation,
        }),
      });
      body = (await response.json().catch(() => ({}))) as typeof body;
      if (!response.ok && response.status >= 500) {
        return { ok: false, reason: 'billing_unavailable' };
      }
    } catch {
      // A billing outage must never silently hand out free browser time.
      return { ok: false, reason: 'billing_unavailable' };
    }

    if (body.allowed && body.reservation_id) {
      return { ok: true, reservationId: body.reservation_id };
    }
    const nextAction: NextAction | undefined = body.next_action
      ?? (body.approval_url ? { type: 'external_approval', url: body.approval_url } : undefined);
    return {
      ok: false,
      reason: body.reason === 'billing_unavailable' ? 'billing_unavailable' : 'insufficient_credit',
      ...(nextAction ? { nextAction } : {}),
    };
  }

  async commit(reservationId: string): Promise<void> {
    await this.call(`/v1/reservations/${encodeURIComponent(reservationId)}/commit`, { method: 'POST' });
  }

  async release(reservationId: string): Promise<void> {
    // Best effort: a lost release expires on the provider's side.
    await this.call(`/v1/reservations/${encodeURIComponent(reservationId)}/release`, { method: 'POST' })
      .catch(() => undefined);
  }
}

export function billingProviderFromConfig(): BillingProvider {
  if (McpConfig.billingProvider === 'external') {
    if (!McpConfig.billingBaseUrl) {
      throw new Error('MCP_BILLING_PROVIDER=external requires MCP_BILLING_BASE_URL');
    }
    return new ExternalBillingProvider(McpConfig.billingBaseUrl, McpConfig.billingAuthToken);
  }
  return new NoBillingProvider();
}
